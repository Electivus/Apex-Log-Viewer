import assert from 'node:assert/strict';
import test from 'node:test';

import { AlvError } from '../src/index.ts';
import { parseCustomLogsConfig, parseSourceDefinition, type SourceDefinition } from '../src/customLogs/config.ts';
import { NEBULA_MANAGED_PRESET, NEBULA_PRESET } from '../src/customLogs/presets.ts';
import {
  CREATED_DATE,
  createSchemaMemo,
  defaultSourceId,
  detectPreset,
  memoizedSchemaReader,
  requireSource,
  requireSourceForRecord,
  resolveDefinition,
  toSourceInfo,
  type CatalogEntry,
  type ObjectDescribe,
  type ResolvedSource,
  type SourceCatalog
} from '../src/customLogs/resolve.ts';
import type { Json } from './support/customLogsFixtures.ts';
import { describeFixture, fakeSchemaReader } from './support/describeFixtures.ts';

const nebula = NEBULA_PRESET.definition;
const unlockedAdmin = describeFixture('unlocked-admin');
const unlockedEndUser = describeFixture('unlocked-enduser');
const managedAdmin = describeFixture('managed-admin');
const managedEndUser = describeFixture('managed-enduser');

/** The mapping a team would write for the harness `App_Log__c`, with a relationship path for the user. */
const harnessAppLog: Json = {
  id: 'app-log',
  entry: {
    object: 'App_Log__c',
    fields: {
      time: 'Logged_At__c',
      message: 'Message__c',
      level: 'Level__c',
      origin: 'Source__c',
      user: 'CreatedBy.Username',
      requestId: 'Request_Id__c'
    },
    details: ['Stack_Trace__c'],
    payload: { field: 'Payload__c', columns: ['orderId'] }
  }
};

function define(source: Json = harnessAppLog): SourceDefinition {
  const { sources, issues } = parseCustomLogsConfig({ sources: [source] });
  assert.deepEqual(issues, []);
  return sources[0]!;
}

/** A catalog entry's state without its head: what `sources` reports beside the names. */
function stateOf(entry: CatalogEntry) {
  const { head: _head, ...state } = entry;
  return state;
}

function ready(entry: CatalogEntry): ResolvedSource {
  assert.equal(entry.state, 'ready', JSON.stringify(entry));
  return (entry as Extract<CatalogEntry, { state: 'ready' }>).source;
}

function apiPaths(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(item => apiPaths(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'api' && typeof item === 'string') found.add(item);
      else apiPaths(item, found);
    }
  }
  return found;
}

test('unlocked Nebula resolves against the admin describe with nothing hidden', () => {
  const source = ready(resolveDefinition(nebula, 'builtin', '', unlockedAdmin));

  assert.deepEqual(source.hidden, []);
  assert.equal(source.shape.kind, 'transactions');
  assert.equal(source.shape.entry.object, 'LogEntry__c');
  assert.equal(source.shape.entry.keyPrefix, 'a01');
  assert.equal(source.shape.entry.sequence.api, 'TransactionEntryNumber__c');
  assert.equal(source.shape.entry.roles.time.encoding, 'epochMillis');
  assert.equal(source.shape.entry.timeFilter.api, 'EpochTimestamp__c');
  assert.deepEqual(source.shape.entry.levelPredicate.kind, 'ordinal');
  assert.equal(source.shape.entry.parent.api, 'Log__c');
  assert.equal(source.shape.transaction.object, 'Log__c');
  assert.equal(source.shape.transaction.keyPrefix, 'a02');
  assert.equal(source.shape.transaction.roles.startTime.encoding, 'datetime');
  assert.equal(source.shape.transaction.levelPredicate.kind, 'ordinal');
  assert.deepEqual(source.levels.unmapped, []);
  assert.deepEqual(
    source.shape.entry.details.map(detail => [detail.key, detail.state, detail.presence?.api, detail.truncated?.api]),
    [
      ['ExceptionMessage__c', 'readable', undefined, undefined],
      ['ExceptionStackTrace__c', 'readable', 'HasExceptionStackTrace__c', undefined],
      ['StackTrace__c', 'readable', 'HasStackTrace__c', undefined],
      ['RecordJson__c', 'readable', 'HasRecordJson__c', 'RecordJsonTruncated__c'],
      ['HttpRequestEndpointAddress__c', 'readable', undefined, undefined],
      ['HttpRequestBody__c', 'readable', 'HasHttpRequestBody__c', 'HttpRequestBodyTruncated__c'],
      ['HttpResponseBody__c', 'readable', 'HasHttpResponseBody__c', 'HttpResponseBodyTruncated__c'],
      ['RestRequestBody__c', 'readable', 'HasRestRequestBody__c', 'RestRequestBodyTruncated__c'],
      ['RestResponseBody__c', 'readable', 'HasRestResponseBody__c', 'RestResponseBodyTruncated__c'],
      ['DatabaseResultJson__c', 'readable', 'HasDatabaseResultJson__c', undefined],
      ['Tags__c', 'readable', undefined, undefined]
    ]
  );
});

