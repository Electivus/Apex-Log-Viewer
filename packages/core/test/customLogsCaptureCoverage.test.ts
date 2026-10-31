import assert from 'node:assert/strict';
import test from 'node:test';

import type { CustomLogCaptureResult } from '../src/customLogs/contracts.ts';
import { createCaptureHub } from '../src/customLogs/events/capture.ts';
import type { EventStore } from '../src/customLogs/events/store.ts';
import type { BusEvent } from '../src/customLogs/events/transport.ts';
import {
  ManualClock,
  busEvent,
  captureDeps,
  fakeTransport,
  openStore,
  seedCheckpoint,
  until,
  watcher,
  withProject,
  within,
  type DepsOptions,
  type Watch
} from './support/captureHarness.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/*
 * What a stored position proves about the events it does not hold. Salesforce keeps an event 72 hours and accepts an
 * expired replay id, then starts at the oldest event it still has, so a run that starts after the oldest undelivered
 * event expired can only say, with a gap, that events may be missing. Each scenario runs a first capture, then a
 * second one at a later time, and reads the gaps the second one reports.
 */

function setup(store: EventStore, clock: ManualClock, options: Partial<Omit<DepsOptions, 'store' | 'clock'>> = {}) {
  const transport = fakeTransport();
  const deps = captureDeps({ ...options, store, clock, transport });
  return { clock, transport, deps, hub: createCaptureHub() };
}

type Run = ReturnType<typeof setup>;

const outcomeOf = async (done: Promise<CustomLogCaptureResult>): Promise<CustomLogCaptureResult['outcome']> =>
  (await within(done, 'the run to end')).outcome;

const reasonsOf = (result: CustomLogCaptureResult): string[] => result.newGaps.map(gap => gap.reason);

/** The next run, started at `atMs`. It delivers `events` (the ones Salesforce still holds) or nothing, and ends `quiet`. */
async function laterDrain(store: EventStore, atMs: number, events: readonly BusEvent[] = []) {
  const { clock, transport, deps, hub } = setup(store, new ManualClock(atMs));
  const done = hub.watch(store.location, watcher({ follow: false }).watcher, deps);
  const attempt = await transport.opened(0);
  attempt.subscribed();
  if (events.length > 0) {
    attempt.events(...events);
    await clock.advance(250);
    const newest = events[events.length - 1]!;
    await until(async () => (await store.checkpoint())?.lastEvent.uuid === newest.uuid, 'the flush of the later run');
    await clock.advance(10_000);
  } else {
    await clock.advance(120_000);
  }
  const result = await within(done, 'the later run to end');
  assert.equal(result.outcome, 'quiet');
  return { result, started: attempt.from };
}

/** An earlier capture that stored two events, the newest created at `createdMs`. */
const seedAt = (store: EventStore, createdMs: number) =>
  seedCheckpoint(store, [busEvent(1, { createdMs: createdMs - 1_000 }), busEvent(2, { createdMs })]);

/** A first capture over a 71 hour old replay of 600 events that stops at its budget (500 deliveries). */
async function budgetStopInBacklog(store: EventStore, now: number) {
  const backlog = Array.from({ length: 600 }, (_, i) =>
    busEvent(i + 1, { createdMs: now - 71 * HOUR + (i + 1) * 1_000 })
  );
  const run = setup(store, new ManualClock(now), { allowance: { remaining: 1_000, max: 25_000 } });
  const done = run.hub.watch(store.location, watcher({ follow: true, initial: 'retained' }).watcher, run.deps);
  const attempt = await run.transport.opened(0);
  attempt.subscribed();
  attempt.events(...backlog);
  assert.equal(await outcomeOf(done), 'budget');
}

test('a budget stop in a backlog claims nothing past the last stored event, so a run after the next event expired records the loss', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const R = Date.now();
    await budgetStopInBacklog(store, R);
    const checkpoint = await store.checkpoint();
    assert.ok(checkpoint);

    const oldestRetained = busEvent(10_001, { createdMs: R - 70 * HOUR + 1 });
    const { result, started } = await laterDrain(store, R + 2 * HOUR, [oldestRetained]);

    assert.deepEqual(
      started,
      { kind: 'after', cursor: checkpoint.cursor },
      'Salesforce is asked from the stored cursor'
    );
    assert.deepEqual(reasonsOf(result), ['retentionElapsed']);
    const gap = result.store.state === 'captured' ? result.store.gaps[0] : undefined;
    assert.equal(gap?.after, checkpoint.lastEvent.createdDate);
    assert.equal(gap?.before, oldestRetained.createdDate, 'the first event Salesforce still had closes the gap');
  });
});

test('a budget stop raises no gap while the next undelivered event is still retained', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const R = Date.now();
    await budgetStopInBacklog(store, R);

    const { result } = await laterDrain(store, R + 30 * MINUTE, [
      busEvent(10_001, { createdMs: R - 71 * HOUR + 601_000 })
    ]);
    assert.deepEqual(result.newGaps, [], 'the oldest undelivered event is under 72 hours old: Salesforce still has it');
  });
});

