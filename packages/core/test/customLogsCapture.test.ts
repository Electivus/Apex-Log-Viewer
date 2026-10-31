import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { AlvError } from '../src/errors.ts';
import type { CustomLogCaptureResult } from '../src/customLogs/contracts.ts';
import { customLogError } from '../src/customLogs/errors.ts';
import { createCaptureHub, type CaptureHub } from '../src/customLogs/events/capture.ts';
import { FLUSH_MAX } from '../src/customLogs/events/captureRules.ts';
import type { EventStore } from '../src/customLogs/events/store.ts';
import type { TransportFailure } from '../src/customLogs/events/transport.ts';
import {
  CHANNEL,
  ManualClock,
  busEvent,
  captureDeps,
  cursorOf,
  fakeTransport,
  instrumentStore,
  openStore,
  openWriter,
  readStored,
  seedCheckpoint,
  until,
  uuidOf,
  watcher,
  withProject,
  within,
  type DepsOptions
} from './support/captureHarness.ts';

const HOUR = 3_600_000;

type Settled = { result: CustomLogCaptureResult } | { error: unknown };

/**
 * A real store is older than its checkpoint: the checkpoint is rewritten at the clean end of every run, minutes or
 * days after the files it covers were written. Freshly seeded files sit within the writer's mtime slack of
 * `updatedAt` and hide that, so a test that depends on history being old ages it.
 */
function ageStoredFiles(store: EventStore, hours = 1): void {
  const past = new Date(Date.now() - hours * HOUR);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name.endsWith('.ndjson')) fs.utimesSync(entryPath, past, past);
    }
  };
  walk(store.eventsRoot);
}

/** The outcome of a `watch` that may reject, observed without leaving a rejection unhandled. */
const settledOf = (promise: Promise<CustomLogCaptureResult>): Promise<Settled> =>
  promise.then(
    result => ({ result }),
    (error: unknown) => ({ error })
  );

function resultOf(settled: Settled): CustomLogCaptureResult {
  assert.ok('result' in settled, `the run failed: ${'error' in settled ? String(settled.error) : ''}`);
  return settled.result;
}

function errorOf(settled: Settled): AlvError {
  assert.ok('error' in settled, 'the run was expected to fail');
  assert.ok(settled.error instanceof AlvError, `an AlvError, got ${String(settled.error)}`);
  return settled.error;
}

const checkpointCursor = async (store: EventStore) => (await store.checkpoint())?.cursor;

/** Event lines on disk, counting a re-stored copy that the readers would merge into one row. */
function storedLines(store: EventStore): number {
  return fs
    .readdirSync(store.eventsRoot, { recursive: true, encoding: 'utf8' })
    .filter(file => /^\d{4}-\d{2}-\d{2}[\\/]\d{2}\.[0-9a-f]{8}\.ndjson$/.test(file))
    .reduce(
      (count, file) =>
        count + fs.readFileSync(path.join(store.eventsRoot, file), 'utf8').split('\n').filter(Boolean).length,
      0
    );
}

async function tick(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 5));
}

function setup(store: EventStore, options: Partial<Omit<DepsOptions, 'store'>> = {}) {
  const clock = options.clock ?? new ManualClock();
  const transport = options.transport ?? fakeTransport();
  const deps = captureDeps({ ...options, store, clock, transport });
  const hub: CaptureHub = createCaptureHub();
  return { clock: clock as ManualClock, transport, deps, hub };
}

// ---------------------------------------------------------------------------------------------
// start point, durable resume, first use

test('a drain resumes after the stored cursor, stores what follows exactly, and ends quiet', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: false });

    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    assert.deepEqual(attempt.from, { kind: 'after', cursor: cursorOf(2) });
    assert.equal(
      attempt.durableCursor(),
      cursorOf(2),
      'before the first flush the run answers with the stored position'
    );
    attempt.subscribed();
    attempt.events(busEvent(3), busEvent(4), busEvent(5));
    await clock.advance(250);
    await until(
      async () => (await checkpointCursor(store)) === cursorOf(5),
      'the checkpoint at the last delivered event'
    );
    await until(() => attempt.durableCursor() === cursorOf(5), 'the adapter to resume from the flushed position');
    await until(() => w.rows().length === 3, 'the stored rows to reach the watcher');
    await clock.advance(10_000);

    const result = resultOf(await settledOf(done));
    assert.equal(result.outcome, 'quiet');
    assert.equal(result.delivered, 3);
    assert.equal(result.stored, 3);
    assert.deepEqual(result.newGaps, []);
    assert.equal(result.store.state, 'captured');
    assert.equal(result.store.state === 'captured' ? result.store.newest : undefined, busEvent(5).createdDate);
    assert.equal((await readStored(store)).length, 5);
    assert.deepEqual(w.rows(), ['message 3', 'message 4', 'message 5']);
    assert.deepEqual(w.states(), ['connecting', 'catchingUp', 'live'], 'a watcher that left is not told about the end');
  });
});

test('needsInitial writes the describe and reads the allowance but subscribes nothing', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { transport, deps, hub } = setup(store, { allowance: { remaining: 8_412, max: 10_000 } });
    const w = watcher({ follow: true, initial: 'none' });

    const result = resultOf(await settledOf(hub.watch(store.location, w.watcher, deps)));

    assert.equal(result.outcome, 'needsInitial');
    assert.equal(transport.attempts.length, 0);
    assert.equal(deps.calls.describes, 1);
    assert.equal(deps.calls.allowances, 1);
    assert.equal((await store.describe())?.name, 'App_Log__e');
    assert.equal(result.store.state, 'notCaptured');
    const last = w.updates[w.updates.length - 1]!;
    assert.deepEqual(last.allowance, { remaining: 8_412, max: 10_000, budget: 4_206 });
    assert.deepEqual(last.capture, { state: 'stopped', outcome: 'needsInitial' });
    assert.deepEqual(
      deps.calls.runEvents.map(event => event.type === 'start' && event.from),
      ['none', false]
    );
    await openWriter(store);
  });
});