test('managed Nebula qualifies every custom name with its namespace and keeps the unprefixed keys', () => {
  const source = ready(resolveDefinition(NEBULA_MANAGED_PRESET.definition, 'builtin', 'Nebula', managedAdmin));

  assert.equal(source.namespace, 'Nebula');
  assert.equal(source.shape.entry.object, 'Nebula__LogEntry__c');
  assert.equal(source.shape.entry.roles.message.api, 'Nebula__Message__c');
  assert.equal(source.shape.entry.roles.message.key, 'Message__c');
  assert.equal(source.shape.entry.sequence.api, 'Nebula__TransactionEntryNumber__c');
  assert.equal(source.shape.entry.columns[0]?.key, 'OriginType__c');
  assert.equal(source.shape.entry.columns[0]?.api, 'Nebula__OriginType__c');
  assert.equal(source.shape.kind === 'transactions' && source.shape.transaction.roles.name?.api, 'Name');
  assert.equal(source.shape.kind === 'transactions' && source.shape.transaction.object, 'Nebula__Log__c');
});

test('a LoggerEndUser describe drops the fields it omits and keeps the Has flags', () => {
  const source = ready(resolveDefinition(NEBULA_MANAGED_PRESET.definition, 'builtin', 'Nebula', managedEndUser));

  assert.deepEqual(source.hidden, [
    'entry.fields.exceptionType',
    'entry.details.ExceptionStackTrace__c',
    'entry.details.StackTrace__c',
    'entry.details.HttpRequestEndpointAddress__c',
    'entry.details.HttpRequestBody__c',
    'entry.details.HttpRequestBody__c.truncated',
    'entry.details.HttpResponseBody__c',
    'entry.details.HttpResponseBody__c.truncated',
    'entry.details.RestRequestBody__c',
    'entry.details.RestRequestBody__c.truncated',
    'entry.details.RestResponseBody__c',
    'entry.details.RestResponseBody__c.truncated',
    'entry.details.DatabaseResultJson__c',
    'entry.details.Tags__c'
  ]);
  const stackTrace = source.shape.entry.details.find(detail => detail.key === 'StackTrace__c')!;
  assert.equal(stackTrace.state, 'hidden');
  assert.equal(stackTrace.presence?.api, 'Nebula__HasStackTrace__c');
  assert.equal(stackTrace.state === 'hidden' && stackTrace.label, 'Stack Trace');
  assert.equal(source.shape.entry.roles.exceptionType, undefined);

  const hiddenFromDescribe = new Set([...managedAdmin.get('Nebula__LogEntry__c')!.fields].map(field => field.name));
  for (const field of managedEndUser.get('Nebula__LogEntry__c')!.fields) hiddenFromDescribe.delete(field.name);
  const selectable = apiPaths(source);
  assert.equal(hiddenFromDescribe.size, 80);
  assert.deepEqual(
    [...selectable].filter(api => hiddenFromDescribe.has(api)),
    []
  );
});

test('unlocked and managed sources report the same hidden paths for the same user', () => {
  const unlocked = ready(resolveDefinition(nebula, 'builtin', '', unlockedEndUser));
  const managed = ready(resolveDefinition(NEBULA_MANAGED_PRESET.definition, 'builtin', 'Nebula', managedEndUser));

  assert.deepEqual(unlocked.hidden, managed.hidden);
});

