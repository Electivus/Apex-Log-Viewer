import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CustomLogCaptureResult } from '../src/customLogs/contracts.ts';
import { createCaptureHub } from '../src/customLogs/events/capture.ts';
import { LeaseLostError, type EventStore } from '../src/customLogs/events/store.ts';
import {
  ManualClock,
  busEvent,
  captureDeps,
  cursorOf,
  eventSource,
  fakeTransport,
  instrumentStore,
  objectDirOf,
  openStore,
  openWriter,
  readStored,
  seedCheckpoint,
  until,
  watcher,
  withProject
} from './support/captureHarness.ts';

const settledOf = (promise: Promise<CustomLogCaptureResult>) =>
  promise.then(
    result => ({ result }),
    (error: unknown) => ({ error })
  );

async function resultOf(promise: Promise<CustomLogCaptureResult>): Promise<CustomLogCaptureResult> {
  const settled = await settledOf(promise);
  assert.ok('result' in settled, `the run failed: ${'error' in settled ? String(settled.error) : ''}`);
  return settled.result;
}

const checkpointCursor = async (store: EventStore) => (await store.checkpoint())?.cursor;

function setup(options: { clock?: ManualClock; surface?: 'vscode' | 'cli' } = {}) {
  const clock = options.clock ?? new ManualClock();
  const transport = fakeTransport();
  const deps = captureDeps({ clock, transport, ...(options.surface ? { surface: options.surface } : {}) });
  return { clock, transport, deps, hub: createCaptureHub() };
}

/** A process that stays alive until killed, standing in for another window that holds the capture lease. */
async function foreignHolder(root: string) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(child.pid !== undefined);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const lease = path.join(objectDirOf(root), 'capture.lease');
  return {
    pid: child.pid,
    plant: () =>
      fs.writeFileSync(
        lease,
        JSON.stringify({
          version: 1,
          pid: child.pid,
          token: '0123456789abcdef',
          host: os.hostname(),
          surface: 'vscode',
          startedAt: '2026-10-30T10:00:00.000Z'
        })
      ),
    die: () =>
      new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      })
  };
}

const standbyUpdate = (w: ReturnType<typeof watcher>) =>
  w.updates.find(update => update.capture.state === 'standby')?.capture;

// ---------------------------------------------------------------------------------------------
// several watchers, one run

test('two watchers share one connection, one subscription and one set of stored rows, each decoded through its own source', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup();
    const first = watcher({ follow: true, initial: 'new' });
    const second = watcher({ follow: true }, { source: eventSource('second') });

    const firstDone = hub.watch(store, first.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    const secondDone = hub.watch(store, second.watcher, deps);
    await until(() => second.updates.length > 0, 'the joiner to be told the current state');
    assert.deepEqual(second.updates[0]!.capture, { state: 'catchingUp', from: 'new' });

    attempt.events(busEvent(1));
    await clock.advance(250);
    await until(() => first.rows().length === 1 && second.rows().length === 1, 'both watchers to get the row');
    assert.equal(transport.attempts.length, 1);
    assert.equal(deps.calls.connects.length, 1);
    assert.deepEqual([...deps.calls.decoded].sort(), ['app-events', 'second']);

    first.abort();
    const firstResult = await resultOf(firstDone);
    assert.equal(firstResult.outcome, 'aborted');
    assert.equal(firstResult.delivered, 1);
    assert.equal(attempt.aborted, false, 'the run goes on for the watcher that is still there');

    attempt.events(busEvent(2));
    await clock.advance(250);
    await until(() => second.rows().length === 2, 'the remaining watcher to get the next row');
    assert.equal(first.rows().length, 1, 'a watcher that left hears nothing more');

    second.abort();
    const secondResult = await resultOf(secondDone);
    assert.equal(secondResult.delivered, 2);
    assert.equal(secondResult.stored, 2);
    assert.equal(attempt.aborted, true, 'the last watcher takes the subscription down');
    assert.equal((await readStored(store)).length, 2);
  });
});

test('a drain that joins a run that is already live is done at once, and a follow watcher that joins is not', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup();
    const follower = watcher({ follow: true, initial: 'new' });

    const followerDone = hub.watch(store, follower.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    await clock.advance(15_000);
    assert.ok(follower.states().includes('live'));

    const drain = watcher({ follow: false });
    const drainResult = await resultOf(hub.watch(store, drain.watcher, deps));
    assert.equal(drainResult.outcome, 'quiet');
    assert.equal(attempt.aborted, false);
    assert.equal(transport.attempts.length, 1);

    follower.abort();
    assert.equal((await resultOf(followerDone)).outcome, 'aborted');
  });
});

