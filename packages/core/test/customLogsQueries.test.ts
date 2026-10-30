import assert from 'node:assert/strict';
import test from 'node:test';

import { AlvError } from '../src/index.ts';
import { parseCustomLogsConfig } from '../src/customLogs/config.ts';
import { CUSTOM_LOG_CELL_CHARS, CUSTOM_LOG_MESSAGE_PREVIEW_CHARS } from '../src/customLogs/contracts.ts';
import { shortHash } from '../src/customLogs/hash.ts';
import { levelFromOrdinal, normalizeLevel, parseCustomLogLevel } from '../src/customLogs/levels.ts';
import { NEBULA_MANAGED_PRESET, NEBULA_PRESET } from '../src/customLogs/presets.ts';
import {
  apexLogLinkPlan,
  decodeCursor,
  encodeCursor,
  entriesPlan,
  entriesScopeOf,
  entryPlan,
  listPlan,
  parseRecordId,
  rowPlan,
  transactionLookupPlan,
  type CursorBinding,
  type CursorPayload
} from '../src/customLogs/queries.ts';
import { toSourceInfo } from '../src/customLogs/catalog.ts';
import { resolveDefinition } from '../src/customLogs/resolve.ts';
import type { CatalogEntry, ResolvedSource } from '../src/customLogs/resolved.ts';
import { parseSinceExpression } from '../src/customLogs/since.ts';
import { describeFixture } from './support/describeFixtures.ts';

function ready(entry: CatalogEntry): ResolvedSource {
  assert.equal(entry.state, 'ready', JSON.stringify(entry));
  return (entry as Extract<CatalogEntry, { state: 'ready' }>).source;
}

const unlocked = ready(resolveDefinition(NEBULA_PRESET.definition, 'builtin', '', describeFixture('unlocked-admin')));
const managed = ready(
  resolveDefinition(NEBULA_MANAGED_PRESET.definition, 'builtin', 'Nebula', describeFixture('managed-admin'))
);
const managedEndUser = ready(
  resolveDefinition(NEBULA_MANAGED_PRESET.definition, 'builtin', 'Nebula', describeFixture('managed-enduser'))
);
const appLog = ready(
  resolveDefinition(
    parseCustomLogsConfig({
      sources: [
        {
          id: 'app-log',
          entry: {
            object: 'App_Log__c',
            fields: {
              time: 'Logged_At__c',
              message: 'Message__c',
              level: 'Level__c',
              user: 'CreatedBy.Username',
              requestId: 'Request_Id__c'
            },
            details: ['Stack_Trace__c'],
            payload: { field: 'Payload__c', columns: ['orderId'] }
          },
          levels: {}
        }
      ]
    }).sources[0]!,
    'config',
    '',
    describeFixture('unlocked-admin')
  )
);
const headerId = parseRecordId('a02000000000001AAA', 'id');
const entryId = parseRecordId('a01000000000001AAA', 'id');

/** The SELECT list compared as a set of fields; the rest of the statement exactly. */
function assertSoql(actual: string, expected: string): void {
  const parts = (soql: string) => {
    const match = /^SELECT (.+?) FROM (.+)$/s.exec(soql);
    assert.ok(match, soql);
    return { fields: match[1]!.split(', ').sort(), rest: match[2] };
  };
  assert.deepEqual(parts(actual), parts(expected));
}

const ROW_SELECT_UNLOCKED =
  'Id, CreatedDate, StartTime__c, Name, LoggedByUsername__c, TransactionId__c, RequestId__c, TotalLogEntries__c, TotalERRORLogEntries__c, TotalWARNLogEntries__c, MaxLogEntryLoggingLevelOrdinal__c, SystemMode__c, TransactionScenarioName__c, Status__c';
const ENTRY_SELECT_UNLOCKED =
  'Id, CreatedDate, EpochTimestamp__c, Message__c, MessageTruncated__c, TransactionEntryNumber__c, LoggingLevel__c, LoggingLevelOrdinal__c, OriginLocation__c, ExceptionType__c, RecordId__c, OriginType__c, HasExceptionStackTrace__c, HasStackTrace__c, HasRecordJson__c, HasHttpRequestBody__c, HasHttpResponseBody__c, HasRestRequestBody__c, HasRestResponseBody__c, HasDatabaseResultJson__c';

test('unlocked Nebula: a plain page asks for one row more than the limit, newest first', () => {
  const plan = listPlan(unlocked, { limit: 50, filter: {} });

  assertSoql(plan.soql, `SELECT ${ROW_SELECT_UNLOCKED} FROM Log__c ORDER BY CreatedDate DESC, Id DESC LIMIT 51`);
  assert.equal(plan.maxRecords, 51);
  assert.equal(plan.api, 'data');
});

