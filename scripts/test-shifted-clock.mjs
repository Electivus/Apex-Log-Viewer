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

// Lines of a failure's TAP block worth showing: the stack and the timing add length, not a reason.
const DETAIL_KEYS = /^(location|failureType|exitCode|signal|error|code|name|expected|actual|operator):/;
// An error message can carry a whole stack; past this many lines the rest is counted, not printed.
const MAX_DETAIL_LINES = 40;

/**
 * Why the test on the `not ok` line at `index` failed: the keys of the YAML block TAP writes under it, the multi-line
 * error message included, so a CI log shows the assertion message, the location and, for a test file whose process
 * died, its exit code. Empty for a parent that failed only because a subtest did, since that subtest prints its own.
 */
export function failureDetails(lines, index, maxLines = MAX_DETAIL_LINES) {
  const indent = lines[index].length - lines[index].trimStart().length + 2;
  if (lines[index + 1]?.trim() !== '---') return [];
  const block = [];
  for (let i = index + 2; i < lines.length && lines[i].trim() !== '...'; i += 1) block.push(lines[i].slice(indent));
  if (block.includes("failureType: 'subtestsFailed'")) return [];
  const details = [];
  let keep = false;
  for (const line of block) {
    if (!line.startsWith(' ')) keep = DETAIL_KEYS.test(line);
    if (keep) details.push(line);
  }
  if (details.length <= maxLines) return details;
  return [...details.slice(0, maxLines), `… ${details.length - maxLines} more lines`];
}

function main(args) {
  const daysFlag = args.indexOf('--days');
  const shifts = (daysFlag === -1 ? '45,400,-1' : (args[daysFlag + 1] ?? ''))
    .split(',')
    .map(text => (text.trim() === '' ? Number.NaN : Number(text)));
  if (shifts.some(days => !Number.isFinite(days))) {
    console.error('--days takes a comma-separated list of numbers, for example 45,400,-1.');
    return 2;
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
      const failures = lines.flatMap((line, index) => (/^\s*not ok /.test(line) ? [index] : []));
      const ok = run.status === 0 && failures.length === 0;
      failed ||= !ok;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${days >= 0 ? '+' : ''}${days} days  ${suite.cwd}  tests ${count('tests')}, pass ${count('pass')}, fail ${count('fail')}`
      );
      for (const index of failures) {
        console.log(`      ${lines[index].trim()}`);
        for (const detail of failureDetails(lines, index)) console.log(`          ${detail}`);
      }
      if (!ok && failures.length === 0) console.log(run.stderr || run.stdout.slice(-2000));
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
