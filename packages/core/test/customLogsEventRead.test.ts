import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AlvError, createApexLogViewerCore } from '../src/index.ts';
import { CUSTOM_LOG_EVENT_ID_PATTERN, type CustomLogListResult } from '../src/customLogs/contracts.ts';
import { encodeCursor } from '../src/customLogs/queries.ts';
import { projectWith, type Json } from './support/customLogsFixtures.ts';
import { alvTestLogDescribe, logEntryEventDescribe } from './support/describeFixtures.ts';
import { eventObjectKey } from '../src/customLogs/events/store.ts';
import { busEvent, seedEventStore } from './support/eventSeed.ts';
import { page, startNebulaOrg } from './support/nebulaDouble.ts';
import {
  ORG_ID,
  isolateSalesforceHome,
  saveOrgAuth,
  startSalesforceDouble,
  type DoubleHandler
} from './support/salesforceDouble.ts';

isolateSalesforceHome();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-10-30T10:00:00.000Z');
const UNREACHABLE_ORG = 'http://127.0.0.1:1';
const OBJECT = 'ALV_Test_Log__e';
const SOURCE = 'alv-events';

/** The events org's `ALV_Test_Log__e`, mapped with every role the reads use. */
const alvEvents = (event: Json = {}): Json => ({
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
      order: 'Sequence__c'
    },
    columns: ['Epoch_Ms__c'],
    details: [{ field: 'Stack_Trace__c', presence: 'Has_Stack_Trace__c' }],
    payload: { field: 'Payload__c', columns: ['order.id'] },
    ...event
  }
});

/** The same source with a role left unmapped. */
function withoutRole(role: string): Json {
  const source = alvEvents();
  const { [role]: _left, ...fields } = (source.event as { fields: Json }).fields;
  return alvEvents({ fields });
}

const hasQueried = (double: { requests: unknown[] }) => double.requests.length > 0;

type Fields = {
  message?: string;
  level?: string;
  user?: string;
  tx?: string;
  seq?: number;
  requestId?: string;
  payload?: unknown;
  stack?: string;
  extra?: Json;
};

/** An `ALV_Test_Log__e` event numbered `n`, published at `at`. */
function logEvent(n: number, at: number, fields: Fields = {}) {
  const { message = `message ${n}`, level = 'INFO', user = 'dev@acme.com', tx, seq, requestId, stack } = fields;
  return busEvent(n, at, {
    Logged_At__c: new Date(at).toISOString(),
    Epoch_Ms__c: at,
    Message__c: message,
    ...(level ? { Level__c: level } : {}),
    Username__c: user,
    ...(tx ? { Transaction_Id__c: tx } : {}),
    ...(seq === undefined ? {} : { Sequence__c: seq }),
    ...(requestId ? { Request_Id__c: requestId } : {}),
    ...(fields.payload === undefined ? {} : { Payload__c: JSON.stringify(fields.payload) }),
    ...(stack ? { Stack_Trace__c: stack, Has_Stack_Trace__c: true } : {}),
    ...fields.extra
  });
}

let nextUser = 0;

/**
 * A project directory with a seeded event store, and a core signed in to an org that answers
 * `orgHandler` (every request an error by default) or is not reachable at all.
 */
async function world(
  t: test.TestContext,
  options: {
    events?: ReturnType<typeof logEvent>[] | undefined;
    source?: Json;
    reachable?: boolean;
    orgHandler?: DoubleHandler;
    project?: Json | null;
  } = {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-event-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = options.project === undefined ? projectWith(options.source ?? alvEvents()) : options.project;
  if (project) await fs.writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify(project));
  const username = `event-read-${nextUser++}@example.com`;
  const org = await startSalesforceDouble(
    t,
    options.orgHandler ?? (() => ({ status: 500, body: [{ errorCode: 'UNEXPECTED', message: 'no request expected' }] }))
  );
  await saveOrgAuth(username, options.reachable === false ? UNREACHABLE_ORG : org.instanceUrl);
  if (options.events) {
    await seedEventStore({ root, username, describe: alvTestLogDescribe(), events: options.events });
  }
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());
  const scope = { targetOrg: username, projectDir: root, source: SOURCE };
  return { core, root, username, org, scope };
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

const messages = (rows: { title?: string }[]) => rows.map(row => row.title);

// ---------------------------------------------------------------------------------------------
// No connection