test('every filter becomes a WHERE clause on the field the source resolved for it', () => {
  const plan = listPlan(unlocked, {
    limit: 1,
    filter: {
      minLevel: 'ERROR',
      user: "o'brien@acme.com",
      since: '2026-10-29T00:00:00.000Z',
      until: '2026-10-30T00:00:00.000Z'
    },
    after: {
      v: 1,
      o: 'x',
      s: 'nebula',
      m: 'x',
      k: 'list',
      f: 'x',
      t: '2026-10-29T23:29:49.000Z',
      id: 'a02000000000001AAA'
    }
  });

  assertSoql(
    plan.soql,
    `SELECT ${ROW_SELECT_UNLOCKED} FROM Log__c WHERE MaxLogEntryLoggingLevelOrdinal__c >= 8 AND LoggedByUsername__c = 'o\\'brien@acme.com' AND StartTime__c >= 2026-10-29T00:00:00.000Z AND StartTime__c < 2026-10-30T00:00:00.000Z AND (CreatedDate < 2026-10-29T23:29:49.000Z OR (CreatedDate = 2026-10-29T23:29:49.000Z AND Id < 'a02000000000001AAA')) ORDER BY CreatedDate DESC, Id DESC LIMIT 2`
  );
});

test('managed Nebula: custom names carry the namespace and standard names do not', () => {
  const plan = listPlan(managed, { limit: 50, filter: { minLevel: 'WARN' } });

  assertSoql(
    plan.soql,
    'SELECT Id, CreatedDate, Nebula__StartTime__c, Name, Nebula__LoggedByUsername__c, Nebula__TransactionId__c, Nebula__RequestId__c, Nebula__TotalLogEntries__c, Nebula__TotalERRORLogEntries__c, Nebula__TotalWARNLogEntries__c, Nebula__MaxLogEntryLoggingLevelOrdinal__c, Nebula__SystemMode__c, Nebula__TransactionScenarioName__c, Nebula__Status__c FROM Nebula__Log__c WHERE Nebula__MaxLogEntryLoggingLevelOrdinal__c >= 7 ORDER BY CreatedDate DESC, Id DESC LIMIT 51'
  );
});

test('a header read and a transaction-id lookup are one small query each', () => {
  assertSoql(
    rowPlan(unlocked, headerId).soql,
    `SELECT ${ROW_SELECT_UNLOCKED} FROM Log__c WHERE Id = 'a02000000000001AAA' LIMIT 1`
  );
  assertSoql(
    transactionLookupPlan(unlocked, "c10c'1fd8").soql,
    "SELECT Id FROM Log__c WHERE TransactionId__c = 'c10c\\'1fd8' ORDER BY CreatedDate DESC, Id DESC LIMIT 2"
  );
  assert.equal(
    transactionLookupPlan(unlocked, 'c10c1fd8').decode([{ Id: 'a02000000000001AAA' }, { Id: 'a02000000000002AAA' }])
      .length,
    2
  );
});

test('entries of a header page by sequence then Id, and a cursor continues after the last pair', () => {
  const first = entriesPlan(unlocked, entriesScopeOf(unlocked, headerId), { limit: 200, minLevel: 'INFO' });
  const next = entriesPlan(unlocked, entriesScopeOf(unlocked, headerId), {
    limit: 2,
    after: { v: 1, o: 'x', s: 'nebula', m: 'x', k: 'entries', f: 'x', t: 31, id: 'a01000000000001AAA', n: 30 }
  });

  assertSoql(
    first.soql,
    `SELECT ${ENTRY_SELECT_UNLOCKED} FROM LogEntry__c WHERE Log__c = 'a02000000000001AAA' AND LoggingLevelOrdinal__c >= 6 ORDER BY TransactionEntryNumber__c ASC NULLS FIRST, Id ASC LIMIT 201`
  );
  assertSoql(
    next.soql,
    `SELECT ${ENTRY_SELECT_UNLOCKED} FROM LogEntry__c WHERE Log__c = 'a02000000000001AAA' AND (TransactionEntryNumber__c > 31 OR (TransactionEntryNumber__c = 31 AND Id > 'a01000000000001AAA')) ORDER BY TransactionEntryNumber__c ASC NULLS FIRST, Id ASC LIMIT 3`
  );
});