test('an allowance /limits could not give falls back to the default budget and reports no remaining', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { deps, hub } = setup(store, { allowance: undefined });
    const w = watcher({ follow: false, initial: 'none' });
    resultOf(await settledOf(hub.watch(store.location, w.watcher, deps)));
    assert.deepEqual(w.updates[w.updates.length - 1]!.allowance, { budget: 5_000 });
  });
});

for (const initial of ['new', 'retained'] as const) {
  test(`a first run with initial ${initial} subscribes ${initial === 'new' ? 'from the end' : 'to everything Salesforce keeps'}`, async () => {
    await withProject(async root => {
      const store = openStore(root);
      const { transport, deps, hub } = setup(store);
      const w = watcher({ follow: true, initial });
      const done = hub.watch(store.location, w.watcher, deps);
      const attempt = await transport.opened(0);
      assert.deepEqual(attempt.from, { kind: initial });
      assert.equal(attempt.durableCursor(), undefined);
      w.abort();
      assert.equal(resultOf(await settledOf(done)).outcome, 'aborted');
    });
  });
}

test('a checkpoint of another org records an orgChanged gap before it subscribes, and starts as a first run', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1)], { orgId: '00D000000000009AAA' });
    const snapshots: Awaited<ReturnType<EventStore['coverage']>>[] = [];
    const transport = fakeTransport({ onOpen: async () => void snapshots.push(await store.coverage()) });
    const { deps, hub } = setup(store, { transport });
    const w = watcher({ follow: true, initial: 'retained' });
    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);

    assert.deepEqual(attempt.from, { kind: 'retained' });
    const [snapshot] = snapshots;
    assert.equal(snapshot?.state === 'captured' ? snapshot.gaps[0]?.reason : undefined, 'orgChanged');
    w.abort();
    const result = resultOf(await settledOf(done));
    assert.deepEqual(
      result.newGaps.map(gap => gap.reason),
      ['orgChanged']
    );
  });
});

// ---------------------------------------------------------------------------------------------
// gaps

test('a rejected cursor writes the gap before the retained resubscribe, closes it at the first newer stored event, and counts the overlap as delivered', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    ageStoredFiles(store);
    const snapshots: Awaited<ReturnType<EventStore['coverage']>>[] = [];
    const transport = fakeTransport({ onOpen: async () => void snapshots.push(await store.coverage()) });
    const { clock, deps, hub } = setup(store, { transport });
    const w = watcher({ follow: false });

    const done = hub.watch(store.location, w.watcher, deps);
    const first = await transport.opened(0);
    first.subscribed();
    first.fail({ kind: 'cursorRejected' });
    const retained = await transport.opened(1);

    assert.deepEqual(retained.from, { kind: 'retained' });
    assert.equal(retained.durableCursor(), undefined, 'a rejected position is forgotten');
    const [before, atRetry] = snapshots;
    assert.deepEqual(before?.state === 'captured' ? before.gaps : undefined, []);
    assert.deepEqual(
      atRetry?.state === 'captured'
        ? atRetry.gaps.map(({ reason, after, before: closed }) => ({ reason, after, closed }))
        : undefined,
      [{ reason: 'cursorRejected', after: busEvent(2).createdDate, closed: undefined }],
      'the gap is on disk when the resubscribe happens'
    );

    retained.subscribed();
    retained.events(busEvent(1), busEvent(2), busEvent(3));
    await clock.advance(250);
    await until(
      async () => (await checkpointCursor(store)) === cursorOf(3),
      'the checkpoint at the retained replay tail'
    );
    await clock.advance(10_000);

    const result = resultOf(await settledOf(done));
    assert.equal(result.delivered, 3, 'the overlap was delivered and paid for');
    assert.equal(result.stored, 1, 'the store dropped the two it held');
    assert.deepEqual(
      result.newGaps.map(gap => [gap.reason, gap.after]),
      [['cursorRejected', busEvent(2).createdDate]]
    );
    assert.equal(result.store.state === 'captured' ? result.store.gaps[0]?.before : undefined, busEvent(3).createdDate);
    assert.deepEqual(w.states(), ['connecting', 'catchingUp', 'reconnecting', 'catchingUp', 'live']);
  });
});

test('a rejected cursor drops the replayed events of the whole retention window, across a day boundary', async () => {
  await withProject(async root => {
    const now = Date.parse('2026-10-31T00:20:00.000Z');
    const held = [
      busEvent(1, { createdMs: now - 71 * HOUR - 50 * 60_000 }),
      busEvent(2, { createdMs: now - 40 * 60_000 }),
      busEvent(3, { createdMs: now - 10 * 60_000 })
    ];
    const store = openStore(root);
    await seedCheckpoint(store, held);
    ageStoredFiles(store);
    const { clock, transport, deps, hub } = setup(store, { clock: new ManualClock(now) });
    const w = watcher({ follow: false });

    const done = hub.watch(store.location, w.watcher, deps);
    const first = await transport.opened(0);
    first.subscribed();
    first.fail({ kind: 'cursorRejected' });
    const retained = await transport.opened(1);
    retained.subscribed();
    retained.events(...held, busEvent(4, { createdMs: now - 60_000 }));
    await clock.advance(250);
    await until(async () => (await checkpointCursor(store)) === cursorOf(4), 'the checkpoint at the replay tail');
    await clock.advance(10_000);

    const result = resultOf(await settledOf(done));
    assert.equal(result.delivered, 4);
    assert.equal(result.stored, 1, 'only the event the store did not hold');
    assert.equal(storedLines(store), 4, 'one line per event on disk');
  });
});

