import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import type { Connection } from '@salesforce/core';

import { cometdCursor, parseEventUuid, type ReplayCursor } from '../src/customLogs/events/ids.ts';
import {
  classifyFailure,
  createCometdTransport,
  parseCometdEvent,
  replayValueFor,
  type CometdTransportOptions
} from '../src/customLogs/events/cometd.ts';
import {
  TransportError,
  type BusEvent,
  type ReplayFrom,
  type TransportFailure,
  type TransportSignal
} from '../src/customLogs/events/transport.ts';
import { recordedEvents, startBayeuxDouble, type DoubleScript } from './support/cometdDouble.ts';
import { isolateSalesforceHome, openConnection } from './support/salesforceDouble.ts';

isolateSalesforceHome();
// Faye reads http_proxy and ignores NO_PROXY, so a proxied machine would send the loopback double's traffic away.
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;

const CHANNEL = '/event/ALV_Test_Log__e';
const BURST = recordedEvents('burst-870');
const INVALID_REPLAY =
  '400::The replayId {999} you provided was invalid.  Please provide a valid ID, -2 to replay all events, or -1 to replay only new events.';

type Run = {
  signals: TransportSignal[];
  /** Milliseconds since the run started, per signal. */
  at: number[];
  finished: Promise<void>;
  /** Waits until `ready(signals)` holds; rejects after `timeoutMs`. */
  until(ready: (signals: readonly TransportSignal[]) => boolean, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
};

type RunOptions = {
  from?: ReplayFrom;
  durableCursor?: () => ReplayCursor | undefined;
  transport?: CometdTransportOptions;
};

async function openRun(t: test.TestContext, script: DoubleScript, options: RunOptions = {}) {
  let run: Run | undefined;
  // Registered before the double's own hook, so the subscription stops while the server still answers.
  t.after(() => run?.stop().catch(() => undefined));
  const double = await startBayeuxDouble(t, script);
  run = startRun(await openConnection(double.username), options);
  return { double, run };
}

function startRun(connection: Connection, options: RunOptions): Run {
  const abort = new AbortController();
  const signals: TransportSignal[] = [];
  const at: number[] = [];
  const waiting = new Set<() => void>();
  const startedAt = performance.now();
  const finished = createCometdTransport(options.transport).open({
    connection,
    channel: CHANNEL,
    from: options.from ?? { kind: 'new' },
    durableCursor: options.durableCursor ?? (() => undefined),
    signal: abort.signal,
    onSignal: signal => {
      signals.push(signal);
      at.push(performance.now() - startedAt);
      waiting.forEach(wake => wake());
    }
  });
  finished.catch(() => undefined);
  return {
    signals,
    at,
    finished,
    until: (ready, timeoutMs = 5_000) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out; saw ${JSON.stringify(signals.map(s => s.type))}`)),
          timeoutMs
        );
        const check = () => {
          if (!ready(signals)) return;
          clearTimeout(timer);
          waiting.delete(check);
          resolve();
        };
        waiting.add(check);
        check();
      }),
    stop: async () => {
      abort.abort();
      await finished;
    }
  };
}

async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const eventBatches = (signals: readonly TransportSignal[]): BusEvent[][] =>
  signals.flatMap(signal => (signal.type === 'events' ? [[...signal.events]] : []));

const subscribedCount = (signals: readonly TransportSignal[]) =>
  signals.filter(signal => signal.type === 'subscribed').length;

const cursorOf = (index: number): ReplayCursor => cometdCursor(BURST[index]!.data.event.replayId);

async function failureOf(finished: Promise<void>): Promise<TransportFailure> {
  const error = await finished.then(
    () => undefined,
    (rejected: unknown) => rejected
  );
  assert.ok(error instanceof TransportError, `expected a TransportError, got ${String(error)}`);
  return error.failure;
}

test('a subscription reports the handshake, the acknowledgement and the delivered event', async t => {
  const single = recordedEvents('single');
  const { run } = await openRun(t, { connects: [{ events: single }] });

  await run.until(signals => eventBatches(signals).length === 1);

  assert.deepEqual(
    run.signals.map(signal => signal.type),
    ['up', 'subscribed', 'events']
  );
  const [event] = eventBatches(run.signals)[0]!;
  const sent = single[0]!.data;
  assert.equal(event!.uuid, sent.event.EventUuid);
  assert.equal(event!.cursor, `cometd:${sent.event.replayId}`);
  assert.equal(event!.createdDate, sent.payload.CreatedDate);
  assert.deepEqual(event!.payload, sent.payload);
  assert.equal(event!.bytes, Buffer.byteLength(JSON.stringify(sent)));
});

test('the 870 events of one server response arrive as one batch in delivery order', async t => {
  const { double, run } = await openRun(t, { connects: [{ events: BURST }] }, { from: { kind: 'retained' } });

  await run.until(signals => eventBatches(signals).length === 1);
  await run.stop();

  const [batch] = eventBatches(run.signals);
  assert.equal(batch!.length, 870);
  assert.deepEqual(
    batch!.map(event => event.cursor),
    BURST.map(recorded => `cometd:${recorded.data.event.replayId}`)
  );
  assert.deepEqual(double.replays, [{ [CHANNEL]: -2 }]);
});

test('a backlog split over two responses 1.5 s apart arrives as an 800 and a 70 event batch', async t => {
  const { run } = await openRun(t, {
    connects: [{ events: BURST.slice(0, 800) }, { events: BURST.slice(800), delayMs: 1_500 }]
  });

  await run.until(signals => eventBatches(signals).length === 2, 8_000);

  const batches = eventBatches(run.signals);
  assert.deepEqual(
    batches.map(batch => batch.length),
    [800, 70]
  );
  assert.deepEqual(
    batches.flat().map(event => event.cursor),
    BURST.map(recorded => `cometd:${recorded.data.event.replayId}`)
  );
  const [first, second] = run.at.map((_, index) => index).filter(index => run.signals[index]!.type === 'events');
  assert.ok(run.at[second!]! - run.at[first!]! >= 1_400, 'the 70 events arrive after the delay, not with the 800');
});

test('the replay value of the first subscribe is the durable cursor, then the start point', async t => {
  const cases: { name: string; from: ReplayFrom; durable?: ReplayCursor; expected: number }[] = [
    { name: 'new', from: { kind: 'new' }, expected: -1 },
    { name: 'retained', from: { kind: 'retained' }, expected: -2 },
    { name: 'after a cursor', from: { kind: 'after', cursor: cursorOf(10) }, expected: BURST[10]!.data.event.replayId },
    {
      name: 'a durable cursor over new',
      from: { kind: 'new' },
      durable: cursorOf(3),
      expected: BURST[3]!.data.event.replayId
    },
    {
      name: 'a durable cursor over after',
      from: { kind: 'after', cursor: cursorOf(10) },
      durable: cursorOf(20),
      expected: BURST[20]!.data.event.replayId
    }
  ];
  for (const { name, from, durable, expected } of cases) {
    await t.test(name, async sub => {
      const { double, run } = await openRun(sub, {}, { from, durableCursor: () => durable });
      await run.until(signals => subscribedCount(signals) === 1);
      assert.deepEqual(double.replays, [{ [CHANNEL]: expected }]);
    });
  }
});

test('replayValueFor refuses a cursor the CometD transport did not produce', () => {
  assert.equal(replayValueFor(undefined, { kind: 'new' }), -1);
  assert.equal(replayValueFor(undefined, { kind: 'retained' }), -2);
  assert.equal(replayValueFor(cometdCursor(0), { kind: 'retained' }), 0);
  assert.throws(() => replayValueFor('pubsub:ab12' as ReplayCursor, { kind: 'new' }), RangeError);
  assert.throws(() => replayValueFor('cometd:-5' as ReplayCursor, { kind: 'new' }), RangeError);
  assert.throws(() => replayValueFor('cometd:abc' as ReplayCursor, { kind: 'new' }), RangeError);
  assert.throws(() => replayValueFor(undefined, { kind: 'after', cursor: 'cometd:1.5' as ReplayCursor }), RangeError);
});

test('a start point that is not a CometD cursor is refused before any request', async t => {
  const double = await startBayeuxDouble(t);
  const connection = await openConnection(double.username);
  const finished = createCometdTransport().open({
    connection,
    channel: CHANNEL,
    from: { kind: 'after', cursor: 'pubsub:ab12' as ReplayCursor },
    durableCursor: () => undefined,
    signal: new AbortController().signal,
    onSignal: () => undefined
  });
  await assert.rejects(finished, RangeError);
  assert.equal(double.handshakes, 0);
});

test('a subscribe refused by Salesforce ends the subscription with a typed failure and disconnects the client', async t => {
  const refusals: { text: string; expected: TransportFailure }[] = [
    { text: INVALID_REPLAY, expected: { kind: 'cursorRejected' } },
    { text: '401::Authentication invalid', expected: { kind: 'authRejected' } },
    { text: '403::Restricted channel', expected: { kind: 'forbidden', message: '403::Restricted channel' } },
    {
      text: '403::Organization total events daily limit exceeded',
      expected: { kind: 'deliveryLimit', message: '403::Organization total events daily limit exceeded' }
    },
    {
      text: '403::Organization concurrent user limit exceeded',
      expected: { kind: 'clientLimit', message: '403::Organization concurrent user limit exceeded' }
    },
    { text: '500::Server unavailable', expected: { kind: 'other', message: '500::Server unavailable' } }
  ];
  for (const { text, expected } of refusals) {
    await t.test(text, async sub => {
      const { double, run } = await openRun(
        sub,
        { subscribe: { ok: false, error: text } },
        { from: { kind: 'after', cursor: cursorOf(5) } }
      );

      assert.deepEqual(await failureOf(run.finished), expected);
      assert.equal(double.disconnects, 1, 'the idle client is disconnected, not left polling');
      assert.equal(double.heldPolls, 0);
      assert.equal(subscribedCount(run.signals), 0);
    });
  }
});

test('a connection Salesforce refuses mid-stream ends the subscription with a typed failure', async t => {
  const refusals: { name: string; script: DoubleScript; expected: TransportFailure }[] = [
    {
      name: 'an expired token on a poll',
      script: { connects: [{ error: '401::Authentication invalid', advice: { reconnect: 'none' } }] },
      expected: { kind: 'authRejected' }
    },
    {
      name: 'a refused handshake',
      script: {
        handshake: {
          error: '403::Handshake denied',
          advice: { reconnect: 'none' },
          failureReason: '401::Authentication invalid'
        }
      },
      expected: { kind: 'authRejected' }
    },
    {
      name: 'the daily delivery limit on a poll',
      script: {
        connects: [{ error: '403::Organization total events daily limit exceeded', advice: { reconnect: 'none' } }]
      },
      expected: { kind: 'deliveryLimit', message: '403::Organization total events daily limit exceeded' }
    },
    {
      name: 'the concurrent client limit on a poll',
      script: {
        connects: [{ error: '403::Organization concurrent user limit exceeded', advice: { reconnect: 'none' } }]
      },
      expected: { kind: 'clientLimit', message: '403::Organization concurrent user limit exceeded' }
    }
  ];
  for (const { name, script, expected } of refusals) {
    await t.test(name, async sub => {
      const { double, run } = await openRun(sub, script);

      assert.deepEqual(await failureOf(run.finished), expected);
      assert.equal(double.heldPolls, 0);
    });
  }
});

test('a re-handshake resubscribes from the durable cursor, not from the last delivered event', async t => {
  let checkpointed: ReplayCursor | undefined;
  const { double, run } = await openRun(
    t,
    {
      connects: [
        { events: BURST.slice(0, 3) },
        { error: '403::Unknown client', advice: { reconnect: 'handshake' } },
        { events: BURST.slice(3, 5) }
      ]
    },
    { durableCursor: () => checkpointed }
  );

  await run.until(signals => eventBatches(signals).length === 1);
  checkpointed = cursorOf(0);
  await run.until(signals => eventBatches(signals).length === 2);

  assert.equal(double.handshakes, 2);
  assert.deepEqual(double.replays, [{ [CHANNEL]: -1 }, { [CHANNEL]: BURST[0]!.data.event.replayId }]);
  assert.equal(subscribedCount(run.signals), 2);
  assert.deepEqual(
    eventBatches(run.signals)
      .flat()
      .map(event => event.cursor),
    BURST.slice(0, 5).map(recorded => `cometd:${recorded.data.event.replayId}`),
    'events delivered before the durable cursor are delivered again by the server, not skipped'
  );
});

test('a resubscribe after a re-handshake that Salesforce rejects surfaces as a rejected cursor', async t => {
  const { double, run } = await openRun(t, {
    resubscribe: { ok: false, error: INVALID_REPLAY },
    connects: [{ events: BURST.slice(0, 2) }, { error: '403::Unknown client', advice: { reconnect: 'handshake' } }]
  });

  assert.deepEqual(await failureOf(run.finished), { kind: 'cursorRejected' });
  assert.equal(double.handshakes, 2);
  assert.equal(double.replays.length, 2);
  assert.equal(double.disconnects, 1);
  assert.equal(double.heldPolls, 0);
});

test('messages that are not platform events are dropped and counted, the rest are delivered', async t => {
  const valid = BURST.slice(0, 2);
  const withoutUuid = { ...valid[0]!.data, event: { replayId: 5, EventApiName: 'ALV_Test_Log__e' } };
  const dropped: number[] = [];
  const { run } = await openRun(
    t,
    { connects: [{ events: [valid[0]!, { data: withoutUuid }, { data: 'garbage' }, valid[1]!] }] },
    { transport: { onDropped: count => dropped.push(count) } }
  );

  await run.until(signals => eventBatches(signals).length === 1);

  assert.deepEqual(
    eventBatches(run.signals)[0]!.map(event => event.uuid),
    valid.map(recorded => recorded.data.event.EventUuid)
  );
  assert.deepEqual(dropped, [1, 2]);
});

test('a dropped connection is reported as down', async t => {
  const { run } = await openRun(t, { connects: [{ dropConnection: true }] });

  await run.until(signals => signals.some(signal => signal.type === 'down'));

  assert.ok(run.signals.some(signal => signal.type === 'subscribed'));
});

test('stopping a connected subscription disconnects the client and delivers nothing more', async t => {
  const { double, run } = await openRun(t, { connects: [{ events: BURST.slice(0, 3) }] });
  await eventually(() => double.heldPolls === 1);

  await run.stop();

  assert.equal(double.disconnects, 1);
  assert.equal(double.heldPolls, 0);
  const seen = run.signals.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(run.signals.length, seen);
});

test('stopping before the handshake completes still disconnects the client once it connects', async t => {
  const { double, run } = await openRun(t, { handshake: { delayMs: 300 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(double.handshakes, 1);

  await run.stop();

  assert.equal(double.disconnects, 1, 'the deferred disconnect ran after the handshake');
  assert.equal(double.heldPolls, 0);
  assert.deepEqual(
    run.signals.filter(signal => signal.type !== 'up'),
    []
  );
});

test('an aborted signal opens nothing', async t => {
  const double = await startBayeuxDouble(t);
  const connection = await openConnection(double.username);
  const aborted = new AbortController();
  aborted.abort();

  await createCometdTransport().open({
    connection,
    channel: CHANNEL,
    from: { kind: 'new' },
    durableCursor: () => undefined,
    signal: aborted.signal,
    onSignal: () => assert.fail('no signal expected')
  });

  assert.equal(double.handshakes, 0);
});

test('a process that aborts its subscription exits at once with no socket or timer left', async t => {
  const scenarios: {
    name: string;
    abortOn: 'start' | 'down' | 'offline';
    script: DoubleScript;
    maxExitMs: number;
    disconnects: number;
  }[] = [
    {
      name: 'before the handshake completes',
      abortOn: 'start',
      script: { handshake: { delayMs: 400 } },
      maxExitMs: 1_000,
      disconnects: 1
    },
    {
      name: 'after the connection dropped',
      abortOn: 'down',
      script: { connects: [{ dropConnection: true }] },
      maxExitMs: 1_000,
      disconnects: 1
    },
    // The server never acknowledges the disconnect, so the adapter waits out its 5 s grace and then stops Faye's retries.
    {
      name: 'while the server is unreachable',
      abortOn: 'offline',
      script: { connects: [{ dropConnection: true }] },
      maxExitMs: 6_000,
      disconnects: 0
    }
  ];
  for (const { name, abortOn, script, maxExitMs, disconnects } of scenarios) {
    await t.test(name, async sub => {
      const double = await startBayeuxDouble(sub, script);
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', path.resolve(__dirname, 'support/cometdAbortChild.ts'), double.username, CHANNEL, abortOn],
        { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'] }
      );
      let abortedAt = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString();
        if (lines.includes('down')) void double.close();
        if (lines.includes('aborting')) abortedAt = Date.now();
      });
      const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      const code = await new Promise<number | null>(resolve => child.on('exit', resolve));
      clearTimeout(killer);
      const exitedAfter = Date.now() - abortedAt;

      assert.equal(code, 0);
      assert.ok(exitedAfter < maxExitMs, `the process lingered ${exitedAfter} ms after the abort`);
      assert.equal(double.disconnects, disconnects);
      sub.diagnostic(`exited ${exitedAfter} ms after the abort`);
    });
  }
});

test('parseCometdEvent accepts a recorded message and rejects every malformed shape', () => {
  const good = BURST[0]!.data;
  const parsed = parseCometdEvent(good);
  assert.equal(parsed?.uuid, parseEventUuid(good.event.EventUuid));

  const malformed: unknown[] = [
    undefined,
    null,
    'text',
    [],
    {},
    { payload: good.payload },
    { event: good.event },
    { ...good, event: { ...good.event, EventUuid: 'not-a-uuid' } },
    { ...good, event: { ...good.event, replayId: '5' } },
    { ...good, event: { ...good.event, replayId: -1 } },
    { ...good, event: { ...good.event, replayId: 1.5 } },
    { ...good, event: { ...good.event, replayId: Number.MAX_SAFE_INTEGER + 2 } },
    { ...good, payload: { ...good.payload, CreatedDate: undefined } },
    { ...good, payload: { ...good.payload, CreatedDate: 'yesterday' } },
    { ...good, payload: [] }
  ];
  for (const data of malformed) assert.equal(parseCometdEvent(data), undefined, JSON.stringify(data));
});

test('classifyFailure maps each Streaming API error text to a failure kind', () => {
  const kinds: [string, TransportFailure['kind']][] = [
    [INVALID_REPLAY, 'cursorRejected'],
    ['400::Invalid subscription', 'other'],
    ['401::Authentication invalid', 'authRejected'],
    ['403::Restricted channel', 'forbidden'],
    ['403::Organization total events daily limit exceeded', 'deliveryLimit'],
    ['403::Organization concurrent user limit exceeded', 'clientLimit'],
    ['403::Unknown client', 'other'],
    ['', 'other']
  ];
  for (const [text, kind] of kinds) assert.equal(classifyFailure(text).kind, kind, text);
});