test('an entry read selects every readable detail and flag, and never a detail the user cannot read', () => {
  const admin = entryPlan(unlocked, entryId).soql;
  const enduser = entryPlan(managedEndUser, entryId).soql;

  assertSoql(
    admin,
    `SELECT ${ENTRY_SELECT_UNLOCKED}, Log__c, ExceptionMessage__c, ExceptionStackTrace__c, StackTrace__c, RecordJson__c, RecordJsonTruncated__c, HttpRequestEndpointAddress__c, HttpRequestBody__c, HttpRequestBodyTruncated__c, HttpResponseBody__c, HttpResponseBodyTruncated__c, RestRequestBody__c, RestRequestBodyTruncated__c, RestResponseBody__c, RestResponseBodyTruncated__c, DatabaseResultJson__c, Tags__c FROM LogEntry__c WHERE Id = 'a01000000000001AAA' LIMIT 1`
  );
  assertSoql(
    enduser,
    "SELECT Id, CreatedDate, Nebula__EpochTimestamp__c, Nebula__Message__c, Nebula__MessageTruncated__c, Nebula__TransactionEntryNumber__c, Nebula__LoggingLevel__c, Nebula__LoggingLevelOrdinal__c, Nebula__OriginLocation__c, Nebula__RecordId__c, Nebula__OriginType__c, Nebula__HasExceptionStackTrace__c, Nebula__HasStackTrace__c, Nebula__HasRecordJson__c, Nebula__HasHttpRequestBody__c, Nebula__HasHttpResponseBody__c, Nebula__HasRestRequestBody__c, Nebula__HasRestResponseBody__c, Nebula__HasDatabaseResultJson__c, Nebula__Log__c, Nebula__ExceptionMessage__c, Nebula__RecordJson__c, Nebula__RecordJsonTruncated__c FROM Nebula__LogEntry__c WHERE Id = 'a01000000000001AAA' LIMIT 1"
  );
  assert.doesNotMatch(enduser, /StackTrace__c, Nebula__Log|Nebula__StackTrace__c,|Nebula__Tags__c/);
});

test('a one-object source lists entries and filters its level by picklist spellings and its user by relationship', () => {
  const plan = listPlan(appLog, { limit: 50, filter: { minLevel: 'WARN', user: 'a@b.c' } });
  const entries = entriesPlan(appLog, entriesScopeOf(appLog, entryId), { limit: 200 });

  assertSoql(
    plan.soql,
    "SELECT Id, CreatedDate, Logged_At__c, Message__c, Level__c, CreatedBy.Username, Request_Id__c, Payload__c FROM App_Log__c WHERE Level__c IN ('WARNING','ERROR') AND CreatedBy.Username = 'a@b.c' ORDER BY CreatedDate DESC, Id DESC LIMIT 51"
  );
  assert.match(
    entries.soql,
    /WHERE Id = 'a01000000000001AAA' ORDER BY Logged_At__c ASC NULLS FIRST, Id ASC LIMIT 201$/
  );
});

test('a filter the source has no mapping for is refused instead of ignored', () => {
  const codeOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error instanceof AlvError ? error.code : String(error);
    }
    return undefined;
  };

  assert.equal(
    codeOf(() => transactionLookupPlan(appLog, 'tx')),
    'CUSTOM_LOG_UNSUPPORTED_FILTER'
  );
  assert.deepEqual(entriesScopeOf(appLog, entryId, 'tx'), { kind: 'single', id: entryId });
});

test('a user role on a field SOQL cannot filter is no user filter', () => {
  const raw = NEBULA_PRESET.raw as { transaction: Record<string, any> };
  const definition = parseCustomLogsConfig({
    sources: [
      {
        ...NEBULA_PRESET.raw,
        id: 'nebula-comments',
        transaction: { ...raw.transaction, fields: { ...raw.transaction.fields, user: 'Comments__c' } }
      }
    ]
  }).sources[0]!;
  const entry = resolveDefinition(definition, 'config', '', describeFixture('unlocked-admin'));
  const source = ready(entry);

  assert.equal(toSourceInfo(entry).capabilities.userFilter, false);
  assert.throws(
    () => listPlan(source, { limit: 5, filter: { user: 'dev@acme.com' } }),
    (error: unknown) => error instanceof AlvError && error.code === 'CUSTOM_LOG_UNSUPPORTED_FILTER'
  );
  assert.match(listPlan(source, { limit: 5, filter: {} }).soql, /^SELECT .*Comments__c/);
});