test('list, get and entry of an event source read the store and never reach the org', async t => {
  const events = [
    logEvent(1, T0, { tx: 'tx-a', seq: 1, stack: 'at Foo.bar' }),
    logEvent(2, T0 + MINUTE, { tx: 'tx-a', seq: 2 })
  ];
  const { core, org, scope } = await world(t, { events });

  const list = await core.customLog.list(scope);
  const id = list.rows[0]!.id;
  const got = await core.customLog.get({ ...scope, logId: id });
  const entry = await core.customLog.entry({ ...scope, entryId: id });

  assert.equal(list.rows.length, 2);
  assert.equal(got.entries.length, 2);
  assert.equal(entry.entry.id, id);
  assert.equal(got.apexLog.state, 'noRequestId');
  assert.equal(org.received, 0, 'not one HTTP request, the version listing included');
});

test('an event with a request id looks its ApexLog up through the org, and says offline when it cannot', async t => {
  const events = [logEvent(1, T0, { requestId: 'SLB:req-1' })];
  const reachable = await world(t, {
    events,
    orgHandler: request =>
      request.path === '/tooling/query'
        ? {
            body: {
              totalSize: 1,
              done: true,
              records: [{ Id: '07L000000000001AAA', StartTime: '2026-10-30T10:00:00.000+0000', LogLength: 512 }]
            }
          }
        : { status: 404, body: [{ errorCode: 'NOT_FOUND', message: 'unexpected' }] }
  });
  const id = (await reachable.core.customLog.list(reachable.scope)).rows[0]!.id;

  const linked = await reachable.core.customLog.get({ ...reachable.scope, logId: id });

  assert.deepEqual(linked.apexLog, {
    state: 'linked',
    logId: '07L000000000001AAA',
    startTime: '2026-10-30T10:00:00.000Z',
    logLength: 512
  });
  assert.ok(hasQueried(reachable.org), 'the lookup is the one call that needs the org');

  const offline = await world(t, { events, reachable: false });
  const offlineId = (await offline.core.customLog.list(offline.scope)).rows[0]!.id;
  const read = await offline.core.customLog.get({ ...offline.scope, logId: offlineId });

  assert.deepEqual(read.apexLog, { state: 'unavailable', reason: 'offline' });
  assert.equal(read.entries.length, 1, 'the event is still read');
});

// ---------------------------------------------------------------------------------------------
// list

test('list returns the stored events newest first, in publish order inside one millisecond', async t => {
  const events = [
    logEvent(1, T0, { message: 'a first' }),
    logEvent(2, T0, { message: 'a second, same millisecond' }),
    logEvent(3, T0 - HOUR, { message: 'older, delivered late' }),
    logEvent(4, T0 + HOUR, { message: 'newest' })
  ];
  const { core, scope } = await world(t, { events });

  const result = await core.customLog.list(scope);

  assert.deepEqual(messages(result.rows), ['newest', 'a second, same millisecond', 'a first', 'older, delivered late']);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.source, { id: SOURCE, label: 'ALV events', shape: 'events' });
});

test('list decodes each stored event through the mapping and the stored describe', async t => {
  const events = [
    logEvent(1, T0, {
      message: 'order synced',
      level: 'WARN',
      user: 'ops@acme.com',
      tx: 'tx-1',
      requestId: 'SLB:req-1',
      payload: { order: { id: 'O-1', lines: 2 } }
    })
  ];
  const { core, scope } = await world(t, { events });

  const result = await core.customLog.list(scope);

  assert.deepEqual(result.columns, [{ key: 'Epoch_Ms__c', label: 'Epoch Ms' }]);
  const [row] = result.rows;
  assert.match(row!.id, CUSTOM_LOG_EVENT_ID_PATTERN);
  assert.deepEqual(
    { ...row, id: undefined },
    {
      id: undefined,
      time: new Date(T0).toISOString(),
      title: 'order synced',
      user: 'ops@acme.com',
      level: 'WARN',
      transactionId: 'tx-1',
      requestId: 'SLB:req-1',
      extra: { Epoch_Ms__c: T0 },
      payload: { state: 'parsed', values: { 'order.id': 'O-1', 'order.lines': 2 }, droppedPaths: 0, cutValues: [] }
    }
  );
  assert.deepEqual(result.payloadFields, [
    { path: 'order.id', types: ['string'], rows: 1 },
    { path: 'order.lines', types: ['number'], rows: 1 }
  ]);
});

test('list reports what the store covers beside the page', async t => {
  const events = [logEvent(1, T0), logEvent(2, T0 + HOUR)];
  const { core, root, username, scope } = await world(t, { events });

  const { store } = await core.customLog.list(scope);

  assert.ok(store?.state === 'captured');
  assert.equal(store.eventsRoot, path.join(root, 'apexlogs', 'orgs', username, 'events', eventObjectKey(OBJECT)));
  assert.equal(store.oldest, new Date(T0).toISOString());
  assert.equal(store.newest, new Date(T0 + HOUR).toISOString());
  assert.equal(store.retentionDays, 30);
  assert.deepEqual(store.gaps, []);
  assert.ok(store.sizeBytes > 0);
  assert.ok(Number.isFinite(Date.parse(store.lastCaptureAt)));
});

