// Runs the @alv/core test suite the way CI does, over and over, and tallies failed runs and dead test processes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const minutes = Number(process.env.DIAG_MINUTES ?? '40');
const outDir = process.env.DIAG_OUT ?? path.join(root, '.diag-out');
fs.mkdirSync(outDir, { recursive: true });
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const deadline = Date.now() + minutes * 60_000;
const tally = { runs: 0, failedRuns: 0, deadProcesses: 0, exitCodes: {}, failedTests: {} };
let i = 0;
while (Date.now() < deadline) {
  const started = Date.now();
  const run = spawnSync(pnpm, ['--filter', '@alv/core', 'run', 'test'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20 * 60_000,
    shell: process.platform === 'win32'
  });
  const output = `${run.stdout ?? ''}\n--- stderr ---\n${run.stderr ?? ''}`;
  const seconds = Math.round((Date.now() - started) / 1000);
  tally.runs += 1;
  const dead = [...output.matchAll(/^✖ (.+): the test process exited with code (\S+)/gm)];
  const failed = [...output.matchAll(/^✖ (.+?) \(/gm)].map(m => m[1]);
  if (run.status !== 0) {
    tally.failedRuns += 1;
    fs.writeFileSync(path.join(outDir, `core-${i}.log`), output);
    for (const name of new Set(failed)) tally.failedTests[name] = (tally.failedTests[name] ?? 0) + 1;
  }
  for (const [, , code] of dead) {
    tally.deadProcesses += 1;
    tally.exitCodes[code] = (tally.exitCodes[code] ?? 0) + 1;
  }
  console.log(
    `CORE run ${i}: status ${run.status ?? run.signal}, ${seconds} s, ${failed.length} failing lines, ${dead.length} dead processes` +
      (dead.length ? ` [${dead.map(m => `${m[1]} -> ${m[2]}`).join('; ')}]` : '')
  );
  i += 1;
}
console.log(`CORE ${process.version} uv ${process.versions.uv}: runs ${tally.runs}, failed runs ${tally.failedRuns}, dead processes ${tally.deadProcesses}`);
console.log('CORE dead process exit codes ' + JSON.stringify(tally.exitCodes));
console.log('CORE failed tests ' + JSON.stringify(tally.failedTests, null, 1));
