// Runs packages/core/test/orgConnectionReuse.test.ts many times under one CPU burner and tallies failures.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(root, 'packages/core');
const rounds = Number(process.env.DIAG_REUSE_ROUNDS ?? '150');
const outDir = process.env.DIAG_OUT ?? path.join(root, '.diag-out');
fs.mkdirSync(outDir, { recursive: true });
const burner = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' });
const tally = { runs: 0, failedRuns: 0, exitCodes: {}, notOk: {} };
const started = Date.now();
for (let i = 0; i < rounds; i++) {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=tap', 'test/orgConnectionReuse.test.ts'],
    { cwd: coreDir, encoding: 'utf8', timeout: 180_000 }
  );
  tally.runs += 1;
  const key = String(run.status ?? run.signal);
  tally.exitCodes[key] = (tally.exitCodes[key] ?? 0) + 1;
  if (run.status !== 0) {
    tally.failedRuns += 1;
    for (const line of run.stdout.split('\n')) {
      const m = /^\s*not ok \d+ - (.*)$/.exec(line);
      if (m) tally.notOk[m[1]] = (tally.notOk[m[1]] ?? 0) + 1;
    }
    fs.writeFileSync(path.join(outDir, `reuse-${i}.log`), run.stdout + '\n--- stderr ---\n' + run.stderr);
    console.log(`REUSE run ${i} failed, status ${run.status}, signal ${run.signal}`);
    const details = run.stdout.split('\n').filter(l => /not ok|error:|actual:|expected:|exitCode:|INVALID_SESSION|deleteTokens|token-/.test(l));
    console.log(details.slice(0, 40).join('\n'));
  }
}
burner.kill('SIGKILL');
console.log(`REUSE ${process.version} rounds ${tally.runs}, failed ${tally.failedRuns}, ${Math.round((Date.now() - started) / 1000)} s`);
console.log('REUSE exit codes ' + JSON.stringify(tally.exitCodes));
console.log('REUSE not ok ' + JSON.stringify(tally.notOk));
