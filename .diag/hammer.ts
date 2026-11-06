import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { startBayeuxDouble, type DoubleScript } from '../packages/core/test/support/cometdDouble.ts';

const root = path.resolve(__dirname, '..');
const coreDir = path.join(root, 'packages/core');
const childTs = path.join(coreDir, 'test/support/cometdAbortChild.ts');
const childCjs = path.join(coreDir, 'test/support/.cometdAbortChild.plain.cjs');
const noopTs = path.join(root, '.diag/noop.ts');
const shiftClock = pathToFileURL(path.join(root, 'scripts/shift-clock.mjs')).href;

const outDir = process.env.DIAG_OUT ?? path.join(os.tmpdir(), 'alv-diag');
const shard = process.env.DIAG_SHARD ?? 'local';
const minutes = Number(process.env.DIAG_MINUTES ?? '1');
const concurrency = Number(process.env.DIAG_CONCURRENCY ?? '3');
const burners = Number(process.env.DIAG_BURNERS ?? '0');
const cdb = process.env.DIAG_CDB;
const only = process.env.DIAG_VARIANTS?.split(',');
fs.mkdirSync(path.join(outDir, 'dumps'), { recursive: true });
const results = fs.createWriteStream(path.join(outDir, `results-${shard}.jsonl`), { flags: 'a' });

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-sf-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SF_USE_GENERIC_UNIX_KEYCHAIN = 'true';
process.env.SF_DISABLE_LOG_FILE = 'true';
process.env.SF_DISABLE_DNS_CHECK = 'true';
process.env.SFDX_IGNORE_API_VERSION_CACHE = 'true';
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;

type Scenario = 'start' | 'down' | 'offline';
type Variant = { args: (username: string, channel: string, scenario: Scenario) => string[]; env?: () => Record<string, string | undefined>; noServer?: boolean };
const childArgs = (file: string, pre: string[]) => (u: string, c: string, s: Scenario) => [...pre, file, u, c, s];
const variants: Record<string, Variant> = {
  tsx: { args: childArgs(childTs, ['--import', 'tsx']) },
  'tsx-nocache': { args: childArgs(childTs, ['--import', 'tsx']), env: () => ({ TSX_DISABLE_CACHE: '1' }) },
  'tsx-cold': {
    args: childArgs(childTs, ['--import', 'tsx']),
    env: () => {
      const dir = fs.mkdtempSync(path.join(outDir, 'tmp-'));
      return { TEMP: dir, TMP: dir, TMPDIR: dir };
    }
  },
  'tsx-shifted': {
    args: childArgs(childTs, ['--import', 'tsx']),
    env: () => ({ ALV_TEST_CLOCK_SHIFT_DAYS: '45', NODE_OPTIONS: `--import ${shiftClock}` })
  },
  plain: { args: childArgs(childCjs, []) },
  'plain-logfile': { args: childArgs(childCjs, []), env: () => ({ SF_DISABLE_LOG_FILE: undefined }) },
  'noop-tsx': { args: () => ['--import', 'tsx', noopTs], noServer: true },
  'noop-tsx-nocache': { args: () => ['--import', 'tsx', noopTs], env: () => ({ TSX_DISABLE_CACHE: '1' }), noServer: true }
};
const variantNames = Object.keys(variants).filter(name => !only || only.includes(name));
const scripts: Record<Scenario, DoubleScript> = {
  start: { handshake: { delayMs: 400 } },
  down: { connects: [{ dropConnection: true }] },
  offline: { connects: [{ dropConnection: true }] }
};
const scenarios: Scenario[] = ['down', 'down', 'down', 'down', 'start', 'start', 'offline'];

type Row = { runs: number; crashes: number; crashAfterDrain: number; crashBeforeDrain: number; other: number };
const table = new Map<string, Row>();
const rowOf = (key: string): Row => {
  let row = table.get(key);
  if (!row) table.set(key, (row = { runs: 0, crashes: 0, crashAfterDrain: 0, crashBeforeDrain: 0, other: 0 }));
  return row;
};
const fakeTest = { after: () => undefined } as never;

