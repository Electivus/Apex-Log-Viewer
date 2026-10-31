import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AlvError, createApexLogViewerCore, type CoreInstrumentation } from '../src/index.ts';
import type { CustomLogCaptureUpdate } from '../src/customLogs/contracts.ts';
import { openEventStore } from '../src/customLogs/events/store.ts';
import { appLogSource, type Json } from './support/customLogsFixtures.ts';
import { within } from './support/captureHarness.ts';
import { recordedEvents, startBayeuxDouble } from './support/cometdDouble.ts';
import { alvTestLogDescribe } from './support/describeFixtures.ts';
import { nebulaHandler } from './support/nebulaDouble.ts';
import { isolateSalesforceHome } from './support/salesforceDouble.ts';

isolateSalesforceHome();
// Faye reads http_proxy and ignores NO_PROXY, so a proxied machine would send the loopback double's traffic away.
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;

const OBJECT = 'ALV_Test_Log__e';
const SOURCE = 'alv-events';
const REPLAY = `/event/${OBJECT}`;

/** The events org's `ALV_Test_Log__e`, mapped with every role the recordings fill. */
const alvEvents = (fields: Json = {}): Json => ({
  id: SOURCE,
  label: 'ALV events',
  event: {
    object: OBJECT,
    fields: {
      time: 'Logged_At__c',
      message: 'Message__c',
      level: 'Level__c',
      user: 'Username__c',
      transactionId: 'Transaction_Id__c',
      requestId: 'Request_Id__c',
      order: 'Sequence__c',
      ...fields
    },
    columns: ['Epoch_Ms__c'],
    payload: { field: 'Payload__c', columns: ['sequence'] }
  }
});

/**
 * A recording delivered as if it had just been published. The events keep their uuids, replay ids and
 * order; only the instants move, so the store's retention purge never sees them as old.
 */
function freshEvents(name: 'single' | 'burst-870') {
  const recorded = recordedEvents(name);
  const instants = recorded.map(({ data }) => Date.parse(String(data.payload.CreatedDate)));
  const shift = Date.now() - 60_000 - Math.max(...instants);
  const moved = (iso: unknown): string => new Date(Date.parse(String(iso)) + shift).toISOString();
  return recorded.map(({ data }) => ({
    data: {
      ...data,
      payload: {
        ...data.payload,
        CreatedDate: moved(data.payload.CreatedDate),
        Logged_At__c: moved(data.payload.Logged_At__c),
        Epoch_Ms__c: Number(data.payload.Epoch_Ms__c) + shift
      }
    }
  }));
}

async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof AlvError, `a typed error, got ${String(error)}`);
    return error.code;
  }
  throw new assert.AssertionError({ message: 'expected the call to fail' });
}

/**
 * A project with an event source, and one org that serves both halves of a capture on one host: the
 * REST answers (metadata, describe, `/limits`) and the Bayeux stream, which delivers `events` once.
 */