test('a header without maxLevelOrdinal filters levels through a semi-join on its entries', () => {
  const raw = {
    ...NEBULA_PRESET.raw,
    id: 'nebula-semi',
    transaction: {
      ...(NEBULA_PRESET.raw.transaction as Record<string, unknown>),
      fields: Object.fromEntries(
        Object.entries((NEBULA_PRESET.raw.transaction as { fields: Record<string, string> }).fields).filter(
          ([role]) => role !== 'maxLevelOrdinal'
        )
      )
    }
  };
  const source = ready(
    resolveDefinition(
      parseCustomLogsConfig({ sources: [raw] }).sources[0]!,
      'config',
      '',
      describeFixture('unlocked-admin')
    )
  );

  assert.match(
    listPlan(source, { limit: 5, filter: { minLevel: 'ERROR' } }).soql,
    /WHERE Id IN \(SELECT Log__c FROM LogEntry__c WHERE LoggingLevelOrdinal__c >= 8\) ORDER BY/
  );
});

test('list rows decode counts, the level from the ordinal, and fall back to CreatedDate for an empty start time', () => {
  const plan = listPlan(unlocked, { limit: 2, filter: {} });

  const page = plan.decode([
    {
      Id: 'a02000000000002AAA',
      CreatedDate: '2026-10-30T00:48:11.000+0000',
      StartTime__c: '2026-10-30T00:48:10.000+0000',
      Name: 'Log-000280',
      LoggedByUsername__c: 'dev@acme.com',
      TransactionId__c: 'tx-1',
      RequestId__c: 'SLB:abc',
      TotalLogEntries__c: 6,
      TotalERRORLogEntries__c: 1,
      TotalWARNLogEntries__c: 0,
      MaxLogEntryLoggingLevelOrdinal__c: 8,
      SystemMode__c: 'ANONYMOUS',
      TransactionScenarioName__c: null,
      Status__c: 'New'
    },
    { Id: 'a02000000000003AAA', CreatedDate: '2026-10-30T00:45:45.000+0000', StartTime__c: null, Name: 'Log-000214' },
    { Id: 'a02000000000001AAA', CreatedDate: '2026-10-30T00:45:41.000+0000' }
  ]);

  assert.deepEqual(page.items, [
    {
      id: 'a02000000000002AAA',
      time: '2026-10-30T00:48:10.000Z',
      title: 'Log-000280',
      user: 'dev@acme.com',
      level: 'ERROR',
      counts: { entries: 6, errors: 1, warnings: 0 },
      transactionId: 'tx-1',
      requestId: 'SLB:abc',
      extra: { SystemMode__c: 'ANONYMOUS', TransactionScenarioName__c: null, Status__c: 'New' }
    },
    {
      id: 'a02000000000003AAA',
      time: '2026-10-30T00:45:45.000Z',
      title: 'Log-000214',
      extra: { SystemMode__c: null, TransactionScenarioName__c: null, Status__c: null }
    }
  ]);
  assert.deepEqual(page.payloadFields, []);
  assert.deepEqual(page.next, { t: '2026-10-30T00:45:45.000Z', id: 'a02000000000003AAA', n: 2 });
  assert.equal(plan.decode([]).next, undefined);
});

test('entries decode epoch times, levels, the system flag, present details and the position when no order is mapped', () => {
  const record = {
    Id: 'a01000000000001AAA',
    CreatedDate: '2026-10-30T00:48:11.000+0000',
    EpochTimestamp__c: 1793321290765,
    Message__c: 'Nebula Logger - Saving 2 log entries via ANONYMOUS',
    MessageTruncated__c: false,
    TransactionEntryNumber__c: 7,
    LoggingLevel__c: 'FINEST',
    LoggingLevelOrdinal__c: 2,
    OriginLocation__c: 'OrderSync.run',
    OriginType__c: 'Apex',
    HasStackTrace__c: true,
    HasRecordJson__c: false
  };

  const [entry] = entriesPlan(unlocked, entriesScopeOf(unlocked, headerId), { limit: 5 }).decode([record]).items;

  assert.deepEqual(entry, {
    id: 'a01000000000001AAA',
    sequence: 7,
    time: '2026-10-30T00:48:10.765Z',
    level: 'FINEST',
    rawLevel: 'FINEST',
    message: 'Nebula Logger - Saving 2 log entries via ANONYMOUS',
    previewClipped: false,
    messageTruncated: false,
    origin: 'OrderSync.run',
    system: true,
    presentDetails: ['StackTrace__c'],
    extra: { OriginType__c: 'Apex' }
  });

  const unordered = entriesPlan(appLog, entriesScopeOf(appLog, entryId), { limit: 5, after: undefined });
  const positions = unordered
    .decode([
      { Id: 'a06000000000001AAA', Logged_At__c: '2026-10-30T00:29:16.000+0000', Message__c: 'a' },
      { Id: 'a06000000000002AAA', Message__c: 'b' }
    ])
    .items.map(item => item.sequence);
  assert.deepEqual(positions, [1, 2]);
});