test('a rejected cursor whose recovery brings nothing leaves the gap open and advances nothing', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const before = await store.checkpoint();
    const advanced: string[] = [];
    const guarded = instrumentStore(store, { advanced: cursor => advanced.push(cursor) });
    const { clock, transport, deps, hub } = setup(guarded);
    const w = watcher({ follow: false });

    const done = hub.watch(guarded.location, w.watcher, deps);
    const first = await transport.opened(0);
    first.subscribed();
    first.fail({ kind: 'cursorRejected' });
    const retained = await transport.opened(1);
    retained.subscribed();
    await clock.advance(120_000);

    const result = resultOf(await settledOf(done));
    assert.equal(result.outcome, 'quiet', 'the drain waited its whole bound for a first event that never came');
    assert.equal(result.delivered, 0);
    assert.deepEqual(
      result.store.state === 'captured' ? result.store.gaps.map(gap => [gap.reason, gap.after, gap.before]) : undefined,
      [['cursorRejected', busEvent(2).createdDate, undefined]]
    );
    assert.deepEqual(advanced, [], 'no position, so no clean-end advance');
    assert.deepEqual(await store.checkpoint(), before);
  });
});

test('a rejected resubscribe after the first checkpoint opens the same gap and falls back to retained', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const snapshots: Awaited<ReturnType<EventStore['coverage']>>[] = [];
    const transport = fakeTransport({ onOpen: async () => void snapshots.push(await store.coverage()) });
    const { clock, deps, hub } = setup(store, { transport });
    const w = watcher({ follow: true });

    const done = hub.watch(store.location, w.watcher, deps);
    const first = await transport.opened(0);
    first.subscribed();
    first.events(busEvent(3));
    await clock.advance(250);
    await until(async () => (await checkpointCursor(store)) === cursorOf(3), 'the first checkpoint of the run');
    first.fail({ kind: 'cursorRejected' });
    const retained = await transport.opened(1);

    assert.deepEqual(retained.from, { kind: 'retained' });
    const atRetry = snapshots[1];
    assert.deepEqual(
      atRetry?.state === 'captured' ? atRetry.gaps.map(gap => [gap.reason, gap.after]) : undefined,
      [['cursorRejected', busEvent(3).createdDate]],
      'the gap starts after the newest event the run itself stored'
    );
    w.abort();
    assert.equal(resultOf(await settledOf(done)).newGaps.length, 1);
  });
});

test('a second rejected cursor in one run fails it with CUSTOM_LOG_CAPTURE_FAILED', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: true });

    const settled = settledOf(hub.watch(store.location, w.watcher, deps));
    const first = await transport.opened(0);
    first.subscribed();
    first.fail({ kind: 'cursorRejected' });
    const retained = await transport.opened(1);
    retained.subscribed();
    retained.events(busEvent(3));
    await clock.advance(250);
    await until(
      async () => (await checkpointCursor(store)) === cursorOf(3),
      'the checkpoint after the retained replay'
    );
    retained.fail({ kind: 'cursorRejected' });

    const error = errorOf(await settled);
    assert.equal(error.code, 'CUSTOM_LOG_CAPTURE_FAILED');
    assert.match(error.message, /retained replay/);
    const last = w.updates[w.updates.length - 1]!;
    assert.equal(last.capture.state, 'failed');
    assert.deepEqual(
      deps.calls.runEvents.map(event => (event.type === 'end' ? [event.outcome, event.code, event.gaps] : event.from)),
      ['position', ['failed', 'CUSTOM_LOG_CAPTURE_FAILED', 1]]
    );
    await openWriter(store);
  });
});

test('a gap found open at start is not new, whether the start decides it again or not', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const stale = () => new ManualClock(Date.now() + 73 * HOUR);

    const snapshots: Awaited<ReturnType<EventStore['coverage']>>[] = [];
    const first = fakeTransport({ onOpen: async () => void snapshots.push(await store.coverage()) });
    const run1 = setup(store, { clock: stale(), transport: first });
    const w1 = watcher({ follow: true });
    const done1 = run1.hub.watch(store.location, w1.watcher, run1.deps);
    const attempt1 = await first.opened(0);
    const durable = snapshots[0];
    assert.deepEqual(
      durable?.state === 'captured' ? durable.gaps.map(gap => gap.reason) : undefined,
      ['retentionElapsed'],
      'the retention gap is durable before the first subscribe'
    );
    assert.deepEqual(
      attempt1.from,
      { kind: 'after', cursor: cursorOf(2) },
      'the server is still asked, from the stored cursor'
    );
    w1.abort();
    assert.deepEqual(
      resultOf(await settledOf(done1)).newGaps.map(gap => gap.reason),
      ['retentionElapsed']
    );

    const second = fakeTransport();
    const run2 = setup(store, { clock: stale(), transport: second });
    const w2 = watcher({ follow: true });
    const done2 = run2.hub.watch(store.location, w2.watcher, run2.deps);
    await second.opened(0);
    w2.abort();
    const result2 = resultOf(await settledOf(done2));
    assert.deepEqual(result2.newGaps, [], 'the open gap is reported by the store, not as new');
    assert.equal(result2.store.state === 'captured' ? result2.store.gaps.length : undefined, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// durability: flush before emit, single flight, abort

test('a row reaches a watcher only after the append that stores it resolved', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const guarded = instrumentStore(store, {
      append: async () => {
        log.push('append started');
        await gate;
      },
      appended: () => log.push('append resolved')
    });
    const { clock, transport, deps, hub } = setup(guarded);
    const w = watcher({ follow: true, initial: 'new' });

    const done = hub.watch(guarded.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1));
    await clock.advance(250);
    await until(() => log.includes('append started'), 'the flush to reach append');
    await tick();

    assert.deepEqual(w.rows(), [], 'nothing is shown while the batch is not on disk');
    assert.equal((await readStored(store)).length, 0);
    release();
    await until(() => w.rows().length === 1, 'the row after the append');
    assert.deepEqual(log, ['append started', 'append resolved']);
    assert.equal((await readStored(store)).length, 1);
    w.abort();
    resultOf(await settledOf(done));
  });
});