test('a watcher callback that throws is detached and reported, and neither the run nor the other watcher notices', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup();
    const healthy = watcher({ follow: true, initial: 'new' });
    const broken = watcher({ follow: true });
    let calls = 0;
    broken.watcher.onUpdate = () => {
      calls += 1;
      throw new Error('webview disposed');
    };

    const healthyDone = hub.watch(store, healthy.watcher, deps);
    const brokenDone = hub.watch(store, broken.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1));
    await clock.advance(250);
    await until(() => healthy.rows().length === 1, 'the healthy watcher to get the row');

    assert.equal(calls, 1, 'detached after the first throw');
    assert.equal(deps.calls.callbackErrors.length, 1);
    assert.equal(attempt.aborted, false);
    broken.abort();
    healthy.abort();
    await resultOf(brokenDone);
    await resultOf(healthyDone);
  });
});

test('a watcher whose signal already fired resolves aborted without a connection, a lease or a subscription', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { transport, deps, hub } = setup();
    const w = watcher({ follow: true });
    w.abort();

    const result = await resultOf(hub.watch(store, w.watcher, deps));

    assert.equal(result.outcome, 'aborted');
    assert.equal(deps.calls.connects.length, 0);
    assert.equal(transport.attempts.length, 0);
    await openWriter(store);
  });
});

test('a watcher that arrives while the last one is closing the run waits for the lease instead of mistaking it for another process', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { transport, deps, hub } = setup();
    const leaving = watcher({ follow: true, initial: 'new' });
    const leavingDone = hub.watch(store, leaving.watcher, deps);
    const first = await transport.opened(0);
    first.subscribed();

    leaving.abort();
    const arriving = watcher({ follow: false, initial: 'new' });
    const arrivingDone = hub.watch(store, arriving.watcher, deps);

    await resultOf(leavingDone);
    const second = await transport.opened(1);
    assert.ok(!arriving.states().includes('standby'));
    second.subscribed();
    arriving.abort();
    assert.equal((await resultOf(arrivingDone)).outcome, 'aborted');
  });
});

test('dispose ends every run now, tells its watchers aborted, and gives the lease back', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { transport, deps, hub } = setup();
    const w = watcher({ follow: true, initial: 'new' });
    const done = hub.watch(store, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();

    await hub.dispose();

    assert.equal((await resultOf(done)).outcome, 'aborted');
    assert.equal(attempt.aborted, true);
    await openWriter(store);
    const later = watcher({ follow: true });
    assert.equal(
      (await resultOf(hub.watch(store, later.watcher, deps))).outcome,
      'aborted',
      'a disposed hub starts nothing'
    );
  });
});

// ---------------------------------------------------------------------------------------------
// the lease: standby, relay, takeover

test('a process that finds the lease held stands by, relays what the holder stores, and takes over after the holder dies', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const holder = await openWriter(openStore(root), 'vscode');
    await holder.append([busEvent(1)]);
    await holder.advance({
      orgId: '00D000000000001AAA',
      transport: 'cometd',
      channel: '/event/App_Log__e',
      cursor: cursorOf(1),
      lastEvent: { createdDate: busEvent(1).createdDate, uuid: busEvent(1).uuid }
    });
    const { clock, transport, deps, hub } = setup({ surface: 'cli' });
    const w = watcher({ follow: true });
    const foreign = await foreignHolder(root);
    try {
      const done = hub.watch(store, w.watcher, deps);
      await until(() => standbyUpdate(w) !== undefined, 'the standby state');
      const holderState = standbyUpdate(w);
      assert.ok(holderState?.state === 'standby');
      assert.deepEqual(
        { surface: holderState.holder.surface, pid: holderState.holder.pid, host: holderState.holder.host },
        { surface: 'vscode', pid: process.pid, host: os.hostname() }
      );
      assert.equal(transport.attempts.length, 0, 'a standby run subscribes nothing');
      assert.equal(deps.calls.connects.length, 0, 'and does not even connect');

      await holder.append([busEvent(2), busEvent(3)]);
      await clock.advance(2_000);
      await until(() => w.rows().length === 2, 'the rows the holder stored');
      assert.deepEqual(w.rows(), ['message 2', 'message 3']);
      await clock.advance(2_000);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      assert.equal(w.rows().length, 2, 'a row is relayed once');

      await holder.advance({
        orgId: '00D000000000001AAA',
        transport: 'cometd',
        channel: '/event/App_Log__e',
        cursor: cursorOf(3),
        lastEvent: { createdDate: busEvent(3).createdDate, uuid: busEvent(3).uuid }
      });
      foreign.plant();
      await clock.advance(2_000);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      assert.equal(transport.attempts.length, 0, 'a live pid keeps the lease');

      await foreign.die();
      await clock.advance(2_000);
      const attempt = await transport.opened(0);
      assert.deepEqual(
        attempt.from,
        { kind: 'after', cursor: cursorOf(3) },
        'the takeover resumes where the holder left off'
      );
      attempt.subscribed();
      attempt.events(busEvent(4));
      await clock.advance(250);
      await until(
        async () => (await checkpointCursor(store)) === cursorOf(4),
        'the new holder to store its first event'
      );
      assert.deepEqual(w.states(), ['connecting', 'standby', 'connecting', 'catchingUp']);

      w.abort();
      const result = await resultOf(done);
      assert.equal(result.outcome, 'aborted');
      assert.equal(result.stored, 1, 'only what this process stored counts as stored');
      assert.deepEqual(
        deps.calls.runEvents.map(event => (event.type === 'start' ? event.from : event.type)),
        ['standby', 'end'],
        'one start and one end for the run, whatever happened in between'
      );
    } finally {
      await foreign.die();
      await holder.release();
    }
  });
});