test('an abort while catching up after one flush claims nothing past what the flush stored', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const R = Date.now();
    const first = setup(store, new ManualClock(R));
    const w = watcher({ follow: true, initial: 'retained' });
    const done = first.hub.watch(store.location, w.watcher, first.deps);
    const attempt = await first.transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1, { createdMs: R - 71 * HOUR }));
    await first.clock.advance(250);
    await until(async () => (await store.checkpoint()) !== undefined, 'the flush');
    w.abort();
    assert.equal(await outcomeOf(done), 'aborted');

    const { result } = await laterDrain(store, R + 2 * HOUR);
    assert.deepEqual(reasonsOf(result), ['retentionElapsed'], 'the backlog behind that flush is 73 hours old now');
  });
});

test('a quiet end after replayed events claims nothing past the last one, because a replay can pause', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const R = Date.now();
    const first = setup(store, new ManualClock(R));
    const done = first.hub.watch(store.location, watcher({ follow: false, initial: 'retained' }).watcher, first.deps);
    const attempt = await first.transport.opened(0);
    attempt.subscribed();
    attempt.events(busEvent(1, { createdMs: R - 71 * HOUR }), busEvent(2, { createdMs: R - 71 * HOUR + 1_000 }));
    await first.clock.advance(250);
    await until(async () => (await store.checkpoint()) !== undefined, 'the flush');
    await first.clock.advance(10_000);
    assert.equal(await outcomeOf(done), 'quiet', 'ten quiet seconds end the drain, and prove nothing');

    const { result } = await laterDrain(store, R + 2 * HOUR);
    assert.deepEqual(reasonsOf(result), ['retentionElapsed']);
  });
});

test('a drain that hears nothing through its first-event wait proves the store current: a stream captured daily raises no gap', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const R = Date.now();
    await seedAt(store, R - 2 * DAY);

    for (const day of [1, 2, 3, 4, 5]) {
      const { result } = await laterDrain(store, R + day * DAY);
      assert.deepEqual(result.newGaps, [], `day ${day}: the last event is ${day + 2} days old and nothing is missing`);
    }

    const { result } = await laterDrain(store, R + 5 * DAY + 73 * HOUR);
    assert.deepEqual(reasonsOf(result), ['retentionElapsed'], 'three days with no capture at all can lose events');
  });
});

for (const [maxDurationMs, gaps] of [
  [5_000, ['retentionElapsed']],
  [20_000, []]
] as const) {
  test(`a drain with --max-time ${maxDurationMs / 1000} over an old position ends quiet and ${gaps.length > 0 ? 'proves nothing' : 'proves the store current'}`, async () => {
    await withProject(async root => {
      const store = openStore(root);
      const R = Date.now();
      await seedAt(store, R - 12 * HOUR);

      const run = setup(store, new ManualClock(R + DAY));
      const done = run.hub.watch(store.location, watcher({ follow: false, maxDurationMs }).watcher, run.deps);
      const attempt = await run.transport.opened(0);
      attempt.subscribed();
      await run.clock.advance(maxDurationMs);
      assert.equal(await outcomeOf(done), 'quiet');

      const { result } = await laterDrain(store, R + DAY + 60 * HOUR);
      assert.deepEqual(reasonsOf(result), gaps, 'sixty hours later, a first event could take longer than the wait');
    });
  });
}

/** A follow run that opens at `R` over a position stored half an hour earlier, plays `script`, and is stopped. */
const sessions: { name: string; script(run: Run, R: number): Promise<void>; gaps: string[] }[] = [
  {
    name: 'a quiet stream, connected for 100 hours, confirms the position when the run ends',
    script: async ({ clock, transport }) => {
      (await transport.opened(0)).subscribed();
      await clock.advance(15_000);
      await clock.advance(100 * HOUR);
    },
    gaps: []
  },
  {
    name: 'an event after the silent start does not end the confirmation',
    script: async ({ clock, transport }, R) => {
      const attempt = await transport.opened(0);
      attempt.subscribed();
      await clock.advance(15_000);
      await clock.advance(HOUR);
      attempt.events(busEvent(3, { createdMs: R + HOUR }));
      await clock.advance(250);
      await clock.advance(99 * HOUR);
    },
    gaps: []
  },
  {
    name: 'a connection the transport reports down ends the confirmation at that moment',
    script: async ({ clock, transport }) => {
      const attempt = await transport.opened(0);
      attempt.subscribed();
      await clock.advance(15_000);
      await clock.advance(HOUR);
      attempt.emit({ type: 'down' });
      attempt.emit({ type: 'up' });
      await clock.advance(10_000);
      await clock.advance(99 * HOUR);
    },
    gaps: ['retentionElapsed']
  },
  {
    name: 'a start with a backlog never confirms, however long it stays connected',
    script: async ({ clock, transport }, R) => {
      const attempt = await transport.opened(0);
      attempt.subscribed();
      attempt.events(busEvent(3, { createdMs: R - 10 * MINUTE }));
      await clock.advance(250);
      await clock.advance(10_000);
      await clock.advance(100 * HOUR);
    },
    gaps: ['retentionElapsed']
  }
];

for (const session of sessions) {
  test(`a follow run: ${session.name}`, async () => {
    await withProject(async root => {
      const store = openStore(root);
      const R = Date.now();
      await seedAt(store, R - 30 * MINUTE);
      const run = setup(store, new ManualClock(R));
      const w: Watch = watcher({ follow: true });
      const done = run.hub.watch(store.location, w.watcher, run.deps);
      await session.script(run, R);
      w.abort();
      assert.equal(await outcomeOf(done), 'aborted');

      const { result } = await laterDrain(store, R + 100 * HOUR + 70 * HOUR);
      assert.deepEqual(reasonsOf(result), session.gaps);
    });
  });
}