test('flushes are single-flight: advance calls land in the order append calls complete', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let appends = 0;
    const guarded = instrumentStore(store, {
      append: async events => {
        log.push(`append ${events.length}`);
        if (appends++ === 0) await gate;
      },
      appended: events => log.push(`appended ${events.length}`),
      advance: cursor => void log.push(`advance ${cursor}`)
    });
    const { clock, transport, deps, hub } = setup(guarded);
    const w = watcher({ follow: true, initial: 'new' });

    const done = hub.watch(guarded.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1));
    await clock.advance(250);
    await until(() => log.length === 1, 'the first flush to reach append');
    attempt.events(busEvent(2), busEvent(3));
    await clock.advance(250);
    await tick();
    assert.deepEqual(log, ['append 1'], 'a second flush waits for the first instead of appending beside it');

    release();
    await until(async () => (await checkpointCursor(store)) === cursorOf(3), 'both flushes to be checkpointed');
    assert.deepEqual(log, [
      'append 1',
      'appended 1',
      `advance ${cursorOf(1)}`,
      'append 2',
      'appended 2',
      `advance ${cursorOf(3)}`
    ]);
    w.abort();
    resultOf(await settledOf(done));
  });
});

test('a flush that finds the queue drained advances nothing', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const advanced: string[] = [];
    const guarded = instrumentStore(store, { advance: cursor => void advanced.push(cursor) });
    const { clock, transport, deps, hub } = setup(guarded);
    const w = watcher({ follow: true, initial: 'new' });

    const done = hub.watch(guarded.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1));
    await clock.advance(250);
    await until(async () => (await checkpointCursor(store)) === cursorOf(1), 'the first checkpoint');
    w.abort();
    const result = resultOf(await settledOf(done));

    assert.equal(result.outcome, 'aborted');
    assert.deepEqual(advanced, [cursorOf(1)], 'the stop-time flush found nothing queued, and the run was not live');
  });
});

test('an abort during a flush still stores and checkpoints the batch, and the checkpoint never passes stored data', async () => {
  for (const gated of ['append', 'advance'] as const) {
    await withProject(async root => {
      const store = openStore(root);
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      let reached = false;
      const hold = async () => {
        reached = true;
        await gate;
      };
      const guarded = instrumentStore(store, gated === 'append' ? { append: hold } : { advance: hold });
      const { clock, transport, deps, hub } = setup(guarded);
      const w = watcher({ follow: true, initial: 'new' });

      const settled = settledOf(hub.watch(guarded.location, w.watcher, deps));
      const attempt = await transport.opened(0);
      attempt.subscribed();
      attempt.events(busEvent(1), busEvent(2));
      await clock.advance(250);
      await until(() => reached, `the flush to reach ${gated}`);
      w.abort();
      await tick();

      const stored = (await readStored(store)).length;
      const cursor = await checkpointCursor(store);
      assert.equal(cursor, undefined, `while ${gated} is pending nothing is checkpointed`);
      assert.equal(stored, gated === 'append' ? 0 : 2, 'checkpoint (none) is at or below stored data');
      release();
      const result = resultOf(await settled);
      assert.equal(result.outcome, 'aborted');
      assert.equal(result.stored, 2);
      assert.equal(await checkpointCursor(store), cursorOf(2));
      assert.equal((await readStored(store)).length, 2);
    });
  }
});

test('a duplicate-only batch stores nothing but still moves the resume point', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: true });

    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1, { cursor: 1_003 }), busEvent(2, { cursor: 1_004 }));
    await clock.advance(250);
    await until(async () => (await checkpointCursor(store)) === cursorOf(4), 'the position of the duplicates');
    w.abort();
    const result = resultOf(await settledOf(done));

    assert.equal(result.delivered, 2);
    assert.equal(result.stored, 0);
    assert.deepEqual(w.rows(), []);
    assert.equal((await readStored(store)).length, 2);
  });
});

// ---------------------------------------------------------------------------------------------
// clean end and drain bound

const updatedAtOf = async (store: EventStore) => (await store.checkpoint())?.updatedAt;

test('the clean end of a live run that stored nothing re-sends the position seeded from the checkpoint, with the coverage it proved', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const seeded = await store.checkpoint();
    await tick();
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: false });

    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    await clock.advance(15_000);
    const result = resultOf(await settledOf(done));

    assert.equal(result.outcome, 'quiet');
    const after = await store.checkpoint();
    assert.ok(after && seeded && after.updatedAt > seeded.updatedAt, 'updatedAt moved');
    assert.ok(
      after.coveredUntil && seeded.coveredUntil && after.coveredUntil >= seeded.coveredUntil,
      'coverage did not go back'
    );
    assert.ok(after.coveredUntil <= clock.now().toISOString(), 'and claims no time after the end');
    assert.deepEqual(
      { ...after, updatedAt: '', writer: '', coveredUntil: '' },
      { ...seeded, updatedAt: '', writer: '', coveredUntil: '' },
      'and nothing else did'
    );
    assert.equal(result.store.state === 'captured' ? result.store.lastCaptureAt : undefined, after.updatedAt);
  });
});

test('a flush followed by a clean end re-sends that flush, not the checkpoint read at start', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const advanced: string[] = [];
    const guarded = instrumentStore(store, { advanced: cursor => void advanced.push(cursor) });
    const { clock, transport, deps, hub } = setup(guarded);
    const w = watcher({ follow: false });

    const done = hub.watch(guarded.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(3));
    await clock.advance(250);
    await until(async () => (await checkpointCursor(store)) === cursorOf(3), 'the flush');
    await clock.advance(10_000);
    resultOf(await settledOf(done));

    assert.deepEqual(advanced, [cursorOf(3), cursorOf(3)]);
    const final = await store.checkpoint();
    assert.equal(final?.lastEvent.uuid, uuidOf(3));
  });
});

