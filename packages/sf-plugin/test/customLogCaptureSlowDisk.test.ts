import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { CustomLogCaptureResult } from '@alv/core/contracts';

import CustomLogCapture from '../src/commands/electivus/custom-log/capture.ts';
import { core } from '../src/core.ts';
import { config, world } from './support/captureWorld.ts';
import { withStreams } from './support/streams.ts';

/**
 * `capture --max-time` on a slow disk. This file runs in its own process, so the slow-disk preload it loads delays
 * the file syncs of these tests only.
 */

const SYNC_MS = 700;
process.env.ALV_TEST_SLOW_SYNC_MS = String(SYNC_MS);
const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts');
await import(pathToFileURL(path.join(scripts, 'slow-disk.mjs')).href);

test.after(() => core.dispose());

const namesUnder = async (directory: string): Promise<string[]> =>
  (await fs.readdir(directory, { recursive: true })).map(entry => path.basename(entry));

test(
  '--max-time that passes while a slow disk opens the event store stops the open and frees the lease',
  { todo: '#1507' },
  async t => {
    const { double, org } = await world(t);

    // A first open syncs nine times before it connects: 6.3 s here, against a limit of 1 s.
    const started = performance.now();
    const { out } = await withStreams(() => new CustomLogCapture([...org, '--max-time', '1', '--json'], config)._run());
    const elapsedMs = Math.round(performance.now() - started);
    const result = JSON.parse(out).result as CustomLogCaptureResult;

    assert.equal(result.outcome, 'timeLimit');
    assert.deepEqual([result.delivered, result.stored], [0, 0]);
    assert.deepEqual(double.replays, [], 'nothing subscribed');
    // Not a bound on the wall time, which a stalled runner stretches. The open writes format.json after its seventh
    // sync, 4.9 s in, so a run that stopped near the limit never wrote it.
    const stored = await namesUnder(path.join(process.cwd(), 'apexlogs'));
    assert.ok(
      !stored.includes('format.json'),
      `the store open ran on past the limit: the command took ${elapsedMs} ms and left ${stored.join(', ')}`
    );
    assert.ok(!stored.includes('capture.lease'), 'the lease is free for the next run');
  }
);
