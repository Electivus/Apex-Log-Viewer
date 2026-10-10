#!/usr/bin/env node
// Client for the verification session host (session.ts). Run from anywhere in the checkout:
//   node .claude/skills/verify/scripts/verify.mjs <doctor|start|run|shot|sf|stop> [...]
// See .claude/skills/verify/SKILL.md for the workflow.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(skillDir, '..', '..', '..');
const outRoot = path.join(repoRoot, 'output', 'verify');
const sessionDir = path.join(outRoot, 'session');
const statePath = path.join(sessionDir, 'session.json');
const evidenceRoot = path.join(outRoot, 'evidence');
const bundlePath = path.join(outRoot, '.build', 'session.cjs');
const repoRequire = createRequire(path.join(repoRoot, 'package.json'));
const BUILD_ARTIFACTS = [
  'apps/vscode-extension/dist/extension.js',
  'apps/vscode-extension/media/main.js',
  'apps/vscode-extension/media/tail.js',
  'apps/vscode-extension/media/logViewer.js',
  'apps/vscode-extension/media/debugFlags.js'
];

function fail(message) {
  console.error(`verify: ${message}`);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) {
        flags[key] = inline;
      } else if (['target-org', 'idle-minutes'].includes(key)) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function socketPathFor(dir) {
  const preferred = path.join(dir, 'host.sock');
  // Unix socket paths are limited to ~104 bytes; fall back to a per-checkout temp path.
  return preferred.length <= 100
    ? preferred
    : path.join(tmpdir(), `alv-verify-${createHash('sha1').update(repoRoot).digest('hex').slice(0, 10)}.sock`);
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The live command line of pid ('' when it is gone or cannot be read); `ps` works on Linux and macOS. */
function commandOf(pid) {
  if (!pidAlive(pid)) return '';
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** True only when pid is a session host started from this checkout's bundle, so a recycled pid is never signalled. */
function isOurHost(pid) {
  return commandOf(pid).includes(bundlePath);
}

function request(method, route, body, timeoutMs = 0) {
  const state = readState();
  if (!state) {
    return Promise.reject(new Error('No session is running. Start one with: verify.mjs start'));
  }
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: state.socketPath,
        path: route,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
      },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
          } catch {
            resolve({ status: res.statusCode, body: { raw: data } });
          }
        });
      }
    );
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    }
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function buildMtimes() {
  const result = {};
  for (const file of BUILD_ARTIFACTS) {
    try {
      result[file] = statSync(path.join(repoRoot, file)).mtime.toISOString();
    } catch {
      result[file] = 'missing';
    }
  }
  return result;
}

function stamp({ milliseconds = false } = {}) {
  const iso = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
  return milliseconds ? iso : iso.replace(/\..*$/, '');
}

function printTail(file, lines = 40) {
  try {
    const text = readFileSync(file, 'utf8').trimEnd().split('\n');
    console.error(text.slice(-lines).join('\n'));
  } catch {}
}

// ---------------------------------------------------------------- doctor

function preflightChecks() {
  const checks = [];
  const add = (ok, label, detail = '') => checks.push({ ok, label, detail });

  const required = readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim();
  const [reqMajor, reqMinor] = required.split('.').map(Number);
  const [major, minor] = process.versions.node.split('.').map(Number);
  add(major === reqMajor && minor >= reqMinor, `Node ${process.versions.node}`, `.nvmrc wants ${required}`);

  const sf = spawnSync('sf', ['--version'], { encoding: 'utf8' });
  add(sf.status === 0, 'Salesforce CLI on PATH', sf.status === 0 ? sf.stdout.trim().split('\n')[0] : 'install sf');

  if (process.platform === 'linux' && !process.env.DISPLAY) {
    const xvfb = spawnSync('bash', ['-lc', 'command -v xvfb-run'], { encoding: 'utf8' });
    add(xvfb.status === 0, 'xvfb-run available (no DISPLAY)', xvfb.stdout.trim());
  }

  add(
    existsSync(path.join(repoRoot, 'node_modules', '@playwright', 'test')),
    'Dependencies installed',
    'pnpm install --frozen-lockfile'
  );

  const missing = BUILD_ARTIFACTS.filter(file => !existsSync(path.join(repoRoot, file)));
  add(
    missing.length === 0,
    'Build artifacts present',
    missing.length ? `missing ${missing.join(', ')} (start builds them)` : ''
  );

  try {
    const { resolveDevHubConfig } = repoRequire('./scripts/devhub-auth.js');
    const config = resolveDevHubConfig(process.env, { allowLocalAlias: true });
    const strategy =
      String(process.env.SF_SCRATCH_STRATEGY || '').trim() || (process.env.SF_SCRATCH_POOL_NAME ? 'pool' : 'single');
    const poolOk = strategy !== 'pool' || Boolean(String(process.env.SF_SCRATCH_POOL_NAME || '').trim());
    add(
      poolOk,
      `Dev Hub configured (${config.mode === 'alias' ? `alias ${config.alias}` : 'JWT'}, strategy ${strategy})`,
      strategy === 'pool' ? `pool ${process.env.SF_SCRATCH_POOL_NAME || 'MISSING SF_SCRATCH_POOL_NAME'}` : ''
    );
  } catch (error) {
    add(false, 'Dev Hub configured', `${error.message} (or pass start --target-org <alias>)`);
  }
  return checks;
}