test('a required role that describe omits makes the source unavailable', () => {
  const entry = unlockedAdmin.get('LogEntry__c')!;
  const describes = new Map(unlockedAdmin).set('LogEntry__c', {
    ...entry,
    fields: entry.fields.filter(field => field.name !== 'Message__c')
  });

  const result = resolveDefinition(nebula, 'builtin', '', describes);

  assert.equal(result.state, 'unavailable');
  assert.deepEqual(stateOf(result), {
    state: 'unavailable',
    reason: 'requiredFieldMissing',
    message: 'entry.fields.message ("Message__c") is missing from LogEntry__c or hidden from this user.'
  });
});

test('a field of the wrong type makes the source unavailable instead of reading garbage', () => {
  const wrongTime = define({
    ...harnessAppLog,
    entry: { ...(harnessAppLog.entry as Json), fields: { time: 'Source__c', message: 'Message__c' } }
  });
  const wrongPayload = define({ ...harnessAppLog, entry: { ...(harnessAppLog.entry as Json), payload: 'Level__c' } });

  for (const definition of [wrongTime, wrongPayload]) {
    const result = resolveDefinition(definition, 'config', '', unlockedAdmin);
    assert.equal(result.state === 'unavailable' && result.reason, 'fieldTypeMismatch');
  }
});

test('a describe that does not return an object leaves the source unreadable', () => {
  const describes = new Map(unlockedAdmin);
  describes.delete('LogEntry__c');

  const result = resolveDefinition(nebula, 'builtin', '', describes);

  assert.equal(result.state === 'unavailable' && result.reason, 'objectNotReadable');
});

test('a one-object source with a relationship path, long details and a payload resolves from real describes', () => {
  const entry = resolveDefinition(define(), 'config', '', unlockedAdmin);
  const source = ready(entry);

  assert.equal(source.shape.kind, 'entries');
  assert.equal(source.shape.entry.object, 'App_Log__c');
  assert.equal(source.shape.entry.roles.user?.api, 'CreatedBy.Username');
  assert.equal(source.shape.entry.roles.user?.key, 'CreatedBy.Username');
  assert.equal(source.shape.entry.roles.time.encoding, 'datetime');
  assert.equal(source.shape.entry.sequence.api, 'Logged_At__c');
  assert.equal(source.shape.entry.levelPredicate.kind, 'values');
  assert.deepEqual(source.shape.entry.payload && { ...source.shape.entry.payload, field: undefined }, {
    state: 'readable',
    key: 'Payload__c',
    field: undefined,
    columns: ['orderId']
  });
  assert.deepEqual(source.levels.rawAtOrAbove.WARN, ['WARNING', 'ERROR']);
  assert.deepEqual(source.levels.rawAtOrAbove.DEBUG, ['DEBUG', 'INFO', 'WARNING', 'ERROR']);
  const info = toSourceInfo(entry);
  assert.deepEqual(info.payload, { entry: { field: 'Payload__c', columns: ['orderId'] } });
  assert.deepEqual(info.capabilities, { levelFilter: true, userFilter: true, apexLogLink: true });
});

test('a relationship path whose target describe is missing is hidden, not a failure', () => {
  const describes = new Map(unlockedAdmin);
  describes.delete('User');

  const source = ready(resolveDefinition(define(), 'config', '', describes));

  assert.equal(source.shape.entry.roles.user, undefined);
  assert.deepEqual(source.hidden, ['entry.fields.user']);
});

test('the display time falls back to CreatedDate for sorting when it is not sortable or filterable', () => {
  const entryDescribe = unlockedAdmin.get('App_Log__c')!;
  const describes = new Map(unlockedAdmin).set('App_Log__c', {
    ...entryDescribe,
    fields: entryDescribe.fields.map(field =>
      field.name === 'Logged_At__c' ? { ...field, sortable: false, filterable: false } : field
    )
  });

  const source = ready(resolveDefinition(define(), 'config', '', describes));

  assert.equal(source.shape.entry.roles.time.api, 'Logged_At__c');
  assert.equal(source.shape.entry.timeFilter, CREATED_DATE);
  assert.equal(source.shape.entry.sequence, CREATED_DATE);
});