test('a long message is cut for the list of entries and complete in the entry read', () => {
  const message = 'm'.repeat(2500);
  const record = {
    Id: 'a01000000000001AAA',
    CreatedDate: '2026-10-30T00:48:11.000+0000',
    Message__c: message,
    TransactionEntryNumber__c: 1
  };

  const [clipped] = entriesPlan(unlocked, entriesScopeOf(unlocked, headerId), { limit: 5 }).decode([record]).items;
  const full = entryPlan(unlocked, entryId).decode([record]);

  assert.equal(clipped?.message.length, 2000);
  assert.equal(clipped?.previewClipped, true);
  assert.equal(full?.entry.message.length, 2500);
  assert.equal(full?.entry.previewClipped, false);
});

test('a long text field mapped to a column or a text role reaches a row or entry cell cut to the cell cap', () => {
  const raw = NEBULA_PRESET.raw as { transaction: Record<string, any>; entry: Record<string, any> };
  const source = ready(
    resolveDefinition(
      parseCustomLogsConfig({
        sources: [
          {
            ...NEBULA_PRESET.raw,
            id: 'nebula-long',
            transaction: {
              ...raw.transaction,
              fields: { ...raw.transaction.fields, name: 'Comments__c', user: 'OrganizationLimits__c' },
              columns: ['Comments__c']
            },
            entry: {
              ...raw.entry,
              fields: { ...raw.entry.fields, origin: 'StackTrace__c', exceptionType: 'Tags__c' },
              columns: ['ExceptionMessage__c']
            }
          }
        ]
      }).sources[0]!,
      'config',
      '',
      describeFixture('unlocked-admin')
    )
  );
  const long = 'x'.repeat(100_000);

  const [row] = listPlan(source, { limit: 5, filter: {} }).decode([
    { Id: headerId, CreatedDate: '2026-10-30T00:48:11.000+0000', Comments__c: long, OrganizationLimits__c: long }
  ]).items;
  const [entry] = entriesPlan(source, entriesScopeOf(source, headerId), { limit: 5 }).decode([
    { Id: entryId, Message__c: long, StackTrace__c: long, Tags__c: long, ExceptionMessage__c: long }
  ]).items;
  const single = entryPlan(source, entryId).decode([{ Id: entryId, Message__c: long, StackTrace__c: long }]);

  assert.equal(CUSTOM_LOG_CELL_CHARS, 255);
  assert.deepEqual(
    [row?.title, row?.user, row?.extra.Comments__c].map(value => String(value).length),
    [255, 255, 255]
  );
  assert.deepEqual(
    [entry?.origin, entry?.exceptionType, entry?.extra.ExceptionMessage__c].map(value => String(value).length),
    [255, 255, 255]
  );
  assert.equal(entry?.message.length, CUSTOM_LOG_MESSAGE_PREVIEW_CHARS);
  assert.equal(single?.entry.message.length, long.length);
  assert.equal(single?.entry.origin?.length, 255);
  assert.equal(
    entriesPlan(appLog, entriesScopeOf(appLog, entryId), { limit: 5 }).decode([{ Id: entryId, Message__c: long }])
      .items[0]?.message.length,
    CUSTOM_LOG_MESSAGE_PREVIEW_CHARS
  );
  assert.equal(
    listPlan(appLog, { limit: 5, filter: {} }).decode([{ Id: entryId, Message__c: long }]).items[0]?.title?.length,
    255
  );
});

test('an entry read answers every mapped detail with its state, hidden ones included', () => {
  const record = {
    Id: 'a01000000000901AAA',
    Nebula__Log__c: 'a02000000000901AAA',
    CreatedDate: '2026-10-30T00:48:11.000+0000',
    Nebula__Message__c: 'Divide by 0',
    Nebula__HasStackTrace__c: true,
    Nebula__ExceptionMessage__c: 'Divide by 0',
    Nebula__RecordJson__c: '{"attributes":{"type":"Account"}}',
    Nebula__RecordJsonTruncated__c: true
  };

  const read = entryPlan(managedEndUser, entryId).decode([record]);

  assert.equal(read?.logId, 'a02000000000901AAA');
  assert.deepEqual(read?.rawPayload, { state: 'unmapped' });
  const byKey = Object.fromEntries((read?.details ?? []).map(detail => [detail.key, detail]));
  assert.deepEqual(byKey.ExceptionMessage__c, {
    key: 'ExceptionMessage__c',
    label: 'Exception Message',
    state: 'value',
    value: 'Divide by 0',
    format: 'text'
  });
  assert.deepEqual(byKey.StackTrace__c, { key: 'StackTrace__c', label: 'Stack Trace', state: 'hidden' });
  assert.deepEqual(byKey.RecordJson__c, {
    key: 'RecordJson__c',
    label: 'Related Record JSON',
    state: 'value',
    value: '{"attributes":{"type":"Account"}}',
    format: 'json',
    truncated: true
  });
  assert.equal(read?.details.length, 11);
  assert.equal(entryPlan(managedEndUser, entryId).decode([]), undefined);
});