async function sessionChecks(state) {
  const checks = [];
  const add = (ok, label, detail = '') => checks.push({ ok, label, detail });

  add(state.phase === 'ready', `Session phase: ${state.phase}`, state.error ? state.error.split('\n')[0] : '');
  add(isOurHost(state.hostPid), `Host process ${state.hostPid} alive and started by this checkout`);

  try {
    const { body } = await request('GET', '/status', undefined, 15_000);
    add(
      Boolean(body.vscodeAlive && body.workbenchVisible),
      'VS Code window alive with workbench rendered',
      `pid ${state.vscodePid}, ${body.webviewFrames} webview frame(s)`
    );
    add(
      Boolean(body.leaseHealthy),
      'Org lease healthy',
      body.leaseError || `${state.org?.strategy}${state.org?.slotKey ? ` ${state.org.slotKey}` : ''}`
    );
    add(
      true,
      'Host answering',
      `${body.running ? `running ${body.running}; ` : ''}auto-stop after ${body.idleMinutesLeft} idle min`
    );
  } catch (error) {
    add(false, 'Host answering on its socket', error.message);
  }

  const now = buildMtimes();
  const changed = Object.keys(now).filter(file => state.build?.[file] !== now[file]);
  add(
    changed.length === 0,
    'Running build matches files on disk',
    changed.length ? `rebuilt since start: ${changed.join(', ')} → stop and start again` : ''
  );
  const hostSource = path.join(skillDir, 'scripts', 'session.ts');
  add(
    statSync(hostSource).mtimeMs < Date.parse(state.startedAt),
    'Host helpers match session.ts',
    statSync(hostSource).mtimeMs < Date.parse(state.startedAt)
      ? ''
      : 'session.ts changed since start → stop and start again'
  );

  if (state.org?.alias) {
    const display = spawnSync('sf', ['org', 'display', '--target-org', state.org.alias, '--json'], {
      encoding: 'utf8'
    });
    let detail = `exit ${display.status}`;
    try {
      const result = JSON.parse(display.stdout).result || {};
      detail = `${state.org.alias} → ${result.username} (${result.connectedStatus || result.status || 'unknown'})`;
    } catch {}
    add(display.status === 0, 'Org auth valid in the Salesforce CLI', detail);
  }
  return checks;
}