test('an abort while catching up leaves updatedAt alone, and an abort once live refreshes it', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const seeded = await updatedAtOf(store);
    await tick();

    const catching = setup(store);
    const w1 = watcher({ follow: true });
    const done1 = catching.hub.watch(store.location, w1.watcher, catching.deps);
    const a1 = await catching.transport.opened(0);
    a1.subscribed();
    w1.abort();
    assert.equal(resultOf(await settledOf(done1)).outcome, 'aborted');
    assert.equal(await updatedAtOf(store), seeded, 'undelivered backlog may remain, so nothing is confirmed');

    const live = setup(store);
    const w2 = watcher({ follow: true });
    const done2 = live.hub.watch(store.location, w2.watcher, live.deps);
    const a2 = await live.transport.opened(0);
    a2.subscribed();
    await live.clock.advance(15_000);
    assert.ok(w2.states().includes('live'));
    w2.abort();
    resultOf(await settledOf(done2));
    const refreshed = await updatedAtOf(store);
    assert.ok(seeded !== undefined && refreshed !== undefined && refreshed > seeded);
  });
});

test('a drain over a day-old cursor on a quiet stream waits its whole bound, ends quiet, and refreshes updatedAt', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const seeded = await updatedAtOf(store);
    await tick();
    const clock = new ManualClock(Date.now() + 24 * HOUR);
    const { transport, deps, hub } = setup(store, { clock });
    const w = watcher({ follow: false });

    let finished = false;
    const done = settledOf(hub.watch(store.location, w.watcher, deps)).then(settled => ((finished = true), settled));
    const attempt = await transport.opened(0);
    attempt.subscribed();
    await clock.advance(119_999);
    await tick();
    assert.equal(finished, false, 'the first event of a backlog can take that long');
    await clock.advance(1);
    const result = resultOf(await done);

    assert.equal(result.outcome, 'quiet');
    assert.deepEqual(result.newGaps, [], 'a day is inside the retention window');
    const refreshed = await updatedAtOf(store);
    assert.ok(seeded !== undefined && refreshed !== undefined && refreshed > seeded);
  });
});

test('a drain bound shorter than the young-cursor wait ends timeLimit and does not refresh updatedAt', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const seeded = await updatedAtOf(store);
    await tick();
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: false, maxDurationMs: 10_000 });

    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    await clock.advance(10_000);

    assert.equal(resultOf(await settledOf(done)).outcome, 'timeLimit');
    assert.equal(await updatedAtOf(store), seeded);
  });
});

test('a drain whose bound fires while events keep arriving ends timeLimit, and so does one that never saw the acknowledgement', async () => {
  await withProject(async root => {
    const store = openStore(root);
    await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
    const clock = new ManualClock(Date.now() + 24 * HOUR);
    const busy = setup(store, { clock });
    const w = watcher({ follow: false });

    const done = busy.hub.watch(store.location, w.watcher, busy.deps);
    const attempt = await busy.transport.opened(0);
    attempt.subscribed();
    for (let n = 3; n < 3 + 23; n += 1) {
      attempt.events(busEvent(n));
      await clock.advance(5_000);
    }
    await clock.advance(5_000);
    assert.equal(resultOf(await settledOf(done)).outcome, 'timeLimit');

    const silent = setup(store, { clock: new ManualClock() });
    const w2 = watcher({ follow: false });
    const done2 = silent.hub.watch(store.location, w2.watcher, silent.deps);
    await silent.transport.opened(0);
    await silent.clock.advance(120_000);
    assert.equal(resultOf(await settledOf(done2)).outcome, 'timeLimit');
  });
});

test('a drain stops at live when events arrive and then go quiet for 10 s', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: false, initial: 'retained' });

    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1), busEvent(2));
    await clock.advance(9_999);
    assert.ok(!w.states().includes('live'));
    attempt.events(busEvent(3));
    await clock.advance(9_999);
    assert.ok(!w.states().includes('live'), 'each batch restarts the quiet period');
    await clock.advance(1);
    assert.equal(resultOf(await settledOf(done)).outcome, 'quiet');
    assert.equal((await readStored(store)).length, 3);
  });
});

// ---------------------------------------------------------------------------------------------
// budget, queue bound, faults

test('a run that spends its budget flushes what it received, stops with outcome budget, and resumes next time', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup(store, { allowance: { remaining: 1_000, max: 10_000 } });
    const w = watcher({ follow: true, initial: 'retained' });

    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(...Array.from({ length: 300 }, (_, index) => busEvent(index + 1)));
    await clock.advance(1);
    assert.ok(!transport.attempts[0]!.aborted, '300 of 500 is within budget');
    attempt.events(...Array.from({ length: 300 }, (_, index) => busEvent(index + 301)));
    const result = resultOf(await within(settledOf(done), 'the run to stop at its budget'));

    assert.equal(result.outcome, 'budget');
    assert.equal(result.delivered, 600, 'the budget is checked when a response lands, so it can be exceeded by one');
    assert.equal(result.stored, 600);
    assert.equal(await checkpointCursor(store), cursorOf(600));
    assert.equal(attempt.aborted, true);
    assert.deepEqual(w.updates[w.updates.length - 1]!.capture, { state: 'stopped', outcome: 'budget' });
    assert.equal(w.updates[w.updates.length - 1]!.allowance?.budget, 500);
  });
});