async function once(name: string, scenario: Scenario): Promise<void> {
  const variant = variants[name]!;
  const double = variant.noServer ? undefined : await startBayeuxDouble(fakeTest, scripts[scenario]);
  const nodeArgs = variant.args(double?.username ?? '', '/event/ALV_Test_Log__e', scenario);
  const dumpBase = path.join(outDir, 'dumps', 'cdb');
  const [cmd, args] = cdb
    ? [cdb, ['-G', '-lines', '-c', `sxd av; sxd eh; sxd *; g; .echo DIAG_STOPPED; .exr -1; .dump /ma /u ${dumpBase.replaceAll('\\', '\\\\')}.dmp; ~*kn 40; q`, process.execPath, ...nodeArgs]]
    : [process.execPath, nodeArgs];
  const extraEnv = variant.env?.() ?? {};
  const env = { ...process.env, ...extraEnv };
  for (const [key, value] of Object.entries(extraEnv)) if (value === undefined) delete env[key];
  const started = Date.now();
  const child = spawn(cmd as string, args as string[], { cwd: coreDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    if (/^down\r?$/m.test(text)) void double?.close();
  });
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const killer = setTimeout(() => child.kill('SIGKILL'), cdb ? 120_000 : 30_000);
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  clearTimeout(killer);
  await double?.close();
  if (typeof extraEnv.TEMP === 'string') fs.rmSync(extraEnv.TEMP, { recursive: true, force: true });

  const stopped = stdout.includes('DIAG_STOPPED');
  const crashed = cdb ? stopped : code === 3221226505;
  const drained = /^drained /m.test(stdout);
  const key = `${name}/${scenario}`;
  const row = rowOf(key);
  row.runs += 1;
  if (crashed) {
    row.crashes += 1;
    if (drained) row.crashAfterDrain += 1;
    else row.crashBeforeDrain += 1;
  } else if (code !== 0) row.other += 1;
  const interesting = crashed || code !== 0;
  results.write(
    `${JSON.stringify({ at: new Date().toISOString(), name, scenario, code, crashed, drained, ms: Date.now() - started, ...(interesting ? { stdout: stdout.slice(-6000), stderr: stderr.slice(-6000) } : {}) })}\n`
  );
  if (crashed) console.log(`CRASH ${key} code=${code} drained=${drained}\n--- stdout\n${stdout.slice(-3000)}\n--- stderr\n${stderr.slice(-3000)}`);
  else if (code !== 0) console.log(`OTHER ${key} code=${code} drained=${drained} stderr=${stderr.slice(-500)}`);
}

function printSummary(): void {
  const lines = [...table.entries()].sort(([a], [b]) => a.localeCompare(b));
  console.log('variant/scenario'.padEnd(30), 'runs', 'crash', 'afterDrain', 'beforeDrain', 'other');
  for (const [key, row] of lines) {
    console.log(key.padEnd(30), row.runs, row.crashes, row.crashAfterDrain, row.crashBeforeDrain, row.other);
  }
}

async function main(): Promise<void> {
  const deadline = Date.now() + minutes * 60_000;
  const burn = Array.from({ length: burners }, () =>
    spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' })
  );
  let index = 0;
  const report = setInterval(printSummary, 5 * 60_000);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < deadline) {
        const i = index++;
        const name = variantNames[i % variantNames.length]!;
        const scenario = variants[name]!.noServer ? 'start' : scenarios[Math.floor(i / variantNames.length) % scenarios.length]!;
        try {
          await once(name, scenario);
        } catch (error) {
          console.log(`HARNESS ${name}/${scenario}`, error);
        }
      }
    })
  );
  clearInterval(report);
  burn.forEach(child => child.kill('SIGKILL'));
  printSummary();
  results.end();
  await new Promise(resolve => results.on('finish', resolve));
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
}

void main();
