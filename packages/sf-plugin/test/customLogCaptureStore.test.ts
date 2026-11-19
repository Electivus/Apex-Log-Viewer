import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import type { CustomLogCaptureResult, CustomLogListResult } from '@alv/core/contracts';

import CustomLogCapture from '../src/commands/electivus/custom-log/capture.ts';
import CustomLogList from '../src/commands/electivus/custom-log/list.ts';
import { core } from '../src/core.ts';
import { openEventStore } from '../../core/src/customLogs/events/store.ts';
import { recordedEvents } from '../../core/test/support/cometdDouble.ts';
import { OBJECT, config, world } from './support/captureWorld.ts';
import { until, withStreams } from './support/streams.ts';

/**
 * The commands over the real core: `capture` talks CometD to the Bayeux double that unit 7 built (the
 * real Faye client inside jsforce against a local long-poll server), and `list` reads what
 * `capture` stored. The command tests with a fake core cover flags and signals; this file covers the
 * join between the two commands, which no fake can.
 */

test.after(() => core.dispose());

const capture = (...argv: string[]) => new CustomLogCapture(argv, config);
const list = (...argv: string[]) => new CustomLogList(argv, config);

test('capture drains the event stream into the store, and list then reads it with the org unreachable', async t => {
  // No drain here ends on a time bound: one starts with the run, so a slow store open under the lease can use it
  // up before the subscribe. Two deliveries left is a budget of one, so the first drain ends on the one event.
  const { double, org } = await world(t, { remaining: 2 });

  const first = await withStreams(() => capture(...org, '--json')._run());
  const drained = JSON.parse(first.out).result as CustomLogCaptureResult;

  assert.equal(first.err, '');
  assert.equal(drained.source.shape, 'events');
  assert.equal(drained.outcome, 'budget');
  assert.deepEqual([drained.delivered, drained.stored, drained.newGaps], [1, 1, []]);
  assert.equal(drained.store.state, 'captured');

  // The second drain waits 15 s for a first event over its young position, so it stops once it has resubscribed.
  const second = await withStreams(async () => {
    const running = capture(...org, '--json')._run();
    await until(() => double.replays.length === 2, 60_000);
    process.emit('SIGINT');
    return running;
  });
  const resumed = JSON.parse(second.out).result as CustomLogCaptureResult;

  assert.deepEqual([resumed.delivered, resumed.stored], [0, 0]);
  assert.equal(resumed.outcome, 'aborted');
  const { data } = recordedEvents('single')[0]!;
  assert.deepEqual(double.replays, [{ [`/event/${OBJECT}`]: -2 }, { [`/event/${OBJECT}`]: data.event.replayId }]);

  await double.close();
  const received = double.received;
  const offline = await withStreams(() => list(...org, '--json')._run());
  const page = JSON.parse(offline.out).result as CustomLogListResult;

  assert.equal(double.received, received, 'list made no request');
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0]!.title, 'Synthetic INFO entry 870 of 870 (bsn870)');
  assert.equal(page.store?.state, 'captured');
});

test('a drain reports in its JSON result the delivery allowance the org had and the budget of the run', async t => {
  // One delivery left is a budget of zero, so the run ends as soon as it has read the allowance. A time bound
  // would also have to cover taking the lease and connecting, which a loaded runner can stretch past it.
  const { org } = await world(t, { remaining: 1 });

  const { out } = await withStreams(() => capture(...org, '--json')._run());
  const drained = JSON.parse(out).result as CustomLogCaptureResult;

  assert.equal(drained.outcome, 'budget');
  assert.deepEqual(drained.allowance, { remaining: 1, max: 25_000, budget: 0 });
});

test('a drain that finds another process capturing the source names that process in its JSON result', async t => {
  const { double, org } = await world(t);
  const store = openEventStore({ root: process.cwd(), username: double.username, object: OBJECT });
  const tookLeaseAfter = Date.now();
  const lease = await store.openWriter('vscode');
  const tookLeaseBefore = Date.now();
  assert.ok('writer' in lease, 'the lease was free');

  try {
    const { out, err } = await withStreams(() => capture(...org, '--json')._run());
    const result = JSON.parse(out).result as CustomLogCaptureResult;

    assert.equal(err, '');
    assert.ok(result.outcome === 'capturedElsewhere', `outcome ${result.outcome}`);
    const { since, ...who } = result.holder;
    assert.deepEqual(who, { surface: 'vscode', pid: process.pid, host: os.hostname() });
    assert.ok(
      Date.parse(since) >= tookLeaseAfter && Date.parse(since) <= tookLeaseBefore,
      `since ${since} is when the holder took the lease`
    );
    assert.equal('allowance' in result, false, 'a drain that never held the lease reads no allowance');
    assert.deepEqual(double.replays, [], 'nothing subscribed');
  } finally {
    await lease.writer.release();
  }
});

test('--follow prints the stored row, and Ctrl-C ends with the aborted summary and the row on disk', async t => {
  const { double, org } = await world(t);

  const followed = await withStreams(async ({ out }) => {
    const running = capture(...org, '--follow')._run<CustomLogCaptureResult>();
    await until(() => out.length > 0, 60_000);
    process.emit('SIGINT');
    return running;
  });

  assert.equal(followed.value.outcome, 'aborted');
  assert.equal(process.exitCode ?? 0, 0);
  assert.match(
    followed.out,
    /^\S+ INFO \S+ Synthetic INFO entry 870 of 870 \(bsn870\)\n$/,
    'one row line and nothing else'
  );
  assert.match(followed.err, /Replaying the events Salesforce still retains\./);
  assert.match(followed.err, /Stopping\. Press Ctrl-C again to quit now\./);
  assert.match(followed.err, /Delivered 1, stored 1\. Store: .*alv_test_log__e/);
  assert.equal(double.disconnects, 1, 'the subscription was closed on the server');

  await double.close();
  const offline = await withStreams(() => list(...org, '--json')._run());
  assert.equal((JSON.parse(offline.out).result as CustomLogListResult).rows.length, 1);
});