function printChecks(title, checks) {
  console.log(title);
  for (const check of checks) {
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  return checks.every(check => check.ok);
}

async function doctor() {
  const preflightOk = printChecks('Preflight', preflightChecks());
  const state = readState();
  if (!state) {
    console.log('Session: none running (start one with verify.mjs start)');
    process.exit(preflightOk ? 2 : 1);
  }
  const sessionOk = printChecks(
    `Session (evidence: ${path.relative(repoRoot, state.evidenceDir)})`,
    await sessionChecks(state)
  );
  if (state.org) {
    console.log(`  org ${state.org.alias} user ${state.org.username} workspace ${state.workspacePath}`);
  }
  process.exit(sessionOk ? 0 : 1);
}

// ---------------------------------------------------------------- start

async function bundleHost() {
  const esbuild = repoRequire('esbuild');
  await esbuild.build({
    entryPoints: [path.join(skillDir, 'scripts', 'session.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    packages: 'external',
    outfile: bundlePath,
    logLevel: 'warning'
  });
}

async function start(flags) {
  const existing = readState();
  if (existing && isOurHost(existing.hostPid)) {
    fail(`a session is already running (host pid ${existing.hostPid}). Run doctor, or stop it first.`);
  }
  if (existing || existsSync(sessionDir)) {
    console.log('verify: removing stale session state from a host that is no longer running.');
    if (existing?.org?.strategy === 'pool') {
      console.log(`verify: its pool lease on ${existing.org.slotKey} expires by TTL; nothing else to clean up.`);
    }
    rmSync(sessionDir, { recursive: true, force: true });
  }

  if (!flags['no-build']) {
    console.log('verify: building (pnpm run build)...');
    const build = spawnSync('pnpm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
    if (build.status !== 0) fail('pnpm run build failed; fix the build before verifying.');
  }
  const missing = BUILD_ARTIFACTS.filter(file => !existsSync(path.join(repoRoot, file)));
  if (missing.length) fail(`missing build artifacts: ${missing.join(', ')}`);

  await bundleHost();

  const evidenceDir = path.join(evidenceRoot, stamp());
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const hostOut = path.join(evidenceDir, 'host.out');
  const out = openSync(hostOut, 'a');
  const targetOrg = typeof flags['target-org'] === 'string' ? flags['target-org'] : '';
  // Seeding runs anonymous Apex and sets a trace flag: default on for disposable scratch orgs only.
  const seed = flags['no-seed'] ? false : targetOrg ? Boolean(flags.seed) : true;
  const env = {
    ...process.env,
    VERIFY_REPO_ROOT: repoRoot,
    VERIFY_SESSION_DIR: sessionDir,
    VERIFY_EVIDENCE_DIR: evidenceDir,
    VERIFY_SOCKET: socketPathFor(sessionDir),
    VERIFY_TARGET_ORG: targetOrg,
    VERIFY_SEED: seed ? '1' : '0',
    VERIFY_TRACE: flags.trace ? '1' : '0',
    VERIFY_IDLE_MINUTES: String(flags['idle-minutes'] || process.env.VERIFY_IDLE_MINUTES || 30),
    ALV_NODE_BIN_PATH: process.env.ALV_NODE_BIN_PATH || process.execPath,
    SF_SCRATCH_POOL_OWNER: process.env.SF_SCRATCH_POOL_OWNER || `verify:${hostname()}`,
    ALV_E2E_TIMING: process.env.ALV_E2E_TIMING || '1'
  };
  const hostCommand = [process.execPath, bundlePath];
  const command =
    process.platform === 'linux' && !process.env.DISPLAY
      ? ['xvfb-run', '-a', '-s', '-screen 0 1920x1080x24', ...hostCommand]
      : hostCommand;
  const child = spawn(command[0], command.slice(1), {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', out, out]
  });
  closeSync(out);
  let exited;
  child.on('exit', (code, signal) => (exited = { code, signal }));
  child.unref();
  console.log(`verify: host starting (launcher pid ${child.pid}); progress in ${path.relative(repoRoot, hostOut)}`);

  // The host abandons its own start after 15 minutes (and releases the lease); wait a little longer to report it.
  const deadline = Date.now() + 16 * 60_000;
  let printed = 0;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    try {
      const lines = readFileSync(hostOut, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('[verify]'));
      for (const line of lines.slice(printed)) console.log(line);
      printed = lines.length;
    } catch {}
    const state = readState();
    if (state?.phase === 'ready') {
      console.log(
        JSON.stringify(
          {
            ready: true,
            org: state.org,
            workspacePath: state.workspacePath,
            seeded: state.seeded,
            evidenceDir: path.relative(repoRoot, state.evidenceDir)
          },
          null,
          2
        )
      );
      return;
    }
    if (exited) {
      printTail(hostOut);
      fail(
        `host exited before becoming ready (${JSON.stringify(exited)}). Evidence and host output: ${path.relative(repoRoot, evidenceDir)}`
      );
    }
  }
  fail(`host was not ready after 15 minutes; inspect ${path.relative(repoRoot, hostOut)} and run stop.`);
}

// ---------------------------------------------------------------- run / shot / sf / stop

function resolveStep(name) {
  if (!name) fail('usage: verify.mjs run <step-name|path/to/step.mjs> [json-args]');
  const candidates = [
    path.resolve(name),
    path.join(skillDir, 'steps', name),
    path.join(skillDir, 'steps', `${name}.mjs`)
  ];
  const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) fail(`step not found: ${name} (looked in ${path.relative(repoRoot, path.join(skillDir, 'steps'))})`);
  return found;
}

async function run(positional) {
  const file = resolveStep(positional[0]);
  let args = {};
  if (positional[1]) {
    try {
      args = JSON.parse(positional[1]);
    } catch {
      fail('step args must be one JSON object, for example \'{"query":"ALV_E2E"}\'');
    }
  }
  const { status, body } = await request('POST', '/run', { file, args });
  console.log(JSON.stringify(body, null, 2));
  if (status !== 200 || !body.ok) process.exit(1);
}

async function shot(positional) {
  const { status, body } = await request('POST', '/shot', { name: positional[0] || 'window' }, 60_000);
  console.log(JSON.stringify(body));
  if (status !== 200) process.exit(1);
}

function sf(positional) {
  const state = readState();
  if (!state?.workspacePath) fail('no running session; sf runs inside the session workspace against its org.');
  const bin = path.join(repoRoot, 'packages', 'sf-plugin', 'bin', 'run.js');
  if (!existsSync(path.join(repoRoot, 'packages', 'sf-plugin', 'oclif.manifest.json'))) {
    fail('sf plugin is not built; run pnpm run build:sf-plugin');
  }
  const args = [...positional];
  if (!args.some(arg => ['--target-org', '-o'].includes(arg) || arg.startsWith('--target-org='))) {
    args.push('--target-org', state.org.alias);
  }
  const result = spawnSync(process.execPath, [bin, 'electivus', ...args], {
    cwd: state.workspacePath,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const name = `sf-${
    args
      .filter(arg => !arg.startsWith('-'))
      .slice(0, 2)
      .join('-') || 'command'
  }`;
  const record = {
    command: `node packages/sf-plugin/bin/run.js electivus ${args.join(' ')}`,
    cwd: state.workspacePath,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
  const file = path.join(state.evidenceDir, `cli-${stamp({ milliseconds: true })}-${name}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.error(`verify: exit ${result.status}; recorded ${path.relative(repoRoot, file)}`);
  process.exit(result.status ?? 1);
}

async function stop(flags) {
  const state = readState();
  if (!state) {
    console.log('verify: no session state; nothing to stop.');
    return;
  }
  const evidenceDir = state.evidenceDir;
  if (isOurHost(state.hostPid)) {
    try {
      await request('POST', '/stop', { retire: Boolean(flags.retire), keep: Boolean(flags.keep) }, 15_000);
    } catch {
      process.kill(state.hostPid, 'SIGTERM');
    }
    const deadline = Date.now() + 180_000;
    while (pidAlive(state.hostPid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    if (pidAlive(state.hostPid)) {
      console.error('verify: host did not exit in 3 minutes; killing the processes this session started.');
      if (state.userDataDir && commandOf(state.vscodePid).includes(state.userDataDir)) {
        process.kill(state.vscodePid, 'SIGKILL');
      }
      if (isOurHost(state.hostPid)) process.kill(state.hostPid, 'SIGKILL');
    }
  } else {
    console.log('verify: host is not running; clearing stale state.');
  }
  rmSync(sessionDir, { recursive: true, force: true });
  if (!existsSync(evidenceDir)) fail(`evidence directory is missing: ${evidenceDir}`);
  console.log(`verify: stopped. Evidence: ${path.relative(repoRoot, evidenceDir)}`);
  printTail(path.join(evidenceDir, 'host.out'), 5);
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);
const commands = {
  doctor: () => doctor(),
  start: () => start(flags),
  run: () => run(positional),
  shot: () => shot(positional),
  sf: () => sf(rest[0] === '--' ? rest.slice(1) : rest),
  stop: () => stop(flags)
};
if (!commands[command]) {
  console.log('usage: verify.mjs <doctor|start|run|shot|sf|stop> — see .claude/skills/verify/SKILL.md');
  process.exit(command ? 1 : 0);
}
Promise.resolve(commands[command]()).catch(error => fail(error instanceof Error ? error.message : String(error)));