test('a header without maxLevelOrdinal filters levels through its entries', () => {
  const { fields } = nebula.shape.kind === 'transactions' ? nebula.shape.transaction : { fields: {} };
  const { maxLevelOrdinal: _dropped, ...withoutOrdinal } = fields as Record<string, string>;
  const raw = {
    ...NEBULA_PRESET.raw,
    transaction: { ...(NEBULA_PRESET.raw.transaction as Json), fields: withoutOrdinal }
  };
  const definition = parseSourceDefinition(raw, '/test').definition!;

  const source = ready(resolveDefinition(definition, 'config', '', unlockedAdmin));

  assert.equal(source.shape.kind === 'transactions' && source.shape.transaction.levelPredicate.kind, 'semiJoin');
});

test('picklist values no table maps are reported as unmapped and never match a level filter', () => {
  const entryDescribe = unlockedAdmin.get('App_Log__c')!;
  const describes = new Map(unlockedAdmin).set('App_Log__c', {
    ...entryDescribe,
    fields: entryDescribe.fields.map(field =>
      field.name === 'Level__c'
        ? {
            ...field,
            picklistValues: [
              ...field.picklistValues,
              { value: 'Critical', active: true },
              { value: 'Notice', active: true }
            ]
          }
        : field
    )
  });

  const plain = ready(resolveDefinition(define(), 'config', '', describes));
  const mapped = ready(
    resolveDefinition(
      define({ ...harnessAppLog, levels: { Critical: 'ERROR', Notice: 'INFO' } }),
      'config',
      '',
      describes
    )
  );

  assert.deepEqual(plain.levels.unmapped, ['Critical', 'Notice']);
  assert.ok(!plain.levels.rawAtOrAbove.ERROR.includes('Critical'));
  assert.deepEqual(mapped.levels.unmapped, []);
  assert.ok(mapped.levels.rawAtOrAbove.ERROR.includes('Critical'));
  assert.ok(mapped.levels.rawAtOrAbove.INFO.includes('Notice'));
  assert.ok(!mapped.levels.rawAtOrAbove.WARN.includes('Notice'));
});

// ---------------------------------------------------------------------------------------------
// Detection

const allNebula = ['Log__c', 'LogEntry__c'];

test('detection finds unlocked Nebula and leaves the managed distribution not installed', async () => {
  const reader = fakeSchemaReader({ objects: allNebula, describes: unlockedAdmin });

  const found = await detectPreset(NEBULA_PRESET, reader, new Set());
  const managed = await detectPreset(NEBULA_MANAGED_PRESET, reader, new Set());

  assert.equal(ready(found).id, 'nebula');
  assert.deepEqual(toSourceInfo(managed), {
    id: 'nebula-managed',
    label: 'Nebula Logger (managed)',
    origin: 'builtin',
    shape: 'transactions',
    namespace: 'Nebula',
    objects: { transaction: 'Nebula__Log__c', entry: 'Nebula__LogEntry__c' },
    hiddenFields: [],
    unmappedLevels: [],
    capabilities: { levelFilter: false, userFilter: false, apexLogLink: false },
    payload: {},
    state: 'notInstalled'
  });
});

test('detection tells an unrelated Log__c from Nebula through the field fingerprint', async () => {
  const strangerLog = {
    name: 'Log__c',
    keyPrefix: 'a99',
    fields: [{ ...unlockedAdmin.get('Log__c')!.fields[0]!, name: 'Name' }]
  };
  const stranger = fakeSchemaReader({
    objects: allNebula,
    fields: { LogEntry__c: ['Name', 'Message__c'] },
    describes: new Map<string, ObjectDescribe>([['Log__c', strangerLog]])
  });

  const collision = await detectPreset(NEBULA_PRESET, stranger, new Set());
  const mapped = await detectPreset(NEBULA_PRESET, stranger, new Set(['logentry__c']));

  assert.equal(collision.state, 'notInstalled');
  assert.deepEqual(stateOf(collision), { state: 'notInstalled', hint: 'collision' });
  assert.deepEqual(stateOf(mapped), { state: 'notInstalled' });
  assert.deepEqual(stranger.calls.describes, []);
});