for (const [label, remaining] of [
  ['nothing', 0],
  ['one delivery', 1]
] as const) {
  test(`an allowance of ${label} left gives a budget of zero: the run ends budget before it opens a transport`, async () => {
    await withProject(async root => {
      const store = openStore(root);
      await seedCheckpoint(store, [busEvent(1), busEvent(2)]);
      const { transport, deps, hub } = setup(store, { allowance: { remaining, max: 10_000 } });
      const w = watcher({ follow: true, initial: 'retained' });

      const result = resultOf(await within(settledOf(hub.watch(store.location, w.watcher, deps)), 'the budget stop'));

      assert.equal(result.outcome, 'budget');
      assert.equal(transport.attempts.length, 0, 'no subscription is opened, so Salesforce delivers nothing');
      assert.equal(result.delivered, 0);
      assert.equal(result.stored, 0);
      assert.deepEqual(result.newGaps, []);
      assert.equal(await checkpointCursor(store), cursorOf(2));
      const last = w.updates[w.updates.length - 1]!;
      assert.deepEqual(last.capture, { state: 'stopped', outcome: 'budget' });
      assert.equal(last.allowance?.budget, 0);
      await openWriter(store);
    });
  });
}

test('a drain with a budget of zero ends budget at once and reports one start and one end', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { transport, deps, hub } = setup(store, { allowance: { remaining: 1, max: 10_000 } });
    const w = watcher({ follow: false, initial: 'new' });

    const result = resultOf(await within(settledOf(hub.watch(store.location, w.watcher, deps)), 'the budget stop'));

    assert.equal(result.outcome, 'budget');
    assert.equal(transport.attempts.length, 0);
    assert.deepEqual(
      deps.calls.runEvents.map(event => event.type),
      ['start', 'end']
    );
  });
});

test('a replay response of 2,600 events, as measured on a real 10,000-event backlog, is stored without a reconnect', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { transport, deps, hub } = setup(store);
    const w = watcher({ follow: true, initial: 'retained' });

    const done = hub.watch(store.location, w.watcher, deps);
    const first = await transport.opened(0);
    first.subscribed();
    const count = 2_600;
    first.events(...Array.from({ length: count }, (_, index) => busEvent(index + 1, { bytes: 5_600 })));

    await until(async () => (await checkpointCursor(store)) === cursorOf(count), 'the checkpoint at the response tail');
    assert.equal(first.aborted, false, 'a response under the byte bound never stops the transport');
    assert.equal(
      w.updates.some(update => update.capture.state === 'reconnecting'),
      false
    );
    assert.equal((await readStored(store)).length, count);
    w.abort();
    assert.equal(resultOf(await settledOf(done)).delivered, count);
  });
});

test('a response past the queue byte bound aborts the transport, commits everything, and reopens from the committed cursor', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: true, initial: 'new' });

    const done = hub.watch(store.location, w.watcher, deps);
    const first = await transport.opened(0);
    first.subscribed();
    const megabytes = 16 * 1024 * 1024;
    first.events(
      busEvent(1, { bytes: megabytes }),
      busEvent(2, { bytes: megabytes }),
      busEvent(3, { bytes: megabytes })
    );
    await until(() => w.updates.some(update => update.capture.state === 'reconnecting'), 'the reconnect');
    await clock.advance(1_000);
    const second = await transport.opened(1);
    assert.deepEqual(second.from, { kind: 'after', cursor: cursorOf(3) });
    w.abort();
    assert.equal(resultOf(await settledOf(done)).stored, 3);
  });
});

const rebuild = async (w: ReturnType<typeof watcher>, attempt: number, backoffMs: number, clock: ManualClock) => {
  await until(
    () => w.updates.some(update => update.capture.state === 'reconnecting' && update.capture.attempt === attempt),
    `reconnecting attempt ${attempt}`
  );
  await clock.advance(backoffMs);
};

test('an auth rejection rebuilds the connection with backoff and fails after three rebuilds without a subscribed', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: true, initial: 'new' });

    const settled = settledOf(hub.watch(store.location, w.watcher, deps));
    for (const [index, backoff] of [1_000, 2_000, 5_000].entries()) {
      const attempt = await transport.opened(index);
      attempt.fail({ kind: 'authRejected' });
      await rebuild(w, index + 1, backoff, clock);
    }
    const last = await transport.opened(3);
    assert.deepEqual(
      w.updates.filter(update => update.capture.state === 'reconnecting').map(update => update.capture),
      [1, 2, 3].map(attempt => ({ state: 'reconnecting', attempt, cause: 'auth' }))
    );
    last.fail({ kind: 'authRejected' });

    const error = errorOf(await settled);
    assert.equal(error.code, 'CUSTOM_LOG_CAPTURE_FAILED');
    assert.match(error.message, /credentials/);
    assert.deepEqual(
      deps.calls.connects,
      [{ fresh: false }, { fresh: true }, { fresh: true }, { fresh: true }],
      'each rebuild evicts the cached connection'
    );
  });
});

test('a subscribed between auth rejections resets the rebuild count', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: true, initial: 'new' });

    const done = hub.watch(store.location, w.watcher, deps);
    const reconnects = () => w.updates.filter(update => update.capture.state === 'reconnecting').length;
    for (let index = 0; index < 5; index += 1) {
      const attempt = await transport.opened(index);
      attempt.subscribed();
      attempt.fail({ kind: 'authRejected' });
      await until(() => reconnects() === index + 1, `reconnect ${index + 1}`);
      await clock.advance(1_000);
      await until(() => transport.attempts.length === index + 2, 'the next attempt');
    }
    assert.notEqual(w.updates[w.updates.length - 1]!.capture.state, 'failed');
    w.abort();
    assert.equal(resultOf(await settledOf(done)).outcome, 'aborted');
    assert.equal(deps.calls.connects.filter(call => call.fresh).length, 5);
  });
});

type TerminalFailure = Exclude<TransportFailure, { kind: 'cursorRejected' | 'authRejected' }>;