test('list pages by cursor without repeating or dropping an event', async t => {
  const events = Array.from({ length: 7 }, (_, index) => logEvent(index + 1, T0 + index * MINUTE));
  const { core, scope } = await world(t, { events });

  const seen: (string | undefined)[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const result: CustomLogListResult = await core.customLog.list({ ...scope, limit: 3, cursor });
    seen.push(...messages(result.rows));
    cursor = result.nextCursor ?? undefined;
    pages++;
  } while (cursor && pages < 10);

  assert.equal(pages, 3);
  assert.deepEqual(
    seen,
    Array.from({ length: 7 }, (_, index) => `message ${7 - index}`)
  );
});

test('two orgs under one project each read their own stored events', async t => {
  const { core, root, org, scope } = await world(t, { events: [logEvent(1, T0, { message: 'first org' })] });
  const second = `event-read-${nextUser++}@example.com`;
  await saveOrgAuth(second, org.instanceUrl);
  await seedEventStore({
    root,
    username: second,
    describe: alvTestLogDescribe(),
    events: [logEvent(2, T0, { message: 'second org' })]
  });

  const first = await core.customLog.list(scope);
  const other = await core.customLog.list({ ...scope, targetOrg: second });

  assert.deepEqual(messages(first.rows), ['first org']);
  assert.deepEqual(messages(other.rows), ['second org']);
});

test('list keeps an event at or above the minimum level, and never one with no level', async t => {
  const events = [
    logEvent(1, T0, { level: 'DEBUG' }),
    logEvent(2, T0 + MINUTE, { level: 'WARN' }),
    logEvent(3, T0 + 2 * MINUTE, { level: 'ERROR' }),
    logEvent(4, T0 + 3 * MINUTE, { level: '' }),
    logEvent(5, T0 + 4 * MINUTE, { level: 'Verbose' })
  ];
  const { core, scope } = await world(t, { events });

  const warn = await core.customLog.list({ ...scope, filter: { minLevel: 'WARN' } });
  const all = await core.customLog.list(scope);

  assert.deepEqual(messages(warn.rows), ['message 3', 'message 2']);
  assert.equal(all.rows.length, 5);
});

test('list matches the user without regard to case and pages through the matches only', async t => {
  const events = [
    logEvent(1, T0, { user: 'Dev@Acme.com' }),
    logEvent(2, T0 + MINUTE, { user: 'ops@acme.com' }),
    logEvent(3, T0 + 2 * MINUTE, { user: 'dev@acme.com' }),
    logEvent(4, T0 + 3 * MINUTE, { user: 'dev@acme.com' })
  ];
  const { core, scope } = await world(t, { events });

  const first = await core.customLog.list({ ...scope, limit: 2, filter: { user: 'DEV@acme.com' } });
  const second = await core.customLog.list({
    ...scope,
    limit: 2,
    cursor: first.nextCursor ?? undefined,
    filter: { user: 'DEV@acme.com' }
  });

  assert.deepEqual(messages(first.rows), ['message 4', 'message 3']);
  assert.deepEqual(messages(second.rows), ['message 1']);
  assert.equal(second.nextCursor, null);
});

test('list bounds CreatedDate with an inclusive since and an exclusive until', async t => {
  const events = [logEvent(1, T0), logEvent(2, T0 + HOUR), logEvent(3, T0 + 2 * HOUR)];
  const { core, scope } = await world(t, { events });

  const window = await core.customLog.list({
    ...scope,
    filter: { since: new Date(T0 + HOUR).toISOString(), until: new Date(T0 + 2 * HOUR).toISOString() }
  });

  assert.deepEqual(messages(window.rows), ['message 2']);
});

test('list resolves a duration once, so every page keeps the same window', async t => {
  const now = Date.now();
  const events = [
    logEvent(1, now - 3 * 24 * HOUR),
    logEvent(2, now - 20 * MINUTE),
    logEvent(3, now - 10 * MINUTE),
    logEvent(4, now - 5 * MINUTE)
  ];
  const { core, scope } = await world(t, { events });

  const first = await core.customLog.list({ ...scope, limit: 2, filter: { since: '1h' } });
  const second = await core.customLog.list({
    ...scope,
    limit: 2,
    cursor: first.nextCursor ?? undefined,
    filter: { since: '1h' }
  });

  assert.deepEqual(messages(first.rows), ['message 4', 'message 3']);
  assert.deepEqual(messages(second.rows), ['message 2']);
  assert.equal(second.nextCursor, null);
});