test('the fingerprint reads FieldDefinition, so a field the user cannot see does not break detection', async () => {
  const reader = fakeSchemaReader({
    objects: allNebula,
    fields: { LogEntry__c: [...unlockedAdmin.get('LogEntry__c')!.fields.map(field => field.name)] },
    describes: unlockedEndUser
  });

  const found = ready(await detectPreset(NEBULA_PRESET, reader, new Set()));

  assert.ok(found.hidden.includes('entry.details.StackTrace__c'));
});

test('a refused metadata query is reported, with no describe attempt', async () => {
  for (const refuse of ['objects', 'fields'] as const) {
    const reader = fakeSchemaReader({ objects: allNebula, describes: unlockedAdmin, refuse });

    const result = await detectPreset(NEBULA_PRESET, reader, new Set());

    assert.equal(result.state === 'unavailable' && result.reason, 'metadataQueryRefused');
    assert.deepEqual(reader.calls.describes, []);
  }
});

test('an object that exists but describe does not return is unreadable for this user', async () => {
  const describes = new Map(unlockedAdmin);
  describes.delete('Log__c');
  const reader = fakeSchemaReader({
    objects: allNebula,
    fields: { LogEntry__c: unlockedAdmin.get('LogEntry__c')!.fields.map(field => field.name) },
    describes
  });

  const result = await detectPreset(NEBULA_PRESET, reader, new Set());

  assert.equal(result.state === 'unavailable' && result.reason, 'objectNotReadable');
});

// ---------------------------------------------------------------------------------------------
// Catalog queries

function catalogOf(...entries: CatalogEntry[]): SourceCatalog {
  return { username: 'user@example.com', entries };
}

const unlockedNebula = resolveDefinition(nebula, 'builtin', '', unlockedAdmin);
const managedNebula = resolveDefinition(NEBULA_MANAGED_PRESET.definition, 'builtin', 'Nebula', managedAdmin);
const appLog = resolveDefinition(define(), 'config', '', unlockedAdmin);
const absentManaged: CatalogEntry = {
  head: {
    id: 'nebula-managed' as never,
    label: 'Nebula Logger (managed)',
    origin: 'builtin',
    shape: 'transactions',
    objects: { transaction: 'Nebula__Log__c', entry: 'Nebula__LogEntry__c' }
  },
  state: 'notInstalled'
};

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof AlvError ? error.code : String(error);
  }
  return undefined;
}

test('requireSource picks the only ready source and never guesses between several', () => {
  const one = catalogOf(absentManaged, unlockedNebula);
  const two = catalogOf(appLog, unlockedNebula, absentManaged);

  assert.equal(requireSource(one, undefined).id, 'nebula');
  assert.equal(defaultSourceId(one), 'nebula');
  assert.equal(
    codeOf(() => requireSource(two, undefined)),
    'CUSTOM_LOG_SOURCE_REQUIRED'
  );
  assert.equal(defaultSourceId(two), undefined);
  assert.equal(
    codeOf(() => requireSource(catalogOf(absentManaged), undefined)),
    'CUSTOM_LOG_NO_SOURCE'
  );
  assert.equal(requireSource(two, 'app-log').id, 'app-log');
  assert.equal(
    codeOf(() => requireSource(two, 'nope')),
    'CUSTOM_LOG_SOURCE_NOT_FOUND'
  );
  assert.equal(
    codeOf(() => requireSource(two, 'nebula-managed')),
    'CUSTOM_LOG_SOURCE_UNAVAILABLE'
  );
  assert.throws(() => requireSource(two, undefined), /app-log, nebula/);
});

test('a record id routes to the ready source whose key prefix owns it', () => {
  const catalog = catalogOf(appLog, unlockedNebula, absentManaged);

  const header = requireSourceForRecord(catalog, undefined, 'a02000000000001AAA');
  const entry = requireSourceForRecord(catalog, undefined, 'a01000000000001AAA');
  const own = requireSourceForRecord(catalog, undefined, 'a06000000000001AAA');

  assert.deepEqual([header.source.id, header.level], ['nebula', 'transaction']);
  assert.deepEqual([entry.source.id, entry.level], ['nebula', 'entry']);
  assert.deepEqual([own.source.id, own.level], ['app-log', 'entry']);
  assert.equal(requireSourceForRecord(catalog, 'nebula', 'a01000000000001AAA').level, 'entry');
  assert.equal(
    codeOf(() => requireSourceForRecord(catalog, 'app-log', 'a01000000000001AAA')),
    'CUSTOM_LOG_SOURCE_NOT_FOUND'
  );
  assert.equal(
    codeOf(() => requireSourceForRecord(catalog, undefined, '001000000000001AAA')),
    'CUSTOM_LOG_SOURCE_NOT_FOUND'
  );
});