const terminal: [string, TerminalFailure, string][] = [
  ['forbidden', { kind: 'forbidden', message: '403::Restricted channel' }, 'CUSTOM_LOG_SUBSCRIBE_FORBIDDEN'],
  [
    'clientLimit',
    { kind: 'clientLimit', message: '403::Organization concurrent user limit exceeded' },
    'CUSTOM_LOG_CLIENT_LIMIT'
  ],
  [
    'deliveryLimit',
    { kind: 'deliveryLimit', message: '403::Organization total events daily limit exceeded' },
    'CUSTOM_LOG_DELIVERY_LIMIT'
  ],
  ['other', { kind: 'other', message: 'socket hang up' }, 'CUSTOM_LOG_CAPTURE_FAILED']
];

for (const [label, failure, code] of terminal) {
  test(`a ${label} failure ends the run with ${code} after storing what it received`, async () => {
    await withProject(async root => {
      const store = openStore(root);
      const { transport, deps, hub } = setup(store);
      const w = watcher({ follow: true, initial: 'new' });

      const settled = settledOf(hub.watch(store.location, w.watcher, deps));
      const attempt = await transport.opened(0);
      attempt.subscribed();
      attempt.events(busEvent(1));
      attempt.fail(failure);

      const error = errorOf(await settled);
      assert.equal(error.code, code);
      assert.ok(error.message.includes(failure.message), 'the message carries what Salesforce said');
      assert.equal(await checkpointCursor(store), cursorOf(1), 'the event that arrived before the failure is on disk');
      assert.deepEqual(w.updates[w.updates.length - 1]!.capture, { state: 'failed', code, message: error.message });
      await openWriter(store);
    });
  });
}

test('a failed append ends the run with the store error and gives the lease back', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const guarded = instrumentStore(store, {
      append: () => {
        throw customLogError('CUSTOM_LOG_STORE_UNAVAILABLE', 'Appending to the day file failed.');
      }
    });
    const { clock, transport, deps, hub } = setup(guarded);
    const w = watcher({ follow: true, initial: 'new' });

    const settled = settledOf(hub.watch(guarded.location, w.watcher, deps));
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1));
    await clock.advance(250);

    assert.equal(errorOf(await settled).code, 'CUSTOM_LOG_STORE_UNAVAILABLE');
    assert.equal(await checkpointCursor(store), undefined, 'a batch that was not stored is not checkpointed');
    await openWriter(store);
  });
});

test('a connect failure rejects with that error, reports failed, and subscribes nothing', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const refusal = new AlvError('ORG_NOT_FOUND', 'No authorized org matches dev@example.com.');
    const { transport, deps, hub } = setup(store, {
      connect: async () => {
        throw refusal;
      }
    });
    const w = watcher({ follow: true });

    const settled = await settledOf(hub.watch(store.location, w.watcher, deps));

    assert.equal(errorOf(settled), refusal);
    assert.equal(transport.attempts.length, 0);
    assert.equal(w.updates[w.updates.length - 1]!.capture.state, 'failed');
    assert.deepEqual(
      deps.calls.runEvents.map(event => (event.type === 'end' ? [event.outcome, event.code] : event.from)),
      ['none', ['failed', 'ORG_NOT_FOUND']]
    );
    await openWriter(store);
  });
});

test('a transport that drops and recovers reports reconnecting and catchingUp, and counts the reconnect', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup(store);
    const w = watcher({ follow: true, initial: 'new' });

    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    await clock.advance(15_000);
    attempt.emit({ type: 'down' });
    attempt.emit({ type: 'up' });
    w.abort();
    const result = resultOf(await settledOf(done));

    assert.equal(result.outcome, 'aborted');
    assert.deepEqual(w.states(), ['connecting', 'catchingUp', 'live', 'reconnecting', 'catchingUp']);
    const end = deps.calls.runEvents.find(event => event.type === 'end');
    assert.ok(end?.type === 'end');
    assert.equal(end.reconnects, 1);
  });
});

test('a delivery the transport could not read becomes a gap between its neighbours, written before the checkpoint passes it', async () => {
  await withProject(async root => {
    const store = openStore(root);
    let atPass: Awaited<ReturnType<EventStore['coverage']>> | undefined;
    const guarded = instrumentStore(store, {
      advance: async cursor => {
        if (cursor === cursorOf(3)) atPass = await store.coverage();
      }
    });
    const { clock, transport, deps, hub } = setup(guarded);
    const w = watcher({ follow: true, initial: 'new' });

    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1));
    attempt.emit({ type: 'malformed' });
    attempt.events(busEvent(3));
    await clock.advance(250);
    await until(
      async () => (await checkpointCursor(store)) === cursorOf(3),
      'the checkpoint past the unreadable delivery'
    );
    w.abort();
    const result = resultOf(await settledOf(done));

    assert.deepEqual(
      atPass?.state === 'captured' ? atPass.gaps.map(gap => [gap.reason, gap.after, gap.before]) : atPass,
      [['malformedEvent', busEvent(1).createdDate, undefined]],
      'the gap was open on disk when the checkpoint moved to the event after it'
    );
    assert.equal(result.delivered, 3, 'the unreadable delivery still cost an allowance unit');
    assert.equal(result.stored, 2);
    assert.deepEqual(
      result.newGaps.map(gap => [gap.reason, gap.after]),
      [['malformedEvent', busEvent(1).createdDate]]
    );
    assert.deepEqual(
      result.store.state === 'captured' ? result.store.gaps.map(gap => [gap.reason, gap.after, gap.before]) : [],
      [['malformedEvent', busEvent(1).createdDate, busEvent(3).createdDate]],
      'the next stored event closes the gap'
    );
    assert.deepEqual((await readStored(store)).map(event => event.createdDate).sort(), [
      busEvent(1).createdDate,
      busEvent(3).createdDate
    ]);
    const end = deps.calls.runEvents.find(event => event.type === 'end');
    assert.ok(end?.type === 'end');
    assert.deepEqual([end.delivered, end.stored, end.gaps, end.dropped], [3, 2, 1, 1]);
  });
});

