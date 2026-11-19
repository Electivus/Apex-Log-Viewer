import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { CustomLogCaptureResult } from '@alv/core/contracts';

import CustomLogCapture from '../src/commands/electivus/custom-log/capture.ts';
import { core } from '../src/core.ts';
import { eventObjectKey } from '../../core/src/customLogs/events/store.ts';
import { OBJECT, config, world } from './support/captureWorld.ts';
import { withStreams } from './support/streams.ts';

// The test runner gives this file its own process, so the preload delays the file syncs of these tests only.

process.env.ALV_TEST_SLOW_SYNC_MS = '700';
const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts');
await import(pathToFileURL(path.join(scripts, 'slow-disk.mjs')).href);

test.after(() => core.dispose());

const namesUnder = async (directory: string): Promise<string[]> =>
  (await fs.readdir(directory, { recursive: true })).map(entry => path.basename(entry));

const drain = async (org: string[]) => {
  const started = performance.now();
  const { out } = await withStreams(() => new CustomLogCapture([...org, '--max-time', '1', '--json'], config)._run());
  return {
    result: JSON.parse(out).result as CustomLogCaptureResult,
    elapsedMs: Math.round(performance.now() - started),
    stored: await namesUnder(path.join(process.cwd(), 'apexlogs'))
  };
};

// A stalled runner stretches the wall time, so each test asserts on a file that the open writes well after the limit.

test('--max-time that passes while a slow disk opens the event store stops the open', async t => {
  const { double, org } = await world(t);

  const { result, elapsedMs, stored } = await drain(org);

  assert.equal(result.outcome, 'timeLimit');
  assert.deepEqual([result.delivered, result.stored], [0, 0]);
  assert.deepEqual(double.replays, [], 'nothing subscribed');
  assert.ok(
    !stored.includes('format.json'),
    `the store open ran on past the limit: the command took ${elapsedMs} ms and left ${stored.join(', ')}`
  );
});

test('--max-time that passes after the open took the capture lease gives the lease back', async t => {
  const { double, org } = await world(t);
  // With its directories in place the open takes the lease at once, so the limit passes while it holds the lease.
  await fs.mkdir(path.join(process.cwd(), 'apexlogs', 'orgs', double.username, 'events', eventObjectKey(OBJECT)), {
    recursive: true
  });

  const { result, elapsedMs, stored } = await drain(org);

  assert.equal(result.outcome, 'timeLimit');
  assert.deepEqual(double.replays, [], 'nothing subscribed');
  assert.ok(
    !stored.includes('.gitignore'),
    `the store open ran on past the limit: the command took ${elapsedMs} ms and left ${stored.join(', ')}`
  );
  assert.ok(!stored.includes('capture.lease'), 'the lease is free for the next run');
});