test('payloads decode per row, the page summarizes whole payloads, and --payload-fields trims afterwards', () => {
  const records = [
    {
      Id: 'a06000000000001AAA',
      CreatedDate: '2026-10-30T00:29:16.000+0000',
      Message__c: 'ok',
      Level__c: 'ERROR',
      Payload__c: '{"orderId":"A","http":{"status":502}}'
    },
    {
      Id: 'a06000000000002AAA',
      CreatedDate: '2026-10-30T00:29:15.000+0000',
      Message__c: 'plain',
      Level__c: 'INFO',
      Payload__c: 'just text'
    },
    {
      Id: 'a06000000000003AAA',
      CreatedDate: '2026-10-30T00:29:14.000+0000',
      Message__c: 'bad',
      Level__c: 'INFO',
      Payload__c: '{"x":'
    },
    {
      Id: 'a06000000000004AAA',
      CreatedDate: '2026-10-30T00:29:13.000+0000',
      Message__c: 'none',
      Level__c: 'INFO',
      Payload__c: null
    }
  ];

  const all = listPlan(appLog, { limit: 10, filter: {} }).decode(records);
  const trimmed = listPlan(appLog, { limit: 10, filter: {}, keep: new Set(['orderId']) }).decode(records);

  assert.deepEqual(
    all.items.map(item => item.payload?.state),
    ['parsed', 'text', 'invalid', 'empty']
  );
  assert.deepEqual(all.payloadFields, [
    { path: 'orderId', types: ['string'], rows: 1 },
    { path: 'http.status', types: ['number'], rows: 1 }
  ]);
  assert.deepEqual(trimmed.items[0]?.payload, {
    state: 'parsed',
    values: { orderId: 'A' },
    droppedPaths: 0,
    cutValues: []
  });
  assert.deepEqual(trimmed.payloadFields, all.payloadFields);
  assert.equal(all.items[0]?.level, 'ERROR');
});

test('a row whose payload field the user cannot read says so instead of looking empty', () => {
  const describes = new Map(describeFixture('unlocked-admin'));
  const log = describes.get('App_Log__c')!;
  describes.set('App_Log__c', { ...log, fields: log.fields.filter(field => field.name !== 'Payload__c') });
  const source = ready(
    resolveDefinition(
      parseCustomLogsConfig({
        sources: [
          {
            id: 'app-log',
            entry: {
              object: 'App_Log__c',
              fields: { time: 'CreatedDate', message: 'Message__c' },
              payload: 'Payload__c'
            }
          }
        ]
      }).sources[0]!,
      'config',
      '',
      describes
    )
  );

  const plan = listPlan(source, { limit: 5, filter: {} });

  assert.doesNotMatch(plan.soql, /Payload__c/);
  assert.deepEqual(
    plan.decode([{ Id: 'a06000000000001AAA', CreatedDate: '2026-10-30T00:29:16.000+0000', Message__c: 'm' }]).items[0]
      ?.payload,
    {
      state: 'hidden'
    }
  );
});

test('the Apex log link is one Tooling query on the request identifier', () => {
  const plan = apexLogLinkPlan("SLB:ab'c");

  assert.equal(plan.api, 'tooling');
  assertSoql(
    plan.soql,
    "SELECT Id, StartTime, LogLength FROM ApexLog WHERE RequestIdentifier = 'SLB:ab\\'c' ORDER BY StartTime ASC LIMIT 1"
  );
  assert.deepEqual(
    plan.decode([{ Id: '07L000000000001AAA', StartTime: '2026-10-30T00:48:10.000+0000', LogLength: 2624 }]),
    {
      state: 'linked',
      logId: '07L000000000001AAA',
      startTime: '2026-10-30T00:48:10.000Z',
      logLength: 2624
    }
  );
  assert.deepEqual(plan.decode([]), { state: 'notFound' });
});

// ---------------------------------------------------------------------------------------------
// Cursor

