// Alternates main's orgConnectionReuse test, instrumented, with the fixed one, under one CPU burner.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(root, 'packages/core');
const rounds = Number(process.env.DIAG_REUSE_ROUNDS ?? '150');
const burner = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' });
const lwwFile = path.join(os.tmpdir(), `lww-${process.pid}.txt`);
const usernameOf = {
  'a session Salesforce rejects is rebuilt from the saved auth and retried once': 'revoked@example.com',
  'a session whose refresh token was revoked is rebuilt from the saved auth': 'refresh-revoked@example.com',
  'two callers waiting on one failed token refresh both rebuild from the saved auth': 'refresh-shared@example.com',
  'a log delete whose session Salesforce rejects is retried on a rebuilt connection': 'delete-relogin@example.com',
  'a log delete whose every chunk Salesforce rejects is retried once on a rebuilt connection': 'delete-chunks-relogin@example.com'
};
const run = file =>
  spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', file], {
    cwd: coreDir,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, DIAG_LWW_FILE: lwwFile }
  });
const notOk = stdout => [...stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map(m => m[1]).filter(n => !/\.test\.ts$/.test(n));
const tally = { old: { runs: 0, failed: 0, exit: {}, notOk: {} }, fixed: { runs: 0, failed: 0, exit: {}, notOk: {} } };
const gaps = [];
let failedWithAhead = 0;
let failedWithoutAhead = 0;
const count = (t, r, names) => {
  t.runs += 1;
  const key = String(r.status ?? r.signal);
  t.exit[key] = (t.exit[key] ?? 0) + 1;
  if (r.status !== 0) t.failed += 1;
  for (const n of names) t.notOk[n] = (t.notOk[n] ?? 0) + 1;
};
for (let i = 0; i < rounds; i++) {
  fs.rmSync(lwwFile, { force: true });
  const old = run('test/diagReuseOld.test.ts');
  const samples = fs.existsSync(lwwFile)
    ? fs.readFileSync(lwwFile, 'utf8').trim().split('\n').map(l => l.split(' ')).map(([u, g]) => ({ u, g: Number(g) }))
    : [];
  gaps.push(...samples.map(s => s.g));
  const names = notOk(old.stdout);
  count(tally.old, old, names);
  for (const n of names) {
    const u = usernameOf[n];
    if (!u) continue;
    const ahead = samples.filter(s => s.u === u && s.g > 0);
    if (ahead.length) failedWithAhead += 1;
    else failedWithoutAhead += 1;
    console.log(`OLD round ${i}: ${n}; mtime minus SDK stamp for ${u}: ${samples.filter(s => s.u === u).map(s => s.g.toFixed(3)).join(', ')} ms`);
  }
  if (old.status !== 0 && !names.length) console.log(`OLD round ${i}: process exit ${old.status} with no failed subtest`);
  const fixed = run('test/orgConnectionReuse.test.ts');
  const fixedNames = notOk(fixed.stdout);
  count(tally.fixed, fixed, fixedNames);
  if (fixed.status !== 0) {
    console.log(`FIXED round ${i}: exit ${fixed.status}: ${fixedNames.join('; ')}`);
    console.log(fixed.stdout.split('\n').filter(l => /error:|!==|INVALID_SESSION|token-/.test(l)).slice(0, 12).join('\n'));
  }
}
burner.kill('SIGKILL');
const sorted = [...gaps].sort((a, b) => a - b);
const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
console.log(`LWW ${process.version} uv ${process.versions.uv}`);
console.log(`LWW samples ${gaps.length}, mtime ahead of the SDK stamp in ${gaps.filter(g => g > 0).length}; max ${q(1).toFixed(3)} p99 ${q(0.99).toFixed(3)} p50 ${q(0.5).toFixed(3)} min ${q(0).toFixed(3)} ms`);
console.log(`LWW failed subtests with mtime ahead ${failedWithAhead}, without ${failedWithoutAhead}`);
console.log('LWW old ' + JSON.stringify(tally.old));
console.log('LWW fixed ' + JSON.stringify(tally.fixed));
