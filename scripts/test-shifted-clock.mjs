#!/usr/bin/env node
// Runs the Custom Logs event suites with the wall clock moved by scripts/shift-clock.mjs and lists every failure.
//
//   node scripts/test-shifted-clock.mjs                 # +45, +400 and -1 days
//   node scripts/test-shifted-clock.mjs --days 31,90    # other shifts
//   node scripts/test-shifted-clock.mjs --all           # every core and sf-plugin test file, not only the event suites
//
// Exit 1 when any run fails. Run it after `pnpm run build:core`, as `pnpm run test:sf-plugin` does.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preload = pathToFileURL(path.join(repoRoot, 'scripts', 'shift-clock.mjs')).href;

const EVENT_SUITES = [
  {
    cwd: 'packages/core',
    files: [
      'test/customLogs*Event*.test.ts',
      'test/customLogsCapture*.test.ts',
      'test/customLogsFacadeCapture.test.ts',
      'test/customLogsCometd.test.ts'
    ]
  },
  { cwd: 'packages/sf-plugin', files: ['test/customLog*.test.ts'] }
];
const ALL_SUITES = [
  { cwd: 'packages/core', files: ['test/*.test.ts'] },
  { cwd: 'packages/sf-plugin', files: ['test/*.test.ts'] }
];

const args = process.argv.slice(2);
const daysFlag = args.indexOf('--days');
const shifts = (daysFlag === -1 ? '45,400,-1' : (args[daysFlag + 1] ?? ''))
  .split(',')
  .map(text => (text.trim() === '' ? Number.NaN : Number(text)));
if (shifts.some(days => !Number.isFinite(days))) {
  console.error('--days takes a comma-separated list of numbers, for example 45,400,-1.');
  process.exit(2);
}
const suites = args.includes('--all') ? ALL_SUITES : EVENT_SUITES;

let failed = false;
for (const days of shifts) {
  for (const suite of suites) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', ...suite.files], {
      cwd: path.join(repoRoot, suite.cwd),
      env: { ...process.env, ALV_TEST_CLOCK_SHIFT_DAYS: String(days), NODE_OPTIONS: `--import ${preload}` },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    });
    const lines = run.stdout.split('\n');
    const count = name => lines.find(line => line.startsWith(`# ${name} `))?.slice(`# ${name} `.length) ?? '?';
    const failures = lines.filter(line => /^\s*not ok /.test(line));
    const ok = run.status === 0 && failures.length === 0;
    failed ||= !ok;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${days >= 0 ? '+' : ''}${days} days  ${suite.cwd}  tests ${count('tests')}, pass ${count('pass')}, fail ${count('fail')}`
    );
    for (const line of failures) console.log(`      ${line.trim()}`);
    if (!ok && failures.length === 0) console.log(run.stderr || run.stdout.slice(-2000));
  }
}
process.exit(failed ? 1 : 0);
