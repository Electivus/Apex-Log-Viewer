// Delays every file sync of a Node process, so a suite can prove it does not depend on a fast disk.
//
//   ALV_TEST_SLOW_SYNC_MS=400 node --import ./scripts/slow-disk.mjs --import tsx --test test/customLogsCapture*.test.ts
//   ALV_TEST_SLOW_SYNC_MS=150 NODE_OPTIONS="--import $PWD/scripts/slow-disk.mjs" pnpm run test:sf-plugin
//
// `FileHandle.sync` and `FileHandle.datasync` wait that many milliseconds and then run. Those two calls are every
// sync the Custom Logs event store makes: the lease, the appends, the checkpoint and the directories it creates.
// Nothing else slows down, and CPU load does not reproduce what a slow sync does. Child processes inherit the delay
// through NODE_OPTIONS. `fs.fsync`, `fs.fsyncSync` and their `fdatasync` twins are not delayed.
//
// The preload refuses to run without a delay, so a fast run is never mistaken for a slow one.
import fs from 'node:fs';

const raw = process.env.ALV_TEST_SLOW_SYNC_MS;
const delayMs = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
if (!Number.isFinite(delayMs) || delayMs < 0) {
  throw new Error('slow-disk.mjs needs ALV_TEST_SLOW_SYNC_MS set to a delay in milliseconds, for example 150 or 400.');
}

const probe = await fs.promises.open(process.execPath, 'r');
const fileHandle = Object.getPrototypeOf(probe);
await probe.close();

for (const name of ['sync', 'datasync']) {
  const real = fileHandle[name];
  fileHandle[name] = async function (...args) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return real.apply(this, args);
  };
}
