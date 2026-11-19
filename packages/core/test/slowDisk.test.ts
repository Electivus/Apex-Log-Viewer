import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const PRELOAD = pathToFileURL(path.resolve(__dirname, '../../../scripts/slow-disk.mjs')).href;
const DELAY_MS = 500;

/** How long a process under the preload spends in each kind of file call. */
const PROBE = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-slow-'));
const timed = async run => {
  const start = performance.now();
  await run();
  return performance.now() - start;
};
const handle = await fs.promises.open(path.join(dir, 'f'), 'w');
const writeMs = await timed(() => handle.writeFile('x'));
const syncMs = await timed(() => handle.sync());
const datasyncMs = await timed(() => handle.datasync());
await handle.close();
const directory = await fs.promises.open(dir, 'r');
const directorySyncMs = await timed(() => directory.sync().catch(() => undefined));
await directory.close();
fs.rmSync(dir, { recursive: true });
console.log(JSON.stringify({ writeMs, syncMs, datasyncMs, directorySyncMs }));
`;

function run(env: Record<string, string>, program: string = PROBE) {
  const { NODE_OPTIONS: _options, ALV_TEST_SLOW_SYNC_MS: _delay, ...clean } = process.env;
  return spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', program], {
    env: { ...clean, ...env },
    encoding: 'utf8'
  });
}

test('a process under the slow-disk preload waits the delay before every file sync, and nowhere else', () => {
  const child = run({ ALV_TEST_SLOW_SYNC_MS: String(DELAY_MS) });
  assert.equal(child.status, 0, child.stderr);
  const seen = JSON.parse(child.stdout) as Record<string, number>;

  // Timers can fire a millisecond early; a real sync of one byte never takes most of the delay.
  for (const call of ['syncMs', 'datasyncMs', 'directorySyncMs'] as const) {
    assert.ok(seen[call]! >= DELAY_MS - 5, `${call}: ${seen[call]} ms is shorter than the ${DELAY_MS} ms delay`);
  }
  assert.ok(seen.writeMs! < DELAY_MS - 5, `a write is not delayed: ${seen.writeMs} ms`);
});

test('the preload refuses to run without a delay, so a fast run is never mistaken for a slow one', () => {
  for (const value of [undefined, '', 'slow', 'Infinity', '-1']) {
    const child = run(value === undefined ? {} : { ALV_TEST_SLOW_SYNC_MS: value }, 'console.log("ran")');
    assert.notEqual(child.status, 0, `delay ${String(value)} was accepted`);
    assert.match(child.stderr, /ALV_TEST_SLOW_SYNC_MS/);
    assert.equal(child.stdout, '');
  }
});