test('two sources that map one object are ordered by the catalog, config first', () => {
  const duplicate = resolveDefinition(
    define({
      id: 'again',
      entry: { object: 'LogEntry__c', fields: { time: 'EpochTimestamp__c', message: 'Message__c' } }
    }),
    'config',
    '',
    unlockedAdmin
  );

  assert.equal(
    requireSourceForRecord(catalogOf(duplicate, unlockedNebula), undefined, 'a01000000000001AAA').source.id,
    'again'
  );
  assert.equal(
    requireSourceForRecord(catalogOf(unlockedNebula, duplicate), undefined, 'a01000000000001AAA').source.id,
    'nebula'
  );
});

test('sources reports a ready source the way the CLI contract shows it', () => {
  const info = toSourceInfo(managedNebula);
  const enduser = toSourceInfo(
    resolveDefinition(NEBULA_MANAGED_PRESET.definition, 'builtin', 'Nebula', managedEndUser)
  );

  assert.deepEqual(
    { ...info, hiddenFields: undefined },
    {
      id: 'nebula-managed',
      label: 'Nebula Logger (managed)',
      origin: 'builtin',
      shape: 'transactions',
      namespace: 'Nebula',
      objects: { transaction: 'Nebula__Log__c', entry: 'Nebula__LogEntry__c' },
      hiddenFields: undefined,
      unmappedLevels: [],
      capabilities: { levelFilter: true, userFilter: true, apexLogLink: true },
      payload: {},
      state: 'ready'
    }
  );
  assert.equal(enduser.hiddenFields.length, 14);
});

// ---------------------------------------------------------------------------------------------
// Schema memo

test('the memoized reader batches the names it lacks and answers repeats, misses included, from memory', async () => {
  const reader = fakeSchemaReader({ objects: ['Log__c'], describes: new Map() });
  const memo = createSchemaMemo();
  const memoized = memoizedSchemaReader(reader, memo);

  assert.deepEqual([...((await memoized.existingObjects(['Log__c', 'Nebula__Log__c'])) as Set<string>)], ['log__c']);
  assert.deepEqual([...((await memoized.existingObjects(['Nebula__Log__c', 'log__c'])) as Set<string>)], ['log__c']);
  assert.deepEqual([...((await memoized.existingObjects(['Other__c', 'Nebula__Log__c'])) as Set<string>)], []);

  assert.deepEqual(reader.calls.objects, [['Log__c', 'Nebula__Log__c'], ['Other__c']]);
});

test('the memoized reader shares a pending describe and forgets one that failed', async () => {
  let calls = 0;
  let fail = true;
  const reader = {
    ...fakeSchemaReader({ objects: [], describes: new Map() }),
    async describe() {
      calls += 1;
      if (fail) throw new Error('network');
      return undefined;
    }
  };
  const memoized = memoizedSchemaReader(reader, createSchemaMemo());

  await Promise.all(
    [memoized.describe('Log__c'), memoized.describe('log__c')].map(pending => pending.catch(() => undefined))
  );
  assert.equal(calls, 1);
  fail = false;
  assert.equal(await memoized.describe('Log__c'), undefined);
  assert.equal(await memoized.describe('Log__c'), undefined);
  assert.equal(calls, 2);
});

test('the memoized reader caches a refused answer like any other', async () => {
  const reader = fakeSchemaReader({ objects: ['Log__c'], describes: new Map(), refuse: 'objects' });
  const memoized = memoizedSchemaReader(reader, createSchemaMemo());

  assert.equal(await memoized.existingObjects(['Log__c']), 'refused');
  assert.equal(await memoized.existingObjects(['Log__c']), 'refused');
  assert.equal(reader.calls.objects.length, 1);
});