test('list refuses a level or user filter on a source that maps neither role', async t => {
  const events = [logEvent(1, T0)];
  const noLevel = await world(t, { events, source: withoutRole('level') });
  const noUser = await world(t, { events, source: withoutRole('user') });

  assert.equal(
    await codeOf(noLevel.core.customLog.list({ ...noLevel.scope, filter: { minLevel: 'ERROR' } })),
    'CUSTOM_LOG_UNSUPPORTED_FILTER'
  );
  assert.equal(
    await codeOf(noUser.core.customLog.list({ ...noUser.scope, filter: { user: 'dev@acme.com' } })),
    'CUSTOM_LOG_UNSUPPORTED_FILTER'
  );
  assert.equal((await noLevel.core.customLog.list(noLevel.scope)).rows.length, 1);
});

test('list trims row payloads to the requested paths and still summarizes every path', async t => {
  const events = [logEvent(1, T0, { payload: { order: { id: 'O-1', lines: 2 }, note: 'x' } })];
  const { core, scope } = await world(t, { events });

  const result = await core.customLog.list({ ...scope, payloadFields: ['order.id'] });

  const payload = result.rows[0]!.payload;
  assert.ok(payload?.state === 'parsed');
  assert.deepEqual(payload.values, { 'order.id': 'O-1' });
  assert.deepEqual(
    result.payloadFields.map(field => field.path),
    ['order.id', 'order.lines', 'note']
  );
});

// ---------------------------------------------------------------------------------------------
// Cursors

test('an event cursor is refused after the filter or the mapping changes, and a record cursor is never accepted', async t => {
  const events = Array.from({ length: 4 }, (_, index) => logEvent(index + 1, T0 + index * MINUTE));
  const { core, root, scope } = await world(t, { events });
  const first = await core.customLog.list({ ...scope, limit: 2 });
  const cursor = first.nextCursor ?? undefined;
  assert.ok(cursor, 'a second page exists');

  assert.equal(
    await codeOf(core.customLog.list({ ...scope, limit: 2, cursor, filter: { minLevel: 'INFO' } })),
    'CUSTOM_LOG_INVALID_CURSOR',
    'other filters'
  );
  assert.equal(
    await codeOf(core.customLog.list({ ...scope, limit: 2, cursor: 'not-a-cursor!' })),
    'CUSTOM_LOG_INVALID_CURSOR'
  );

  const recordCursor = encodeCursor({
    v: 1,
    o: ORG_ID,
    s: SOURCE,
    m: '0123456789ab',
    k: 'list',
    f: '0123456789ab',
    t: new Date(T0).toISOString(),
    id: 'a020000000000AAAAA'
  });
  assert.equal(
    await codeOf(core.customLog.list({ ...scope, limit: 2, cursor: recordCursor })),
    'CUSTOM_LOG_INVALID_CURSOR',
    'a record cursor on an event source'
  );

  const edited = alvEvents({ columns: [] });
  await fs.writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify(projectWith(edited)));
  assert.equal(
    await codeOf(core.customLog.list({ ...scope, limit: 2, cursor })),
    'CUSTOM_LOG_INVALID_CURSOR',
    'the mapping changed'
  );
});

test('an event cursor is refused by a record source', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: ['Log__c', 'LogEntry__c'],
    answer: soql => (soql.includes('FROM Log__c') ? page([]) : undefined)
  });
  const events = Array.from({ length: 3 }, (_, index) => logEvent(index + 1, T0 + index * MINUTE));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-event-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify(projectWith(alvEvents())));
  const username = `event-read-${nextUser++}@example.com`;
  await saveOrgAuth(username, org.instanceUrl);
  await seedEventStore({ root, username, describe: alvTestLogDescribe(), events });
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());
  const eventPage = await core.customLog.list({ targetOrg: username, projectDir: root, source: SOURCE, limit: 1 });

  const code = await codeOf(
    core.customLog.list({
      targetOrg: username,
      projectDir: root,
      source: 'nebula',
      cursor: eventPage.nextCursor ?? undefined
    })
  );

  assert.equal(code, 'CUSTOM_LOG_INVALID_CURSOR');
});

// ---------------------------------------------------------------------------------------------
// get

