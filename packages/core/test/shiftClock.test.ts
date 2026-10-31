import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PRELOAD = path.resolve(__dirname, '../../../scripts/shift-clock.mjs');
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** What a process under the preload sees; `performance.timeOrigin` is the one wall clock the preload leaves alone. */
const PROBE = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realNow = () => performance.timeOrigin + performance.now();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-shift-'));
const file = path.join(dir, 'f');
fs.writeFileSync(file, 'x');
const written = fs.statSync(file);
const asyncWritten = await fs.promises.stat(file);
const anHourAgo = new Date(Date.now() - ${HOUR});
fs.utimesSync(file, anHourAgo, anHourAgo);
const aged = fs.statSync(file);
await fs.promises.utimes(file, anHourAgo, anHourAgo);
const agedAsync = await fs.promises.stat(file);
const original = Date.now;
Date.now = () => 42;
const stubbed = Date.now();
Date.now = original;
fs.rmSync(dir, { recursive: true });
console.log(JSON.stringify({
  nowShift: Date.now() - realNow(),
  constructedShift: new Date().getTime() - realNow(),
  calledShift: Date.parse(Date()) - realNow(),
  fixedInstant: new Date('2026-01-01T00:00:00.000Z').getTime(),
  isDate: new Date() instanceof Date,
  mtimeLagMs: Date.now() - written.mtimeMs,
  mtimeDateLagMs: Date.now() - written.mtime.getTime(),
  asyncMtimeLagMs: Date.now() - asyncWritten.mtimeMs,
  agedErrorMs: aged.mtimeMs - anHourAgo.getTime(),
  agedAsyncErrorMs: agedAsync.mtimeMs - anHourAgo.getTime(),
  stubbed,
  restored: Date.now === original
}));
`;

function run(env: Record<string, string>, program: string = PROBE) {
  const { NODE_OPTIONS: _options, ALV_TEST_CLOCK_SHIFT_DAYS: _shift, ...clean } = process.env;
  return spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', program], {
    env: { ...clean, ...env },
    encoding: 'utf8'
  });
}

function probe(days: number): Record<string, number | boolean> {
  const child = run({ ALV_TEST_CLOCK_SHIFT_DAYS: String(days) });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as Record<string, number | boolean>;
}

for (const days of [45, -1, 0.5]) {
  test(`a process shifted by ${days} days reads the real clock moved by that much, files and all`, () => {
    const seen = probe(days);
    const near = (actual: unknown, expected: number, slackMs: number, what: string) => {
      assert.ok(
        typeof actual === 'number' && Math.abs(actual - expected) <= slackMs,
        `${what}: ${String(actual)} is not within ${slackMs} ms of ${expected}`
      );
    };

    near(seen.nowShift, days * DAY, 100, 'Date.now()');
    near(seen.constructedShift, days * DAY, 100, 'new Date()');
    near(seen.calledShift, days * DAY, 1_100, 'Date()');
    assert.equal(seen.fixedInstant, Date.UTC(2026, 0, 1), 'a date given explicitly is not shifted');
    assert.equal(seen.isDate, true);
    near(seen.mtimeLagMs, 0, 1_100, 'a file written now has mtime close to Date.now()');
    near(seen.mtimeDateLagMs, 0, 1_100, 'the same through stat().mtime');
    near(seen.asyncMtimeLagMs, 0, 1_100, 'the same through fs.promises.stat');
    near(seen.agedErrorMs, 0, 1_100, 'utimes stores the time it was given, as stat reads it back');
    near(seen.agedAsyncErrorMs, 0, 1_100, 'the same through fs.promises.utimes');
    assert.equal(seen.stubbed, 42, 'Date.now can still be stubbed');
    assert.equal(seen.restored, true, 'and restored');
  });
}

test('the preload refuses to run without a finite shift, so an unshifted run is never mistaken for a shifted one', () => {
  for (const value of [undefined, '', 'soon', 'Infinity']) {
    const child = run(value === undefined ? {} : { ALV_TEST_CLOCK_SHIFT_DAYS: value }, 'console.log("ran")');
    assert.notEqual(child.status, 0, `shift ${String(value)} was accepted`);
    assert.match(child.stderr, /ALV_TEST_CLOCK_SHIFT_DAYS/);
    assert.equal(child.stdout, '');
  }
});

test('the scripts suite runs the shifted-clock sweep', () => {
  const rootPackage = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
  assert.match(rootPackage.scripts['test:scripts'], /node scripts\/test-shifted-clock\.mjs/);
});