async function world(
  t: test.TestContext,
  options: {
    events?: 'single' | 'burst-870';
    sources?: Json[];
    instrumentation?: CoreInstrumentation;
  } = {}
) {
  // Hooks run in the order they are registered: the core ends its runs first, then the double and the directory go.
  const core = createApexLogViewerCore({ instrumentation: options.instrumentation, surface: 'vscode' });
  t.after(() => core.dispose());
  const double = await startBayeuxDouble(
    t,
    { connects: options.events ? [{ events: freshEvents(options.events) }] : [] },
    nebulaHandler({
      describes: 'unlocked-admin',
      objects: [OBJECT],
      extraDescribes: { [OBJECT]: alvTestLogDescribe() },
      answer: (_soql, request) =>
        request.path === '/limits'
          ? { body: { DailyDeliveredPlatformEvents: { Max: 25_000, Remaining: 22_000 } } }
          : undefined
    })
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-facade-capture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sources = options.sources ?? [alvEvents()];
  await fs.writeFile(
    path.join(root, 'sfdx-project.json'),
    JSON.stringify({ plugins: { electivus: { customLogs: { sources } } } })
  );
  const scope = { targetOrg: double.username, projectDir: root, source: SOURCE };
  const location = { root, username: double.username, object: OBJECT };
  return { core, double, root, scope, location };
}

/** A drain that ends at its bound instead of after the 10 s of silence a real run waits for. */
const DRAIN = { follow: false, initial: 'retained', maxDurationMs: 1_000 } as const;

// ---------------------------------------------------------------------------------------------
// the join: capture over the real adapter, then the offline read of the same source

test('capture stores a recorded event through the real CometD adapter, and list reads it back with no request', async t => {
  const { core, double, scope } = await world(t, { events: 'single' });
  const updates: CustomLogCaptureUpdate[] = [];

  const result = await core.customLog.capture({ ...scope, ...DRAIN }, { onUpdate: update => updates.push(update) });

  assert.equal(result.source.id, SOURCE);
  assert.equal(result.outcome, 'timeLimit', 'the event was still being caught up when the bound passed');
  assert.deepEqual([result.delivered, result.stored, result.newGaps], [1, 1, []]);
  assert.equal(result.store.state, 'captured');
  assert.deepEqual(double.replays, [{ [REPLAY]: -2 }], 'a store with no position replays what Salesforce retains');
  assert.deepEqual(
    double.requests.map(request => request.path).filter(requestPath => requestPath === '/limits'),
    ['/limits'],
    'the allowance was read once'
  );
  const streamed = updates.flatMap(update => update.rows);
  assert.equal(streamed.length, 1);
  assert.equal(updates.at(-1)?.allowance?.remaining, 22_000);

  const received = double.received;
  const listed = await core.customLog.list(scope);

  assert.equal(double.received, received, 'list made no HTTP request');
  assert.deepEqual(listed.rows, streamed, 'a live row and a listed row are the same row');
  assert.equal(listed.rows[0]!.title, 'Synthetic INFO entry 870 of 870 (bsn870)');
  assert.equal(listed.store?.state, 'captured');
});

test('capture stores a recorded burst of 870 events and list pages through all of them offline', async t => {
  const { core, double, scope } = await world(t, { events: 'burst-870' });

  const result = await core.customLog.capture({ ...scope, ...DRAIN, maxDurationMs: 4_000 });

  assert.deepEqual([result.delivered, result.stored, result.newGaps], [870, 870, []]);
  const received = double.received;
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await core.customLog.list({ ...scope, limit: 200, cursor });
    page.rows.forEach(row => ids.add(row.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.size, 870);
  assert.equal(double.received, received, 'paging made no HTTP request');
});

test('a second capture resumes after the stored cursor and stores nothing twice', async t => {
  const { core, double, scope } = await world(t, { events: 'single' });
  await core.customLog.capture({ ...scope, ...DRAIN });
  const [{ data }] = recordedEvents('single') as [{ data: { event: { replayId: number } } }];

  const again = await core.customLog.capture({ ...scope, ...DRAIN });

  assert.deepEqual(double.replays, [{ [REPLAY]: -2 }, { [REPLAY]: data.event.replayId }]);
  assert.deepEqual([again.delivered, again.stored], [0, 0]);
  assert.equal((await core.customLog.list(scope)).rows.length, 1);
});

// ---------------------------------------------------------------------------------------------
// refusals, before any connection

test('a record source is refused with CUSTOM_LOG_NOT_EVENT_SOURCE before the org is contacted', async t => {
  const { core, double, scope } = await world(t, { sources: [appLogSource, alvEvents()] });

  for (const source of ['app-log', 'nebula']) {
    const code = await codeOf(core.customLog.capture({ ...scope, source, follow: false }));
    assert.equal(code, 'CUSTOM_LOG_NOT_EVENT_SOURCE', source);
  }

  assert.equal(double.received, 0, 'not one HTTP request');
});

test('an unknown source, a blank source and a bad drain bound fail locally with their own codes', async t => {
  const { core, double, scope } = await world(t);

  assert.equal(
    await codeOf(core.customLog.capture({ ...scope, source: 'nope', follow: false })),
    'CUSTOM_LOG_SOURCE_NOT_FOUND'
  );
  assert.equal(
    await codeOf(core.customLog.capture({ ...scope, source: '  ', follow: false })),
    'INVALID_ARGUMENT',
    'an event source is never chosen implicitly'
  );
  for (const maxDurationMs of [0, 3_600_001, 1.5, Number.NaN]) {
    assert.equal(
      await codeOf(core.customLog.capture({ ...scope, follow: false, maxDurationMs })),
      'INVALID_ARGUMENT',
      String(maxDurationMs)
    );
  }
  assert.equal(
    await codeOf(core.customLog.capture({ ...scope, follow: false, filter: { minLevel: 'LOUD' as never } })),
    'INVALID_ARGUMENT'
  );

  assert.equal(double.received, 0, 'not one HTTP request');
});

test('without a project directory there is nowhere to keep events, and no connection is made', async t => {
  const { core, double, scope } = await world(t);

  const code = await codeOf(
    core.customLog.capture({
      targetOrg: scope.targetOrg,
      projectDir: undefined,
      source: 'nebula-events',
      follow: false
    })
  );

  assert.equal(code, 'CUSTOM_LOG_STORE_UNAVAILABLE');
  assert.equal(double.received, 0);
});

test('a filter on a role the mapping leaves out is refused before the stream is opened', async t => {
  const { core, double, scope } = await world(t, {
    sources: [alvEvents({ level: undefined, levelOrdinal: undefined })]
  });

  const code = await codeOf(core.customLog.capture({ ...scope, follow: false, filter: { minLevel: 'WARN' } }));

  assert.equal(code, 'CUSTOM_LOG_UNSUPPORTED_FILTER');
  assert.equal(double.handshakes, 0, 'no subscription');
});

test('a signal aborted while the source resolves ends with outcome aborted, not an error', async t => {
  const { core, scope } = await world(t);
  const abort = new AbortController();
  const pending = core.customLog.capture({ ...scope, follow: true }, { signal: abort.signal });
  abort.abort();

  const result = await pending;

  assert.equal(result.outcome, 'aborted');
  assert.deepEqual([result.delivered, result.stored], [0, 0]);
  assert.equal(result.store.state, 'notCaptured');
});

// ---------------------------------------------------------------------------------------------
// instrumentation and dispose

test('the facade reports one start and one end per run through onCapture, and times nothing as one call', async t => {
  const runs: unknown[] = [];
  const calls: string[] = [];
  const { core, scope } = await world(t, {
    events: 'single',
    instrumentation: { onCapture: event => runs.push(event), onCall: event => calls.push(event.method) }
  });

  await core.customLog.capture({ ...scope, ...DRAIN });
  await core.customLog.list(scope);

  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], { type: 'start', from: 'retained' });
  assert.deepEqual(runs[1], {
    type: 'end',
    outcome: 'timeLimit',
    durationMs: (runs[1] as { durationMs: number }).durationMs,
    delivered: 1,
    stored: 1,
    gaps: 0,
    reconnects: 0,
    dropped: 0
  });
  assert.deepEqual(calls, ['customLog.list'], 'capture is not a core.request');
});

test('dispose ends an active follow run, releases its capture lease and closes the stream', async t => {
  const { core, double, scope, location } = await world(t, { events: 'single' });
  const updates: CustomLogCaptureUpdate[] = [];
  const following = core.customLog.capture(
    { ...scope, follow: true, initial: 'retained' },
    {
      onUpdate: update => updates.push(update)
    }
  );
  await eventually(() => updates.some(update => update.rows.length > 0));
  const held = await openEventStore(location).openWriter('cli');
  assert.ok('heldBy' in held, 'while the run is active, nobody else captures');
  assert.equal(held.heldBy.surface, 'vscode', 'the lease names the surface the core was created for');

  await within(core.dispose(), 'dispose to end the run', 5_000);

  const result = await within(following, 'the follow run to resolve', 5_000);
  assert.equal(result.outcome, 'aborted');
  assert.equal(result.stored, 1);
  assert.equal(double.disconnects, 1, 'the subscription was closed on the server');
  const free = await openEventStore(location).openWriter('cli');
  assert.ok('writer' in free, 'the lease was released');
  await free.writer.release();
});