test('get returns the stored events of the transaction around the one asked for, in order', async t => {
  const events = [
    logEvent(1, T0, { message: 'second by order', tx: 'tx-a', seq: 2 }),
    logEvent(2, T0, { message: 'first by order', tx: 'tx-a', seq: 1 }),
    logEvent(3, T0 + 30 * MINUTE, { message: 'last by order', tx: 'tx-a', seq: 3 }),
    logEvent(4, T0 + 10 * MINUTE, { message: 'another transaction', tx: 'tx-b', seq: 1 }),
    logEvent(5, T0 + 3 * HOUR, { message: 'same id, hours later', tx: 'tx-a', seq: 1 })
  ];
  const { core, scope } = await world(t, { events });
  const list = await core.customLog.list(scope);
  const anchor = list.rows.find(row => row.title === 'second by order')!;

  const got = await core.customLog.get({ ...scope, logId: anchor.id });

  assert.deepEqual(
    got.entries.map(entry => [entry.message, entry.sequence]),
    [
      ['first by order', 1],
      ['second by order', 2],
      ['last by order', 3]
    ]
  );
  assert.equal(got.log.id, anchor.id);
  assert.equal(got.log.title, 'second by order');
  assert.deepEqual(got.entryColumns, [{ key: 'Epoch_Ms__c', label: 'Epoch Ms' }]);
  assert.equal(got.nextCursor, null);
  assert.equal(got.store?.state, 'captured');
});

test('get by transaction id anchors on the newest stored event that carries it', async t => {
  const events = [
    logEvent(1, T0, { message: 'early', tx: 'tx-a' }),
    logEvent(2, T0 + 3 * HOUR, { message: 'late', tx: 'tx-a' }),
    logEvent(3, T0 + 10 * MINUTE, { message: 'other', tx: 'tx-b' })
  ];
  const { core, scope } = await world(t, { events });

  const other = await core.customLog.get({ ...scope, transactionId: 'tx-b' });
  const reused = await core.customLog.get({ ...scope, transactionId: 'tx-a' });

  assert.deepEqual(
    other.entries.map(entry => entry.message),
    ['other']
  );
  assert.deepEqual(
    reused.entries.map(entry => entry.message),
    ['late'],
    'an id reused hours apart is read from its newest occurrence'
  );
  assert.equal(
    await codeOf(core.customLog.get({ ...scope, transactionId: 'tx-missing' })),
    'CUSTOM_LOG_RECORD_NOT_FOUND'
  );
});

test('later pages of a transaction keep the anchor of the first, even after a newer occurrence of its id is stored', async t => {
  const original = [
    logEvent(1, T0, { tx: 'tx-a', seq: 1, message: 'one' }),
    logEvent(2, T0, { tx: 'tx-a', seq: 2, message: 'two' }),
    logEvent(3, T0, { tx: 'tx-a', seq: 3, message: 'three' })
  ];
  const { core, root, username, scope } = await world(t, { events: original });

  const first = await core.customLog.get({ ...scope, transactionId: 'tx-a', limit: 1 });
  await seedEventStore({
    root,
    username,
    describe: alvTestLogDescribe(),
    events: [logEvent(4, T0 + 3 * HOUR, { tx: 'tx-a', seq: 1, message: 'reused hours later' })]
  });
  const second = await core.customLog.get({ ...scope, transactionId: 'tx-a', limit: 1, cursor: first.nextCursor! });
  const third = await core.customLog.get({ ...scope, transactionId: 'tx-a', limit: 1, cursor: second.nextCursor! });

  assert.deepEqual(
    [first, second, third].map(page => page.entries.map(entry => entry.message)),
    [['one'], ['two'], ['three']]
  );
  assert.equal(second.log.id, first.log.id, 'every page reports the same anchor');
  assert.equal(third.nextCursor, null);
});

test('get pages the entries of a transaction and filters them by level', async t => {
  const events = [
    logEvent(1, T0, { tx: 'tx-a', seq: 1, level: 'INFO', message: 'one' }),
    logEvent(2, T0, { tx: 'tx-a', seq: 2, level: 'ERROR', message: 'two' }),
    logEvent(3, T0, { tx: 'tx-a', seq: 3, level: 'INFO', message: 'three' }),
    logEvent(4, T0, { tx: 'tx-a', seq: 4, level: 'WARN', message: 'four' })
  ];
  const { core, scope } = await world(t, { events });
  const anchor = (await core.customLog.list(scope)).rows[0]!;

  const first = await core.customLog.get({ ...scope, logId: anchor.id, limit: 3 });
  const second = await core.customLog.get({
    ...scope,
    logId: anchor.id,
    limit: 3,
    cursor: first.nextCursor ?? undefined
  });
  const serious = await core.customLog.get({ ...scope, logId: anchor.id, minLevel: 'WARN' });

  assert.deepEqual(
    [...first.entries, ...second.entries].map(entry => [entry.message, entry.sequence]),
    [
      ['one', 1],
      ['two', 2],
      ['three', 3],
      ['four', 4]
    ]
  );
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    serious.entries.map(entry => entry.message),
    ['two', 'four']
  );
  assert.equal(
    await codeOf(
      core.customLog.get({
        ...scope,
        logId: anchor.id,
        limit: 3,
        cursor: first.nextCursor ?? undefined,
        minLevel: 'WARN'
      })
    ),
    'CUSTOM_LOG_INVALID_CURSOR'
  );
});

