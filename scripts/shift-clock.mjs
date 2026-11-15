// Moves the wall clock of a Node process, so a suite can prove it does not depend on today's date.
//
//   ALV_TEST_CLOCK_SHIFT_DAYS=45 node --import ./scripts/shift-clock.mjs --import tsx --test test/*.test.ts
//   ALV_TEST_CLOCK_SHIFT_DAYS=-1 NODE_OPTIONS="--import $PWD/scripts/shift-clock.mjs" pnpm run test:core
//
// `new Date()`, `Date.now()`, `Date()` and `performance.timeOrigin` read the real clock plus the shift. File times
// move with it, as if the system clock itself had moved: stat results report mtime/atime/ctime/birthtime plus the
// shift, BigInt stats (`stat(path, { bigint: true })`) included, and `utimes` takes the shifted time and stores the
// real one. @salesforce/core compares a BigInt `mtimeNs` with its own wall clock, `Date.now()` from 9.4 and
// `performance.timeOrigin + performance.now()` before, so all of them move together. Monotonic clocks and timers
// (`setTimeout`, `performance.now`) are untouched, so durations stay true. Child processes inherit the shift through
// NODE_OPTIONS. `FileHandle.stat` is not shifted.
//
// The preload refuses to run without a shift, so an unshifted run is never mistaken for a shifted one.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const DAY_MS = 86_400_000;

const raw = process.env.ALV_TEST_CLOCK_SHIFT_DAYS;
const days = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
if (!Number.isFinite(days)) {
  throw new Error(
    'shift-clock.mjs needs ALV_TEST_CLOCK_SHIFT_DAYS set to a finite number of days, for example 45 or -1.'
  );
}
const shiftMs = Math.round(days * DAY_MS);

const RealDate = Date;
const realNow = RealDate.now;
const shiftedNow = () => realNow.call(RealDate) + shiftMs;

// `Date.now` stays an ordinary property, so a test that stubs it and restores it still works.
RealDate.now = shiftedNow;
globalThis.Date = new Proxy(RealDate, {
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length === 0 ? [shiftedNow()] : args, newTarget),
  apply: () => new RealDate(shiftedNow()).toString()
});

Object.defineProperty(performance, 'timeOrigin', {
  value: performance.timeOrigin + shiftMs,
  enumerable: true,
  configurable: true
});

const TIME_FIELDS = ['atime', 'mtime', 'ctime', 'birthtime'];

const define = (stats, key, value) =>
  Object.defineProperty(stats, key, { value, writable: true, enumerable: true, configurable: true });

const shiftedStats = stats => {
  if (typeof stats?.mtimeMs === 'bigint') {
    const shift = BigInt(shiftMs);
    for (const field of TIME_FIELDS) {
      const ms = stats[`${field}Ms`] + shift;
      define(stats, `${field}Ms`, ms);
      define(stats, `${field}Ns`, stats[`${field}Ns`] + shift * 1_000_000n);
      define(stats, field, new RealDate(Number(ms)));
    }
    return stats;
  }
  if (typeof stats?.mtimeMs !== 'number') return stats;
  for (const field of TIME_FIELDS) {
    const ms = stats[`${field}Ms`] + shiftMs;
    define(stats, `${field}Ms`, ms);
    define(stats, field, new RealDate(ms));
  }
  return stats;
};

const realTime = time => {
  if (time instanceof RealDate) return new RealDate(time.getTime() - shiftMs);
  if (typeof time === 'number') return time - shiftMs / 1000;
  return time;
};

const wrapStat = (owner, name) => {
  const real = owner[name];
  owner[name] = function (...args) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
    if (callback) return real.call(this, ...args, (error, stats) => callback(error, shiftedStats(stats)));
    const result = real.call(this, ...args);
    return result instanceof Promise ? result.then(shiftedStats) : shiftedStats(result);
  };
};

const wrapUtimes = (owner, name) => {
  const real = owner[name];
  owner[name] = function (target, atime, mtime, ...rest) {
    return real.call(this, target, realTime(atime), realTime(mtime), ...rest);
  };
};

for (const name of ['stat', 'lstat', 'statSync', 'lstatSync']) wrapStat(fs, name);
for (const name of ['stat', 'lstat']) wrapStat(fs.promises, name);
for (const name of ['utimes', 'utimesSync']) wrapUtimes(fs, name);
wrapUtimes(fs.promises, 'utimes');
syncBuiltinESMExports();