test('a drain that finds the lease held ends at once with capturedElsewhere', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const holder = await openWriter(openStore(root), 'vscode');
    try {
      const { transport, deps, hub } = setup();
      const w = watcher({ follow: false });

      const result = await resultOf(hub.watch(store, w.watcher, deps));

      assert.equal(result.outcome, 'capturedElsewhere');
      assert.equal(transport.attempts.length, 0);
      assert.equal(result.delivered, 0);
      assert.deepEqual(w.states(), ['connecting', 'standby']);
    } finally {
      await holder.release();
    }
  });
});

test('a lease taken away mid-run sends the run to standby, drops the batch it could not checkpoint, and resumes from the last good checkpoint', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const foreign = await foreignHolder(root);
    let advances = 0;
    const guarded = instrumentStore(store, {
      advance: () => {
        advances += 1;
        if (advances === 1) {
          foreign.plant();
          throw new LeaseLostError();
        }
      }
    });
    try {
      const { clock, transport, deps, hub } = setup();
      const w = watcher({ follow: true });
      const done = hub.watch(guarded, w.watcher, deps);
      const first = await transport.opened(0);
      first.subscribed();
      first.events(busEvent(3));
      await clock.advance(250);
      await until(() => w.states().includes('standby'), 'the standby state after the lease was lost');
      assert.equal(first.aborted, true, 'the old subscription is gone');
      assert.equal(await checkpointCursor(store), cursorOf(2), 'the checkpoint that was lost was never written');

      await foreign.die();
      await until(() => clock.pending > 0, 'the standby poll');
      await clock.advance(2_000);
      const second = await transport.opened(1);
      assert.deepEqual(second.from, { kind: 'after', cursor: cursorOf(2) });
      assert.equal(second.durableCursor(), cursorOf(2));
      w.abort();
      assert.equal((await resultOf(done)).outcome, 'aborted');
    } finally {
      await foreign.die();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// telemetry

test('a run reports one start and one end with bounded fields, however many watchers it had', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1)]);
    const { clock, transport, deps, hub } = setup();
    const first = watcher({ follow: true });
    const second = watcher({ follow: true }, { source: eventSource('second') });
    const firstDone = hub.watch(store, first.watcher, deps);
    const attempt = await transport.opened(0);
    const secondDone = hub.watch(store, second.watcher, deps);
    attempt.subscribed();
    attempt.events(busEvent(2), busEvent(3));
    await clock.advance(250);
    await until(async () => (await checkpointCursor(store)) === cursorOf(3), 'the flush');
    deps.calls.hooks?.onDropped(2);
    first.abort();
    second.abort();
    await resultOf(firstDone);
    await resultOf(secondDone);

    const [start, end, ...rest] = deps.calls.runEvents;
    assert.deepEqual(rest, []);
    assert.deepEqual(start, { type: 'start', from: 'position' });
    assert.ok(end?.type === 'end');
    assert.deepEqual(Object.keys(end).sort(), [
      'delivered',
      'dropped',
      'durationMs',
      'gaps',
      'outcome',
      'reconnects',
      'stored',
      'type'
    ]);
    assert.deepEqual(
      {
        outcome: end.outcome,
        delivered: end.delivered,
        stored: end.stored,
        gaps: end.gaps,
        reconnects: end.reconnects,
        dropped: end.dropped
      },
      { outcome: 'aborted', delivered: 2, stored: 2, gaps: 0, reconnects: 0, dropped: 2 }
    );
    assert.ok(end.durationMs >= 250);
  });
});