test('get of an event with no transaction id value returns that event alone', async t => {
  const events = [logEvent(1, T0, { message: 'alone' }), logEvent(2, T0 + MINUTE, { message: 'neighbour' })];
  const { core, scope } = await world(t, { events });
  const alone = (await core.customLog.list(scope)).rows.find(row => row.title === 'alone')!;

  const got = await core.customLog.get({ ...scope, logId: alone.id });

  assert.deepEqual(
    got.entries.map(entry => entry.message),
    ['alone']
  );
});

test('get previews a long message and entry returns all of it', async t => {
  const long = 'x'.repeat(5000);
  const { core, scope } = await world(t, { events: [logEvent(1, T0, { message: long })] });
  const id = (await core.customLog.list(scope)).rows[0]!.id;

  const got = await core.customLog.get({ ...scope, logId: id });
  const entry = await core.customLog.entry({ ...scope, entryId: id });

  assert.equal(got.entries[0]!.message.length, 2000);
  assert.equal(got.entries[0]!.previewClipped, true);
  assert.equal(entry.entry.message, long);
  assert.equal(entry.entry.previewClipped, false);
});

// ---------------------------------------------------------------------------------------------
// entry

test('entry returns the full message, the mapped details and the raw payload of one stored event', async t => {
  const payload = { order: { id: 'O-9' } };
  const events = [logEvent(1, T0, { message: 'boom', level: 'ERROR', stack: 'at Foo.bar:12', payload })];
  const { core, scope } = await world(t, { events });
  const id = (await core.customLog.list(scope)).rows[0]!.id;

  const result = await core.customLog.entry({ ...scope, entryId: id });

  assert.equal(result.logId, id);
  assert.equal(result.entry.id, id);
  assert.equal(result.entry.message, 'boom');
  assert.equal(result.entry.level, 'ERROR');
  assert.deepEqual(result.entry.presentDetails, ['Stack_Trace__c']);
  assert.deepEqual(result.details, [
    { key: 'Stack_Trace__c', label: 'Stack Trace', state: 'value', value: 'at Foo.bar:12', format: 'text' }
  ]);
  assert.deepEqual(result.rawPayload, {
    state: 'value',
    value: JSON.stringify(payload),
    format: 'json'
  });
});