test('an event delivered after an unreadable one waits for its gap even when a full batch is already scheduled', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const after = busEvent(FLUSH_MAX + 2);
    const advanced: string[] = [];
    let atPass: Awaited<ReturnType<EventStore['coverage']>> | undefined;
    const guarded = instrumentStore(store, {
      advance: async cursor => {
        if (cursor === after.cursor) atPass = await store.coverage();
      },
      advanced: cursor => void advanced.push(cursor)
    });
    const { clock, transport, deps, hub } = setup(guarded);
    const w = watcher({ follow: true, initial: 'new' });

    const done = hub.watch(store.location, w.watcher, deps);
    const attempt = await transport.opened(0);
    attempt.subscribed();
    attempt.events(...Array.from({ length: FLUSH_MAX }, (_, index) => busEvent(index + 1)));
    attempt.emit({ type: 'malformed' });
    attempt.events(after);
    await clock.advance(250);
    await until(() => advanced.includes(after.cursor), 'the checkpoint at the event after the gap');
    w.abort();
    const result = resultOf(await settledOf(done));

    assert.deepEqual(advanced, [cursorOf(FLUSH_MAX), after.cursor], 'the checkpoint only moves forward');
    assert.deepEqual(
      atPass?.state === 'captured' ? atPass.gaps.map(gap => [gap.reason, gap.after, gap.before]) : atPass,
      [['malformedEvent', busEvent(FLUSH_MAX).createdDate, undefined]],
      'the gap was on disk when the checkpoint passed it'
    );
    assert.deepEqual(
      result.store.state === 'captured' ? result.store.gaps.map(gap => gap.before) : [],
      [after.createdDate],
      'the event after the gap closes it'
    );
  });
});

test('bytes waiting behind a held write still count toward the queue bound', async () => {
  await withProject(async root => {
    const store = openStore(root);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let appends = 0;
    const guarded = instrumentStore(store, {
      append: async () => {
        if (appends++ === 0) await gate;
      }
    });
    const { clock, transport, deps, hub } = setup(guarded);
    const w = watcher({ follow: true, initial: 'new' });

    const done = hub.watch(store.location, w.watcher, deps);
    const first = await transport.opened(0);
    first.subscribed();
    first.events(busEvent(1));
    await clock.advance(250);
    await until(() => appends === 1, 'the first write to hold');
    const megabytes = 20 * 1024 * 1024;
    first.events(busEvent(2, { bytes: megabytes }));
    await clock.advance(250);
    await tick();
    first.events(busEvent(3, { bytes: megabytes }));
    await until(() => first.aborted, 'the queue bound to abort the transport while the write is held');

    release();
    await until(() => w.updates.some(update => update.capture.state === 'reconnecting'), 'the reconnect');
    await clock.advance(1_000);
    const second = await transport.opened(1);
    assert.deepEqual(second.from, { kind: 'after', cursor: cursorOf(3) });
    w.abort();
    assert.equal(resultOf(await settledOf(done)).stored, 3);
  });
});

test('an unreadable delivery that nothing follows leaves its gap open and the checkpoint before it, and the next run closes the gap once', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const { clock, transport, deps, hub } = setup(store);
    const first = watcher({ follow: true, initial: 'new' });

    const firstDone = hub.watch(store.location, first.watcher, deps);
    const firstAttempt = await transport.opened(0);
    firstAttempt.subscribed();
    firstAttempt.events(busEvent(1));
    firstAttempt.emit({ type: 'malformed' });
    await until(async () => (await store.coverage()).state === 'captured', 'the first flush');
    first.abort();
    const firstResult = resultOf(await settledOf(firstDone));

    assert.equal(await checkpointCursor(store), cursorOf(1), 'the checkpoint stays before the unreadable delivery');
    assert.deepEqual(
      firstResult.newGaps.map(gap => [gap.reason, gap.after]),
      [['malformedEvent', busEvent(1).createdDate]]
    );
    assert.deepEqual(
      firstResult.store.state === 'captured' ? firstResult.store.gaps.map(gap => gap.before) : [],
      [undefined],
      'nothing newer has arrived, so the gap is open'
    );

    const second = watcher({ follow: true });
    const secondDone = hub.watch(store.location, second.watcher, deps);
    const secondAttempt = await transport.opened(1);
    assert.deepEqual(secondAttempt.from, { kind: 'after', cursor: cursorOf(1) }, 'Salesforce redelivers it');
    secondAttempt.subscribed();
    secondAttempt.emit({ type: 'malformed' });
    secondAttempt.events(busEvent(3));
    await clock.advance(250);
    await until(async () => (await checkpointCursor(store)) === cursorOf(3), 'the checkpoint at the next event');
    second.abort();
    const secondResult = resultOf(await settledOf(secondDone));

    assert.deepEqual(secondResult.newGaps, [], 'the redelivered unreadable message is the same gap');
    assert.deepEqual(
      secondResult.store.state === 'captured' ? secondResult.store.gaps.map(gap => [gap.after, gap.before]) : [],
      [[busEvent(1).createdDate, busEvent(3).createdDate]]
    );
  });
});

test('the channel the run subscribes comes from the resolved source, so the adapter never builds it', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const seen: string[] = [];
    const transport = fakeTransport();
    const open = transport.transport.open.bind(transport.transport);
    transport.transport.open = params => {
      seen.push(params.channel);
      return open(params);
    };
    const { deps, hub } = setup(store, { transport });
    const w = watcher({ follow: true, initial: 'new' });
    const done = hub.watch(store.location, w.watcher, deps);
    await transport.opened(0);
    assert.deepEqual(seen, [CHANNEL]);
    w.abort();
    resultOf(await settledOf(done));
  });
});