const binding: CursorBinding = {
  o: '00D000000000001AAA',
  s: 'nebula',
  m: 'abcdef012345',
  k: 'list',
  f: '0123456789ab'
};
const cursor: CursorPayload = { v: 1, ...binding, t: '2026-10-30T00:48:11.000Z', id: 'a02000000000002AAA' };

function rejects(token: string, expected: CursorBinding, pattern: RegExp) {
  assert.throws(
    () => decodeCursor(token, expected),
    (error: unknown) =>
      error instanceof AlvError && error.code === 'CUSTOM_LOG_INVALID_CURSOR' && pattern.test(error.message)
  );
}

test('a record id is 15 or 18 characters, nothing in between', () => {
  for (const id of ['a02000000000001', 'a02000000000001AAA']) assert.equal(parseRecordId(id, 'logId'), id);
  for (const id of ['a020000000000012', 'a0200000000000123', 'a02000000000001AAAA', "a02000000000001'"]) {
    assert.throws(
      () => parseRecordId(id, 'logId'),
      (error: unknown) => error instanceof AlvError && error.code === 'INVALID_ARGUMENT',
      id
    );
  }
});

test('a cursor round-trips with its window and position', () => {
  const full: CursorPayload = { ...cursor, w: { since: '2026-10-29T00:00:00.000Z' }, n: 50 };
  const entries: CursorPayload = { ...cursor, k: 'entries', t: 31 };
  const empty: CursorPayload = { ...cursor, k: 'entries', t: null };

  assert.deepEqual(decodeCursor(encodeCursor(full), binding), full);
  assert.deepEqual(decodeCursor(encodeCursor(entries), { ...binding, k: 'entries' }), entries);
  assert.deepEqual(decodeCursor(encodeCursor(empty), { ...binding, k: 'entries' }), empty);
  const largest: CursorPayload = { ...cursor, k: 'entries', t: 999999999999999999 };
  assert.deepEqual(decodeCursor(encodeCursor(largest), { ...binding, k: 'entries' }), largest);
  assert.match(encodeCursor(full), /^[A-Za-z0-9_-]+$/);
});

test('a cursor is rejected for another org, source, mapping, kind or filter', () => {
  const token = encodeCursor(cursor);

  rejects(token, { ...binding, o: '00D000000000002AAA' }, /another org/);
  rejects(token, { ...binding, s: 'nebula-managed' }, /another source/);
  rejects(token, { ...binding, m: 'ffffffffffff' }, /mapping changed/);
  rejects(token, { ...binding, k: 'entries' }, /another kind/);
  rejects(token, { ...binding, f: 'aaaaaaaaaaaa' }, /other filters/);
});

test('a malformed cursor is rejected before any value can reach SOQL', () => {
  const forged = (change: Record<string, unknown>) =>
    Buffer.from(JSON.stringify({ ...cursor, ...change })).toString('base64url');

  rejects('not a token!', binding, /malformed/);
  rejects('A'.repeat(3000), binding, /malformed/);
  rejects(Buffer.from('{"v":1').toString('base64url'), binding, /malformed/);
  rejects(Buffer.from('[]').toString('base64url'), binding, /malformed/);
  rejects(forged({ v: 2 }), binding, /malformed/);
  rejects(forged({ id: "a02' OR Name != '" }), binding, /malformed/);
  rejects(forged({ t: "2026-10-30' OR Id != '" }), binding, /malformed/);
  rejects(forged({ t: 'yesterday' }), binding, /malformed/);
  rejects(forged({ w: { since: 'x' } }), binding, /malformed/);
  rejects(forged({ n: -1 }), binding, /malformed/);
  rejects(forged({ o: 'x y' }), binding, /malformed/);
  rejects(forged({ o: '00D0000000000012' }), binding, /malformed/);
  rejects(forged({ id: 'a0200000000000123' }), binding, /malformed/);
  rejects(forged({ k: 'entries', t: 1.0000000000000002e18 }), { ...binding, k: 'entries' }, /malformed/);
  rejects(forged({ n: 1e300 }), binding, /malformed/);
  const overflow = JSON.stringify({ ...cursor, k: 'entries', t: 7 }).replace('"t":7', '"t":1e400');
  rejects(Buffer.from(overflow).toString('base64url'), { ...binding, k: 'entries' }, /malformed/);
});