test('a mapped field the stored describe does not list reads as hidden, and its value never reaches the result', async t => {
  const secret = 'value-only-on-the-stored-line';
  const events = [logEvent(1, T0, { stack: 'at Foo.bar', extra: { Secret__c: secret } })];
  const source = alvEvents({
    details: [{ field: 'Stack_Trace__c', presence: 'Has_Stack_Trace__c' }, 'Secret__c']
  });
  const { core, scope } = await world(t, { events, source });
  const id = (await core.customLog.list(scope)).rows[0]!.id;

  const result = await core.customLog.entry({ ...scope, entryId: id });

  assert.equal(result.details[0]!.state, 'value');
  assert.equal(result.details[1]!.key, 'Secret__c');
  assert.equal(result.details[1]!.state, 'hidden');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('entry and get answer RECORD_NOT_FOUND for an event the store does not hold', async t => {
  const { core, scope } = await world(t, { events: [logEvent(1, T0)] });
  const known = (await core.customLog.list(scope)).rows[0]!.id;
  const unknown = `${known.slice(0, -1)}${known.endsWith('0') ? '1' : '0'}`;

  assert.equal(await codeOf(core.customLog.entry({ ...scope, entryId: unknown })), 'CUSTOM_LOG_RECORD_NOT_FOUND');
  assert.equal(await codeOf(core.customLog.get({ ...scope, logId: unknown })), 'CUSTOM_LOG_RECORD_NOT_FOUND');
});

// ---------------------------------------------------------------------------------------------
// A store that was never captured

test('list on a source nothing was captured for is an empty page that says so, and reads nothing from the org', async t => {
  const { core, org, root, username, scope } = await world(t);

  const result = await core.customLog.list(scope);

  assert.deepEqual(
    { ...result, store: undefined },
    {
      source: { id: SOURCE, label: 'ALV events', shape: 'events' },
      columns: [],
      rows: [],
      payloadFields: [],
      nextCursor: null,
      store: undefined
    }
  );
  assert.deepEqual(result.store, {
    state: 'notCaptured',
    eventsRoot: path.join(root, 'apexlogs', 'orgs', username, 'events', eventObjectKey(OBJECT)),
    retentionDays: 30
  });
  assert.equal(org.received, 0);
});

test('a store with a describe and no checkpoint is still not captured, and eventRetentionDays is reported', async t => {
  const project = {
    plugins: { electivus: { customLogs: { eventRetentionDays: 7, sources: [alvEvents()] } } }
  };
  const { core, scope } = await world(t, { events: [], project });

  const result = await core.customLog.list(scope);

  assert.equal(result.rows.length, 0);
  assert.equal(result.store?.state, 'notCaptured');
  assert.equal(result.store?.retentionDays, 7);
});

test('get and entry on a source nothing was captured for answer RECORD_NOT_FOUND, and a cursor cannot belong to it', async t => {
  const { core, org, scope } = await world(t);
  const someId = `e-${'0'.repeat(9)}-${'0'.repeat(10)}-${'0'.repeat(32)}`;

  assert.equal(await codeOf(core.customLog.entry({ ...scope, entryId: someId })), 'CUSTOM_LOG_RECORD_NOT_FOUND');
  assert.equal(await codeOf(core.customLog.get({ ...scope, logId: someId })), 'CUSTOM_LOG_RECORD_NOT_FOUND');
  assert.equal(await codeOf(core.customLog.get({ ...scope, transactionId: 'tx' })), 'CUSTOM_LOG_RECORD_NOT_FOUND');
  assert.equal(await codeOf(core.customLog.list({ ...scope, cursor: 'abc' })), 'CUSTOM_LOG_INVALID_CURSOR');
  assert.equal(org.received, 0);
});

// ---------------------------------------------------------------------------------------------
// Routing

test('an event id without a source asks for one, and an event source refuses a record id', async t => {
  const { core, scope } = await world(t, { events: [logEvent(1, T0)] });
  const id = (await core.customLog.list(scope)).rows[0]!.id;
  const { source: _source, ...withoutSource } = scope;

  assert.equal(await codeOf(core.customLog.get({ ...withoutSource, logId: id })), 'CUSTOM_LOG_SOURCE_REQUIRED');
  assert.equal(await codeOf(core.customLog.entry({ ...withoutSource, entryId: id })), 'CUSTOM_LOG_SOURCE_REQUIRED');
  assert.equal(await codeOf(core.customLog.entry({ ...scope, entryId: 'a010000000000AAAAA' })), 'INVALID_ARGUMENT');
  assert.equal(await codeOf(core.customLog.get({ ...scope, logId: 'a020000000000AAAAA' })), 'INVALID_ARGUMENT');
});

test('an event source needs a place to keep its events: no project directory is CUSTOM_LOG_STORE_UNAVAILABLE', async t => {
  const { core, username } = await world(t, { project: null });

  const code = await codeOf(
    core.customLog.list({ targetOrg: username, projectDir: undefined, source: 'nebula-events' })
  );

  assert.equal(code, 'CUSTOM_LOG_STORE_UNAVAILABLE');
});

test('a mapping the stored describe cannot satisfy is an unavailable source, not a wrong answer', async t => {
  const source = alvEvents({ fields: { time: 'Logged_At__c', message: 'Not_In_The_Describe__c' } });
  const { core, scope } = await world(t, { events: [logEvent(1, T0)], source });

  assert.equal(await codeOf(core.customLog.list(scope)), 'CUSTOM_LOG_SOURCE_UNAVAILABLE');
});

test('an unknown source id still gets the catalog error from the org', async t => {
  const org = await startNebulaOrg(t, { describes: 'unlocked-admin', objects: ['Log__c', 'LogEntry__c'] });
  const username = `event-read-${nextUser++}@example.com`;
  await saveOrgAuth(username, org.instanceUrl);
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());

  const code = await codeOf(core.customLog.list({ targetOrg: username, projectDir: undefined, source: 'nope' }));

  assert.equal(code, 'CUSTOM_LOG_SOURCE_NOT_FOUND');
});

// ---------------------------------------------------------------------------------------------
// sources, and the implicit choice

test('sources reports the store of an event source in any state, and never makes one the default', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: ['Log__c', 'LogEntry__c', 'LogEntryEvent__e'],
    extraDescribes: { LogEntryEvent__e: logEntryEventDescribe() }
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-event-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify(projectWith(alvEvents())));
  const username = `event-read-${nextUser++}@example.com`;
  await saveOrgAuth(username, org.instanceUrl);
  await seedEventStore({ root, username, describe: alvTestLogDescribe(), events: [logEvent(1, T0)] });
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());

  const result = await core.customLog.sources({ targetOrg: username, projectDir: root });

  const byId = Object.fromEntries(result.sources.map(source => [source.id, source]));
  assert.equal(byId[SOURCE]!.state, 'unavailable', 'the org has no ALV_Test_Log__e');
  assert.equal(byId[SOURCE]!.store?.state, 'captured', 'the store is still reported');
  assert.equal(byId['nebula-events']!.state, 'ready');
  assert.equal(byId['nebula-events']!.store?.state, 'notCaptured');
  assert.equal(byId.nebula!.store, undefined, 'a record source has no store');
  assert.equal(result.defaultSourceId, 'nebula');
});

test('with Nebula and nebula-events both ready, list without a source reads Nebula and never captures or reads the store', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: ['Log__c', 'LogEntry__c', 'LogEntryEvent__e'],
    extraDescribes: { LogEntryEvent__e: logEntryEventDescribe() },
    answer: soql => (soql.includes('FROM Log__c') ? page([]) : undefined)
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-event-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const username = `event-read-${nextUser++}@example.com`;
  await saveOrgAuth(username, org.instanceUrl);
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());

  const sources = await core.customLog.sources({ targetOrg: username, projectDir: root });
  const implicit = await core.customLog.list({ targetOrg: username, projectDir: root });
  const explicit = await core.customLog.list({ targetOrg: username, projectDir: root, source: 'nebula-events' });

  assert.deepEqual(
    sources.sources.map(source => `${source.id}:${source.state}`),
    ['nebula:ready', 'nebula-managed:notInstalled', 'nebula-events:ready', 'nebula-events-managed:notInstalled']
  );
  assert.equal(implicit.source.id, 'nebula');
  assert.equal(explicit.source.id, 'nebula-events');
  assert.equal(explicit.store?.state, 'notCaptured');
  assert.equal(org.soql('data').length, 1, 'only the Nebula read queried data; the event read queried nothing');
});

// ---------------------------------------------------------------------------------------------
// The Nebula event preset over a store captured with the measured describe

test('nebula-events reads a stored LogEntryEvent__e offline: level from the ordinal, time from the epoch, user from the logger', async t => {
  const describe = logEntryEventDescribe();
  const at = T0 + 5 * MINUTE;
  const nebula = (n: number, extra: Json) =>
    busEvent(n, at + n, {
      EpochTimestamp__c: at + n,
      Message__c: `entry ${n}`,
      LoggingLevelOrdinal__c: 8,
      LoggingLevel__c: 'ERROR',
      LoggedByUsername__c: 'dev@acme.com',
      TransactionId__c: 'tx-nebula',
      TransactionEntryNumber__c: n,
      RequestId__c: 'SLB:req-n',
      ExceptionStackTrace__c: 'Class.Foo.bar: line 4',
      ...extra
    });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-event-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const username = `event-read-${nextUser++}@example.com`;
  const org = await startSalesforceDouble(t, () => ({
    status: 500,
    body: [{ errorCode: 'UNEXPECTED', message: 'no' }]
  }));
  await saveOrgAuth(username, org.instanceUrl);
  await seedEventStore({
    root,
    username,
    describe,
    events: [nebula(1, {}), nebula(2, { LoggingLevelOrdinal__c: 6, LoggingLevel__c: 'INFO' })]
  });
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());
  const scope = { targetOrg: username, projectDir: root, source: 'nebula-events' };

  const list = await core.customLog.list(scope);
  const errors = await core.customLog.list({ ...scope, filter: { minLevel: 'ERROR' } });
  const entry = await core.customLog.entry({ ...scope, entryId: list.rows[0]!.id });

  assert.deepEqual(
    list.rows.map(row => [row.title, row.level, row.user, row.time, row.transactionId]),
    [
      ['entry 2', 'INFO', 'dev@acme.com', new Date(at + 2).toISOString(), 'tx-nebula'],
      ['entry 1', 'ERROR', 'dev@acme.com', new Date(at + 1).toISOString(), 'tx-nebula']
    ]
  );
  assert.deepEqual(messages(errors.rows), ['entry 1']);
  assert.equal(entry.details.find(detail => detail.key === 'ExceptionStackTrace__c')?.state, 'value');
  assert.equal(org.received, 0);
});