test('a position that does not fit the ordering of this source is refused', () => {
  const textual = {
    v: 1 as const,
    o: 'x',
    s: 'nebula',
    m: 'x',
    k: 'entries' as const,
    f: 'x',
    t: '2026-10-30T00:48:11.000Z',
    id: 'a01000000000001AAA'
  };

  assert.throws(
    () => entriesPlan(unlocked, entriesScopeOf(unlocked, headerId), { limit: 5, after: textual }),
    (error: unknown) => error instanceof AlvError && error.code === 'CUSTOM_LOG_INVALID_CURSOR'
  );
  assert.throws(
    () => listPlan(unlocked, { limit: 5, filter: {}, after: { ...textual, k: 'list', t: 5 } }),
    (error: unknown) => error instanceof AlvError && error.code === 'CUSTOM_LOG_INVALID_CURSOR'
  );
});

test('a numeric position reaches SOQL as plain digits', () => {
  const after = (t: number): CursorPayload => ({
    v: 1,
    o: 'x',
    s: 'nebula',
    m: 'x',
    k: 'entries',
    f: 'x',
    t,
    id: 'a01000000000001AAA'
  });
  const soqlAfter = (t: number) =>
    entriesPlan(unlocked, entriesScopeOf(unlocked, headerId), { limit: 5, after: after(t) }).soql;

  assert.match(
    soqlAfter(1e-7),
    /\(TransactionEntryNumber__c > 0\.0000001 OR \(TransactionEntryNumber__c = 0\.0000001 AND/
  );
  assert.match(soqlAfter(-2.5e-8), /TransactionEntryNumber__c > -0\.000000025 OR/);
  assert.doesNotMatch(soqlAfter(1e-7), /e-/);
});

test('a null position continues after the entries that have no sequence', () => {
  const plan = entriesPlan(unlocked, entriesScopeOf(unlocked, headerId), {
    limit: 5,
    after: { v: 1, o: 'x', s: 'nebula', m: 'x', k: 'entries', f: 'x', t: null, id: 'a01000000000001AAA' }
  });

  assert.match(
    plan.soql,
    /AND \(TransactionEntryNumber__c != null OR \(TransactionEntryNumber__c = null AND Id > 'a01000000000001AAA'\)\) ORDER BY/
  );
});

test('the filter hash ignores key order and changes with any value', () => {
  assert.equal(shortHash({ user: 'a', minLevel: 'ERROR' }), shortHash({ minLevel: 'ERROR', user: 'a' }));
  assert.notEqual(shortHash({ user: 'a' }), shortHash({ user: 'b' }));
  assert.notEqual(shortHash({ since: '24h' }), shortHash({ since: '7d' }));
});

// ---------------------------------------------------------------------------------------------
// Levels and time expressions

test('levels come from the ordinal when present and from the alias table otherwise', () => {
  const table = unlocked.levels;

  assert.deepEqual(normalizeLevel(table, 'Whatever', 7), { level: 'WARN', rawLevel: 'Whatever' });
  assert.deepEqual(normalizeLevel(table, 'warning', undefined), { level: 'WARN', rawLevel: 'warning' });
  assert.deepEqual(normalizeLevel(table, 'FATAL', 99), { level: 'ERROR', rawLevel: 'FATAL' });
  assert.deepEqual(normalizeLevel(table, 'Critical', undefined), { level: undefined, rawLevel: 'Critical' });
  assert.deepEqual(normalizeLevel(table, null, null), { level: undefined, rawLevel: undefined });
  assert.equal(levelFromOrdinal(2), 'FINEST');
  assert.equal(levelFromOrdinal(8), 'ERROR');
  assert.equal(levelFromOrdinal(1), undefined);
  assert.equal(levelFromOrdinal(9), undefined);
  assert.equal(parseCustomLogLevel('error'), 'ERROR');
  assert.equal(parseCustomLogLevel('NONE'), undefined);
});

test('since and until take durations counted back from now, or an ISO instant', () => {
  const now = new Date('2026-10-30T12:00:00.000Z');

  assert.equal(parseSinceExpression('30m', now), '2026-10-30T11:30:00.000Z');
  assert.equal(parseSinceExpression('24h', now), '2026-10-29T12:00:00.000Z');
  assert.equal(parseSinceExpression('7d', now), '2026-10-23T12:00:00.000Z');
  assert.equal(parseSinceExpression('2026-10-29T08:30:00-03:00', now), '2026-10-29T11:30:00.000Z');
  assert.equal(parseSinceExpression('2026-10-29', now), '2026-10-29T00:00:00.000Z');
  for (const bad of ['', '0h', '-5m', '1.5h', '24', '2026-10-29T08:30:00', 'yesterday', '99999999999d']) {
    assert.throws(
      () => parseSinceExpression(bad, now),
      (error: unknown) => error instanceof AlvError && error.code === 'INVALID_ARGUMENT',
      bad
    );
  }
});
