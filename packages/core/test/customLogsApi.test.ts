import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AlvError, createApexLogViewerCore } from '../src/index.ts';
import { NEBULA_PRESET } from '../src/customLogs/presets.ts';
import { page, startNebulaOrg, type NebulaOrg } from './support/nebulaDouble.ts';
import { appLogSource, projectWith, type Json } from './support/customLogsFixtures.ts';
import { isolateSalesforceHome, saveOrgAuth, salesforceError } from './support/salesforceDouble.ts';

isolateSalesforceHome();

const UNLOCKED = ['Log__c', 'LogEntry__c'];
const MANAGED = ['Nebula__Log__c', 'Nebula__LogEntry__c'];

async function coreFor(t: test.TestContext, org: NebulaOrg, username: string) {
  await saveOrgAuth(username, org.instanceUrl);
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());
  return { core, username };
}

async function projectDir(t: test.TestContext, project: Json): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-custom-logs-api-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeProject(dir, project);
  return dir;
}

const writeProject = (dir: string, project: Json) =>
  fs.writeFile(path.join(dir, 'sfdx-project.json'), JSON.stringify(project));

const logRecord = (index: number, extra: Record<string, unknown> = {}) => ({
  Id: `a020000000000${String(index).padStart(2, '0')}AAA`,
  CreatedDate: `2026-10-30T00:${String(59 - index).padStart(2, '0')}:00.000+0000`,
  StartTime__c: `2026-10-30T00:${String(59 - index).padStart(2, '0')}:00.000+0000`,
  Name: `Log-0000${index}`,
  LoggedByUsername__c: 'dev@acme.com',
  TransactionId__c: `tx-${index}`,
  RequestId__c: `SLB:req-${index}`,
  TotalLogEntries__c: 3,
  TotalERRORLogEntries__c: 1,
  TotalWARNLogEntries__c: 0,
  MaxLogEntryLoggingLevelOrdinal__c: 8,
  ...extra
});

const entryRecord = (sequence: number, extra: Record<string, unknown> = {}) => ({
  Id: `a010000000000${String(sequence).padStart(2, '0')}AAA`,
  CreatedDate: '2026-10-30T00:00:01.000+0000',
  EpochTimestamp__c: 1793321290000 + sequence,
  Message__c: `entry ${sequence}`,
  TransactionEntryNumber__c: sequence,
  LoggingLevel__c: 'INFO',
  LoggingLevelOrdinal__c: 6,
  HasStackTrace__c: sequence === 2,
  ...extra
});

const sourceIds = (result: { sources: { id: string; state: string }[] }) =>
  result.sources.map(source => `${source.id}:${source.state}`);

/** An org with no `LogEntryEvent__e` lists both event presets as not installed, after the record presets. */
const NO_EVENT_PRESETS = ['nebula-events:notInstalled', 'nebula-events-managed:notInstalled'];

test('sources finds unlocked Nebula with zero config in one batched metadata read', async t => {
  const org = await startNebulaOrg(t, { describes: 'unlocked-admin', objects: UNLOCKED });
  const { core, username } = await coreFor(t, org, 'sources-unlocked@example.com');

  const result = await core.customLog.sources({ targetOrg: username, projectDir: undefined });

  assert.deepEqual(sourceIds(result), ['nebula:ready', 'nebula-managed:notInstalled', ...NO_EVENT_PRESETS]);
  assert.equal(result.defaultSourceId, 'nebula');
  assert.deepEqual(result.issues, []);
  assert.equal(result.projectFile, undefined);
  assert.equal(result.sources[0]?.hiddenFields.length, 0);
  assert.deepEqual(org.metadataQueries('EntityDefinition'), [
    "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN ('Log__c','LogEntry__c','Nebula__Log__c','Nebula__LogEntry__c','LogEntryEvent__e','Nebula__LogEntryEvent__e')"
  ]);
  assert.equal(org.metadataQueries('FieldDefinition').length, 1);
  assert.deepEqual(org.describeRequests().sort(), ['/sobjects/LogEntry__c/describe', '/sobjects/Log__c/describe']);
});

test('sources finds managed Nebula for a LoggerEndUser and reports what describe hides from them', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'managed-enduser',
    fieldDefinitions: 'managed-admin',
    objects: MANAGED
  });
  const { core, username } = await coreFor(t, org, 'sources-managed-enduser@example.com');

  const result = await core.customLog.sources({ targetOrg: username, projectDir: undefined });

  assert.deepEqual(sourceIds(result), ['nebula:notInstalled', 'nebula-managed:ready', ...NO_EVENT_PRESETS]);
  assert.equal(result.defaultSourceId, 'nebula-managed');
  const managed = result.sources[1]!;
  assert.equal(managed.namespace, 'Nebula');
  assert.deepEqual(managed.objects, { transaction: 'Nebula__Log__c', entry: 'Nebula__LogEntry__c' });
  assert.equal(managed.hiddenFields.length, 14);
  assert.ok(managed.hiddenFields.includes('entry.details.StackTrace__c'));
});

test('an unrelated Log__c is a collision, not Nebula', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    fieldDefinitions: 'managed-admin',
    objects: UNLOCKED
  });
  const { core, username } = await coreFor(t, org, 'sources-collision@example.com');

  const result = await core.customLog.sources({ targetOrg: username, projectDir: undefined });

  assert.deepEqual(sourceIds(result), ['nebula:notInstalled', 'nebula-managed:notInstalled', ...NO_EVENT_PRESETS]);
  assert.equal(result.sources[0]?.state === 'notInstalled' && result.sources[0].hint, 'collision');
  assert.equal(result.defaultSourceId, undefined);
});

test('a refused metadata query makes the sources unavailable and falls back to nothing', async t => {
  const org = await startNebulaOrg(t, { describes: 'unlocked-admin', objects: UNLOCKED, refuseMetadata: true });
  const { core, username } = await coreFor(t, org, 'sources-refused@example.com');

  const result = await core.customLog.sources({ targetOrg: username, projectDir: undefined });

  assert.deepEqual(
    result.sources.map(source => source.state === 'unavailable' && source.reason),
    Array(4).fill('metadataQueryRefused')
  );
  assert.deepEqual(org.describeRequests(), []);
});

test('a mapping edit asks Salesforce only about names it has not seen, and refresh asks again', async t => {
  const org = await startNebulaOrg(t, { describes: 'unlocked-admin', objects: UNLOCKED });
  const { core, username } = await coreFor(t, org, 'sources-edit@example.com');
  const dir = await projectDir(t, projectWith(appLogSource));

  const first = await core.customLog.sources({ targetOrg: username, projectDir: dir });
  await writeProject(dir, projectWith({ ...appLogSource, label: 'Edited', levels: {} }));
  const second = await core.customLog.sources({ targetOrg: username, projectDir: dir });
  await writeProject(dir, projectWith({ ...appLogSource, id: 'again' }));
  const third = await core.customLog.sources({ targetOrg: username, projectDir: dir });

  assert.deepEqual(sourceIds(first), [
    'app-log:unavailable',
    'nebula:ready',
    'nebula-managed:notInstalled',
    ...NO_EVENT_PRESETS
  ]);
  assert.equal(second.sources[0]?.label, 'Edited');
  assert.deepEqual(sourceIds(third), [
    'again:unavailable',
    'nebula:ready',
    'nebula-managed:notInstalled',
    ...NO_EVENT_PRESETS
  ]);
  assert.equal(first.sources[0]?.state === 'unavailable' && first.sources[0].reason, 'objectNotFound');
  assert.equal(org.metadataQueries('EntityDefinition').length, 1);
  assert.equal(org.metadataQueries('FieldDefinition').length, 1);

  await core.customLog.sources({ targetOrg: username, projectDir: dir, refresh: true });
  assert.equal(org.metadataQueries('EntityDefinition').length, 2);
});

test('a broken mapping is an issue, not a failure: the other sources and Nebula still load', async t => {
  const org = await startNebulaOrg(t, { describes: 'unlocked-admin', objects: [...UNLOCKED, 'App_Log__c'] });
  const { core, username } = await coreFor(t, org, 'sources-issues@example.com');
  const dir = await projectDir(t, {
    plugins: {
      electivus: {
        customLogs: {
          sources: [
            { id: 'broken', entry: { object: 'App_Log__c' } },
            {
              id: 'app-log',
              entry: { object: 'App_Log__c', fields: { time: 'CreatedDate', message: 'Message__c' }, typo: 1 }
            }
          ]
        }
      }
    }
  });

  const result = await core.customLog.sources({ targetOrg: username, projectDir: dir });

  assert.deepEqual(sourceIds(result), [
    'app-log:ready',
    'nebula:ready',
    'nebula-managed:notInstalled',
    ...NO_EVENT_PRESETS
  ]);
  assert.deepEqual(result.issues.map(issue => `${issue.severity}:${issue.code}`).sort(), [
    'error:missingRequired',
    'warning:unknownKey'
  ]);
  assert.equal(result.projectFile, path.join(dir, 'sfdx-project.json'));
});

test('list pages by cursor, resolves a duration once, and refuses the cursor after the mapping or filters change', async t => {
  const headers = [logRecord(1), logRecord(2), logRecord(3)];
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: UNLOCKED,
    answer: soql => {
      if (!soql.includes('FROM Log__c')) return undefined;
      return page(soql.includes('CreatedDate <') ? headers.slice(2) : headers.slice(0, 3));
    }
  });
  const { core, username } = await coreFor(t, org, 'list-cursor@example.com');

  const first = await core.customLog.list({
    targetOrg: username,
    projectDir: undefined,
    limit: 2,
    filter: { minLevel: 'WARN', since: '24h' }
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await core.customLog.list({
    targetOrg: username,
    projectDir: undefined,
    limit: 2,
    filter: { minLevel: 'WARN', since: '24h' },
    cursor: first.nextCursor!
  });

  assert.equal(first.source.id, 'nebula');
  assert.deepEqual(
    first.rows.map(row => row.title),
    ['Log-00001', 'Log-00002']
  );
  assert.ok(first.nextCursor);
  assert.deepEqual(
    second.rows.map(row => row.title),
    ['Log-00003']
  );
  assert.equal(second.nextCursor, null);
  assert.deepEqual(first.columns, [
    { key: 'SystemMode__c', label: 'System Mode' },
    { key: 'TransactionScenarioName__c', label: 'Transaction Scenario Name' },
    { key: 'Status__c', label: 'Status' }
  ]);
  const [firstSoql, secondSoql] = org.soql('data');
  const window = (soql: string | undefined) => /StartTime__c >= (\S+)/.exec(soql ?? '')?.[1];
  assert.ok(window(firstSoql));
  assert.equal(window(secondSoql), window(firstSoql));
  assert.match(
    secondSoql!,
    /\(CreatedDate < 2026-10-30T00:57:00.000Z OR \(CreatedDate = 2026-10-30T00:57:00.000Z AND Id < 'a02000000000002AAA'\)\)/
  );

  const rejectsCursor = (params: Parameters<typeof core.customLog.list>[0]) =>
    assert.rejects(
      core.customLog.list(params),
      (error: unknown) => error instanceof AlvError && error.code === 'CUSTOM_LOG_INVALID_CURSOR'
    );
  await rejectsCursor({
    targetOrg: username,
    projectDir: undefined,
    cursor: first.nextCursor!,
    filter: { minLevel: 'ERROR', since: '24h' }
  });
  await rejectsCursor({
    targetOrg: username,
    projectDir: undefined,
    cursor: first.nextCursor!,
    filter: { minLevel: 'WARN', since: '7d' }
  });
  await rejectsCursor({
    targetOrg: username,
    projectDir: undefined,
    cursor: first.nextCursor!,
    source: 'nebula',
    filter: {}
  });
});

test('a cursor from one mapping is refused by the same source after the mapping is edited', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: [...UNLOCKED, 'App_Log__c'],
    answer: soql =>
      soql.includes('FROM App_Log__c')
        ? page([
            {
              Id: 'a06000000000001AAA',
              CreatedDate: '2026-10-30T00:29:16.000+0000',
              Message__c: 'a',
              Level__c: 'ERROR'
            },
            { Id: 'a06000000000002AAA', CreatedDate: '2026-10-30T00:29:15.000+0000', Message__c: 'b', Level__c: 'INFO' }
          ])
        : undefined
  });
  const { core, username } = await coreFor(t, org, 'list-mapping-edit@example.com');
  const mapping = {
    id: 'app-log',
    entry: { object: 'App_Log__c', fields: { time: 'CreatedDate', message: 'Message__c', level: 'Level__c' } }
  };
  const dir = await projectDir(t, projectWith(mapping));

  const first = await core.customLog.list({ targetOrg: username, projectDir: dir, source: 'app-log', limit: 1 });
  const same = await core.customLog.list({
    targetOrg: username,
    projectDir: dir,
    source: 'app-log',
    limit: 1,
    cursor: first.nextCursor!
  });
  await writeProject(dir, projectWith({ ...mapping, entry: { ...mapping.entry, columns: ['Source__c'] } }));

  assert.equal(first.source.shape, 'entries');
  assert.equal(first.rows[0]?.level, 'ERROR');
  assert.equal(same.rows.length, 1);
  await assert.rejects(
    core.customLog.list({
      targetOrg: username,
      projectDir: dir,
      source: 'app-log',
      limit: 1,
      cursor: first.nextCursor!
    }),
    (error: unknown) =>
      error instanceof AlvError && error.code === 'CUSTOM_LOG_INVALID_CURSOR' && /mapping changed/.test(error.message)
  );
});

test('list never guesses between sources and says which ones are ready', async t => {
  const org = await startNebulaOrg(t, { describes: 'unlocked-admin', objects: [...UNLOCKED, 'App_Log__c'] });
  const { core, username } = await coreFor(t, org, 'list-ambiguous@example.com');
  const dir = await projectDir(
    t,
    projectWith({
      id: 'app-log',
      entry: { object: 'App_Log__c', fields: { time: 'CreatedDate', message: 'Message__c' } }
    })
  );

  await assert.rejects(
    core.customLog.list({ targetOrg: username, projectDir: dir }),
    (error: unknown) =>
      error instanceof AlvError && error.code === 'CUSTOM_LOG_SOURCE_REQUIRED' && /app-log, nebula/.test(error.message)
  );
  await assert.rejects(
    core.customLog.list({ targetOrg: username, projectDir: dir, source: 'nebula-managed' }),
    (error: unknown) => error instanceof AlvError && error.code === 'CUSTOM_LOG_SOURCE_UNAVAILABLE'
  );
  assert.equal(org.soql('data').length, 0);
});

test('list rejects a bad limit, level or duration before any request', async t => {
  const org = await startNebulaOrg(t, { describes: 'unlocked-admin', objects: UNLOCKED });
  const { core, username } = await coreFor(t, org, 'list-invalid@example.com');

  for (const params of [
    { filter: { since: 'yesterday' } },
    { filter: { until: '5x' } },
    { filter: { minLevel: 'LOUD' as never } }
  ]) {
    await assert.rejects(
      core.customLog.list({ targetOrg: username, projectDir: undefined, ...params }),
      (error: unknown) => error instanceof AlvError && error.code === 'INVALID_ARGUMENT'
    );
  }
  assert.equal(org.requests.length, 0);
});

const nebulaRaw = NEBULA_PRESET.raw as { entry: { fields: Record<string, string> } & Json };

test('list with entries pages Nebula entries with their log, and a header cursor never continues an entry list', async t => {
  const entries = [1, 2, 3].map(sequence => ({
    ...entryRecord(sequence, { OriginLocation__c: 'OrderSync.run', OriginType__c: 'Apex' }),
    Log__c: logRecord(1).Id,
    Log__r: { ...logRecord(1), SystemMode__c: 'ANONYMOUS', Status__c: 'New' }
  }));
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: UNLOCKED,
    answer: soql => {
      if (soql.includes('FROM LogEntry__c')) return page(soql.includes('CreatedDate <') ? entries.slice(2) : entries);
      if (soql.includes('FROM Log__c')) return page([logRecord(1), logRecord(2), logRecord(3)]);
      return undefined;
    }
  });
  const { core, username } = await coreFor(t, org, 'list-entries@example.com');
  const scope = { targetOrg: username, projectDir: undefined, limit: 2, filter: { user: 'dev@acme.com' } };

  const first = await core.customLog.list({ ...scope, entries: true });
  const second = await core.customLog.list({ ...scope, entries: true, cursor: first.nextCursor! });
  const headers = await core.customLog.list(scope);

  assert.deepEqual(first.columns, [{ key: 'OriginType__c', label: 'Origin Type' }]);
  assert.deepEqual(first.logColumns, [
    { key: 'SystemMode__c', label: 'System Mode' },
    { key: 'TransactionScenarioName__c', label: 'Transaction Scenario Name' },
    { key: 'Status__c', label: 'Status' }
  ]);
  assert.deepEqual(
    first.rows.map(row => [row.id, row.title, row.origin, row.user, row.transactionId, row.log?.id, row.log?.title]),
    [
      ['a01000000000001AAA', 'entry 1', 'OrderSync.run', 'dev@acme.com', 'tx-1', 'a02000000000001AAA', 'Log-00001'],
      ['a01000000000002AAA', 'entry 2', 'OrderSync.run', 'dev@acme.com', 'tx-1', 'a02000000000001AAA', 'Log-00001']
    ]
  );
  assert.deepEqual(first.rows[0]?.log?.extra, {
    SystemMode__c: 'ANONYMOUS',
    TransactionScenarioName__c: null,
    Status__c: 'New'
  });
  assert.deepEqual(
    second.rows.map(row => row.id),
    ['a01000000000003AAA']
  );
  assert.equal(second.nextCursor, null);
  assert.equal(headers.logColumns, undefined);
  assert.deepEqual(
    headers.rows.map(row => row.log),
    [undefined, undefined]
  );
  const [firstSoql, secondSoql] = org.soql('data');
  assert.match(
    firstSoql!,
    /FROM LogEntry__c WHERE Log__c != null AND Log__r\.LoggedByUsername__c = 'dev@acme\.com' ORDER BY CreatedDate DESC, Id DESC LIMIT 3$/
  );
  assert.match(
    secondSoql!,
    /\(CreatedDate < 2026-10-30T00:00:01\.000Z OR \(CreatedDate = 2026-10-30T00:00:01\.000Z AND Id < 'a01000000000002AAA'\)\)/
  );

  const anotherKind = (error: unknown) =>
    error instanceof AlvError &&
    error.code === 'CUSTOM_LOG_INVALID_CURSOR' &&
    /another kind of page/.test(error.message);
  await assert.rejects(core.customLog.list({ ...scope, cursor: first.nextCursor! }), anotherKind);
  await assert.rejects(core.customLog.list({ ...scope, entries: true, cursor: headers.nextCursor! }), anotherKind);
});

test('list with entries on managed Nebula reads the namespaced header and keys its columns as written', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'managed-admin',
    objects: MANAGED,
    answer: soql =>
      soql.includes('FROM Nebula__LogEntry__c')
        ? page([
            {
              Id: 'a01000000000001AAA',
              CreatedDate: '2026-10-30T00:00:01.000+0000',
              Nebula__Message__c: 'Nebula Logger - Saving 1 log entry via ANONYMOUS',
              Nebula__LoggingLevelOrdinal__c: 2,
              Nebula__OriginType__c: 'Apex',
              Nebula__Log__c: 'a02000000000001AAA',
              Nebula__Log__r: {
                CreatedDate: '2026-10-30T00:00:00.000+0000',
                Name: 'Log-00001',
                Nebula__LoggedByUsername__c: 'dev@acme.com',
                Nebula__TransactionId__c: 'tx-1',
                Nebula__SystemMode__c: 'ANONYMOUS',
                Nebula__Status__c: 'New'
              }
            }
          ])
        : undefined
  });
  const { core, username } = await coreFor(t, org, 'list-entries-managed@example.com');

  const result = await core.customLog.list({
    targetOrg: username,
    projectDir: undefined,
    source: 'nebula-managed',
    entries: true,
    filter: { minLevel: 'FINEST' }
  });

  assert.deepEqual(
    result.logColumns?.map(column => column.key),
    ['SystemMode__c', 'TransactionScenarioName__c', 'Status__c']
  );
  assert.deepEqual(result.columns, [{ key: 'OriginType__c', label: 'Origin Type' }]);
  const [row] = result.rows;
  assert.deepEqual(row?.log, {
    id: 'a02000000000001AAA',
    time: '2026-10-30T00:00:00.000Z',
    title: 'Log-00001',
    user: 'dev@acme.com',
    transactionId: 'tx-1',
    extra: { SystemMode__c: 'ANONYMOUS', TransactionScenarioName__c: null, Status__c: 'New' }
  });
  assert.deepEqual(
    [row?.system, row?.level, row?.user, row?.extra],
    [true, 'FINEST', 'dev@acme.com', { OriginType__c: 'Apex' }]
  );
  assert.match(
    org.soql('data')[0]!,
    /FROM Nebula__LogEntry__c WHERE Nebula__Log__c != null AND Nebula__LoggingLevelOrdinal__c >= 2 ORDER BY/
  );
});

test('entries changes nothing on an entries source: the same rows, and either cursor continues the other', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: [...UNLOCKED, 'App_Log__c'],
    answer: soql =>
      soql.includes('FROM App_Log__c')
        ? page([
            {
              Id: 'a06000000000001AAA',
              CreatedDate: '2026-10-30T00:29:16.000+0000',
              Message__c: 'a',
              Level__c: 'ERROR'
            },
            { Id: 'a06000000000002AAA', CreatedDate: '2026-10-30T00:29:15.000+0000', Message__c: 'b', Level__c: 'INFO' }
          ])
        : undefined
  });
  const { core, username } = await coreFor(t, org, 'list-entries-noop@example.com');
  const dir = await projectDir(
    t,
    projectWith({
      id: 'app-log',
      entry: { object: 'App_Log__c', fields: { time: 'CreatedDate', message: 'Message__c', level: 'Level__c' } }
    })
  );
  const scope = { targetOrg: username, projectDir: dir, source: 'app-log', limit: 1 };

  const plain = await core.customLog.list(scope);
  const entries = await core.customLog.list({ ...scope, entries: true });
  const continued = await core.customLog.list({ ...scope, entries: true, cursor: plain.nextCursor! });
  const back = await core.customLog.list({ ...scope, cursor: entries.nextCursor! });

  assert.deepEqual(entries, plain);
  assert.deepEqual([continued.rows.length, back.rows.length], [1, 1]);
  const [plainSoql, entriesSoql] = org.soql('data');
  assert.equal(entriesSoql, plainSoql);
});

test('sources says what a list with entries can filter, and list refuses a filter it cannot apply before querying', async t => {
  const { level: _level, levelOrdinal: _levelOrdinal, ...fields } = nebulaRaw.entry.fields;
  const org = await startNebulaOrg(t, { describes: 'unlocked-admin', objects: UNLOCKED });
  const { core, username } = await coreFor(t, org, 'sources-entry-capabilities@example.com');
  const dir = await projectDir(
    t,
    projectWith({ ...NEBULA_PRESET.raw, id: 'nebula-no-entry-level', entry: { ...nebulaRaw.entry, fields } })
  );

  const result = await core.customLog.sources({ targetOrg: username, projectDir: dir });

  assert.deepEqual(
    result.sources.map(source => [source.id, source.capabilities.levelFilter, source.entryCapabilities]),
    [
      ['nebula-no-entry-level', true, { levelFilter: false, userFilter: true }],
      ['nebula', true, { levelFilter: true, userFilter: true }],
      ['nebula-managed', false, { levelFilter: false, userFilter: false }],
      ['nebula-events', false, { levelFilter: false, userFilter: false }],
      ['nebula-events-managed', false, { levelFilter: false, userFilter: false }]
    ]
  );
  await assert.rejects(
    core.customLog.list({
      targetOrg: username,
      projectDir: dir,
      source: 'nebula-no-entry-level',
      entries: true,
      filter: { minLevel: 'ERROR' }
    }),
    (error: unknown) => error instanceof AlvError && error.code === 'CUSTOM_LOG_UNSUPPORTED_FILTER'
  );
  assert.deepEqual(org.soql('data'), []);
});

test('get returns the header, its entries, the page cursor and the linked Apex log in one call', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: UNLOCKED,
    answer: soql => {
      if (soql.includes('FROM Log__c WHERE Id =')) return page([logRecord(1)]);
      if (soql.includes('FROM LogEntry__c WHERE Log__c')) return page([entryRecord(1), entryRecord(2), entryRecord(3)]);
      if (soql.includes('FROM ApexLog')) {
        return page([{ Id: '07L000000000001AAA', StartTime: '2026-10-30T00:48:10.000+0000', LogLength: 2624 }]);
      }
      return undefined;
    }
  });
  const { core, username } = await coreFor(t, org, 'get-log@example.com');

  const result = await core.customLog.get({
    targetOrg: username,
    projectDir: undefined,
    logId: 'a02000000000001AAA',
    limit: 2
  });

  assert.equal(result.log.title, 'Log-00001');
  assert.equal(result.log.requestId, 'SLB:req-1');
  assert.deepEqual(
    result.entries.map(entry => [entry.sequence, entry.message, entry.presentDetails]),
    [
      [1, 'entry 1', []],
      [2, 'entry 2', ['StackTrace__c']]
    ]
  );
  assert.deepEqual(result.entryColumns, [{ key: 'OriginType__c', label: 'Origin Type' }]);
  assert.ok(result.nextCursor);
  assert.deepEqual(result.apexLog, {
    state: 'linked',
    logId: '07L000000000001AAA',
    startTime: '2026-10-30T00:48:10.000Z',
    logLength: 2624
  });
  assert.match(org.soql('tooling').at(-1)!, /WHERE RequestIdentifier = 'SLB:req-1'/);
  assert.equal(result.logPayload, undefined);
});

test('get keeps working for a user who cannot read ApexLog and never re-resolves because of it', async t => {
  for (const [code, message] of [
    ['INVALID_TYPE', "sObject type 'ApexLog' is not supported."],
    ['API_CURRENTLY_DISABLED', 'API is disabled for this User']
  ]) {
    const org = await startNebulaOrg(t, {
      describes: 'unlocked-admin',
      objects: UNLOCKED,
      answer: soql => {
        if (soql.includes('FROM Log__c WHERE Id =')) return page([logRecord(1)]);
        if (soql.includes('FROM LogEntry__c')) return page([entryRecord(1)]);
        if (soql.includes('FROM ApexLog')) return salesforceError(code!, message!);
        return undefined;
      }
    });
    const { core, username } = await coreFor(t, org, `get-no-apexlog-${code!.toLowerCase()}@example.com`);

    const result = await core.customLog.get({
      targetOrg: username,
      projectDir: undefined,
      logId: 'a02000000000001AAA'
    });

    assert.deepEqual(result.apexLog, { state: 'unavailable', reason: 'noAccess' }, code);
    assert.equal(org.metadataQueries('EntityDefinition').length, 1, code);
  }
});

test('get without a request id says so instead of querying', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: UNLOCKED,
    answer: soql => {
      if (soql.includes('FROM Log__c WHERE Id =')) return page([logRecord(1, { RequestId__c: null })]);
      if (soql.includes('FROM LogEntry__c')) return page([]);
      return undefined;
    }
  });
  const { core, username } = await coreFor(t, org, 'get-no-request@example.com');

  const result = await core.customLog.get({ targetOrg: username, projectDir: undefined, logId: 'a02000000000001AAA' });

  assert.deepEqual(result.apexLog, { state: 'noRequestId' });
  assert.deepEqual(result.entries, []);
  assert.equal(org.soql('tooling').filter(soql => soql.includes('ApexLog')).length, 0);
});

test('get by transaction id finds the same log, and refuses to pick when two share the id', async t => {
  let lookups = 0;
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: UNLOCKED,
    answer: soql => {
      if (soql.includes('SELECT Id FROM Log__c WHERE TransactionId__c')) {
        lookups += 1;
        if (soql.includes("'none'")) return page([]);
        return page(
          soql.includes("'twice'")
            ? [{ Id: 'a02000000000001AAA' }, { Id: 'a02000000000002AAA' }]
            : [{ Id: 'a02000000000001AAA' }]
        );
      }
      if (soql.includes('FROM Log__c WHERE Id =')) return page([logRecord(1)]);
      if (soql.includes('FROM LogEntry__c')) return page([entryRecord(1)]);
      if (soql.includes('FROM ApexLog')) return page([]);
      return undefined;
    }
  });
  const { core, username } = await coreFor(t, org, 'get-transaction@example.com');

  const byTransaction = await core.customLog.get({ targetOrg: username, projectDir: undefined, transactionId: 'tx-1' });
  const byId = await core.customLog.get({ targetOrg: username, projectDir: undefined, logId: 'a02000000000001AAA' });

  assert.deepEqual(byTransaction, byId);
  assert.equal(lookups, 1);
  await assert.rejects(
    core.customLog.get({ targetOrg: username, projectDir: undefined, transactionId: 'twice' }),
    (error: unknown) =>
      error instanceof AlvError &&
      error.code === 'CUSTOM_LOG_AMBIGUOUS_TRANSACTION' &&
      /a02000000000001AAA, a02000000000002AAA/.test(error.message)
  );
  await assert.rejects(
    core.customLog.get({ targetOrg: username, projectDir: undefined, transactionId: 'none' }),
    (error: unknown) => error instanceof AlvError && error.code === 'CUSTOM_LOG_RECORD_NOT_FOUND'
  );
});

test('get opens an entry on its own when its transaction id field cannot be filtered', async t => {
  const record = {
    Id: 'a06000000000001AAA',
    CreatedDate: '2026-10-30T00:29:16.000+0000',
    Message__c: 'm',
    Stack_Trace__c: 'tx-long'
  };
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: [...UNLOCKED, 'App_Log__c'],
    answer: soql => (soql.includes('FROM App_Log__c WHERE Id =') ? page([record]) : undefined)
  });
  const { core, username } = await coreFor(t, org, 'get-unfilterable-transaction@example.com');
  const dir = await projectDir(
    t,
    projectWith({
      id: 'app-log',
      entry: {
        object: 'App_Log__c',
        fields: { time: 'CreatedDate', message: 'Message__c', transactionId: 'Stack_Trace__c' }
      }
    })
  );

  const result = await core.customLog.get({
    targetOrg: username,
    projectDir: dir,
    source: 'app-log',
    logId: 'a06000000000001AAA'
  });

  assert.deepEqual(
    result.entries.map(entry => entry.id),
    ['a06000000000001AAA']
  );
  assert.match(org.soql('data').at(-1)!, /FROM App_Log__c WHERE Id = 'a06000000000001AAA' ORDER BY/);
});

test('get explains an entry id passed where a log id belongs', async t => {
  const org = await startNebulaOrg(t, { describes: 'unlocked-admin', objects: UNLOCKED });
  const { core, username } = await coreFor(t, org, 'get-entry-id@example.com');

  await assert.rejects(
    core.customLog.get({ targetOrg: username, projectDir: undefined, logId: 'a01000000000001AAA' }),
    (error: unknown) =>
      error instanceof AlvError &&
      error.code === 'CUSTOM_LOG_RECORD_NOT_FOUND' &&
      error.message ===
        "a01000000000001AAA is a LogEntry__c id. Pass the Log__c id: log.id of a list --entries row, or the entry's logId field."
  );
  await assert.rejects(
    core.customLog.get({ targetOrg: username, projectDir: undefined, logId: 'not-an-id' }),
    (error: unknown) => error instanceof AlvError && error.code === 'INVALID_ARGUMENT'
  );
});

test('a LoggerEndUser reads an entry with the hidden detail marked hidden, and no SELECT names a field describe omitted', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'managed-enduser',
    fieldDefinitions: 'managed-admin',
    objects: MANAGED,
    answer: soql =>
      soql.includes('FROM Nebula__LogEntry__c WHERE Id =')
        ? page([
            {
              Id: 'a01000000000902AAA',
              Nebula__Log__c: 'a02000000000901AAA',
              CreatedDate: '2026-10-30T00:00:01.000+0000',
              Nebula__EpochTimestamp__c: 1793321290002,
              Nebula__Message__c: 'Divide by 0',
              Nebula__TransactionEntryNumber__c: 2,
              Nebula__LoggingLevelOrdinal__c: 8,
              Nebula__HasStackTrace__c: true,
              Nebula__HasExceptionStackTrace__c: true,
              Nebula__ExceptionMessage__c: 'Divide by 0'
            }
          ])
        : undefined
  });
  const { core, username } = await coreFor(t, org, 'entry-enduser@example.com');

  const result = await core.customLog.entry({
    targetOrg: username,
    projectDir: undefined,
    entryId: 'a01000000000902AAA'
  });

  assert.equal(result.source.id, 'nebula-managed');
  assert.equal(result.logId, 'a02000000000901AAA');
  assert.equal(result.entry.level, 'ERROR');
  assert.deepEqual(result.entry.presentDetails, ['ExceptionStackTrace__c', 'StackTrace__c']);
  const detail = (key: string) => result.details.find(item => item.key === key);
  assert.equal(detail('StackTrace__c')?.state, 'hidden');
  assert.equal(detail('ExceptionStackTrace__c')?.state, 'hidden');
  assert.equal(detail('ExceptionMessage__c')?.state, 'value');
  assert.equal(detail('Tags__c')?.state, 'hidden');
  assert.deepEqual(result.rawPayload, { state: 'unmapped' });
  for (const soql of org.soql('data')) {
    assert.doesNotMatch(soql, /\bNebula__(StackTrace|ExceptionStackTrace|Tags|HttpRequestBody|ExceptionType)__c\b/);
  }
});

test('entry rejects a log id and a missing record with their own codes', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: UNLOCKED,
    answer: soql => (soql.includes('FROM LogEntry__c') ? page([]) : undefined)
  });
  const { core, username } = await coreFor(t, org, 'entry-errors@example.com');

  await assert.rejects(
    core.customLog.entry({ targetOrg: username, projectDir: undefined, entryId: 'a02000000000001AAA' }),
    (error: unknown) =>
      error instanceof AlvError &&
      error.code === 'CUSTOM_LOG_RECORD_NOT_FOUND' &&
      error.message ===
        'a02000000000001AAA is a Log__c id. Pass a LogEntry__c id from the entries that custom-log get returns.'
  );
  await assert.rejects(
    core.customLog.entry({ targetOrg: username, projectDir: undefined, entryId: 'a01000000000001AAA' }),
    (error: unknown) => error instanceof AlvError && error.code === 'CUSTOM_LOG_RECORD_NOT_FOUND'
  );
  await assert.rejects(
    core.customLog.entry({ targetOrg: username, projectDir: undefined, entryId: '001000000000001AAA' }),
    (error: unknown) => error instanceof AlvError && error.code === 'CUSTOM_LOG_SOURCE_NOT_FOUND'
  );
});

test('INVALID_FIELD means the schema changed: the catalog is rebuilt once and the call retried', async t => {
  let attempts = 0;
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: UNLOCKED,
    answer: soql => {
      if (!soql.includes('FROM Log__c')) return undefined;
      attempts += 1;
      return attempts === 1
        ? salesforceError('INVALID_FIELD', "No such column 'Status__c' on entity 'Log__c'.")
        : page([logRecord(1)]);
    }
  });
  const { core, username } = await coreFor(t, org, 'drift-once@example.com');

  const result = await core.customLog.list({ targetOrg: username, projectDir: undefined });

  assert.equal(result.rows.length, 1);
  assert.equal(attempts, 2);
  assert.equal(org.metadataQueries('EntityDefinition').length, 2);
});

test('INVALID_FIELD that persists is thrown after exactly one re-resolve', async t => {
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: UNLOCKED,
    answer: soql =>
      soql.includes('FROM Log__c')
        ? salesforceError('INVALID_FIELD', "No such column 'Status__c' on entity 'Log__c'.")
        : undefined
  });
  const { core, username } = await coreFor(t, org, 'drift-twice@example.com');

  await assert.rejects(
    core.customLog.list({ targetOrg: username, projectDir: undefined }),
    (error: Error & { errorCode?: string }) => error.errorCode === 'INVALID_FIELD'
  );
  assert.equal(org.soql('data').length, 2);
  assert.equal(org.metadataQueries('EntityDefinition').length, 2);
});

test('cancelling a list call in flight rejects with ABORTED', async t => {
  const controller = new AbortController();
  const org = await startNebulaOrg(t, {
    describes: 'unlocked-admin',
    objects: UNLOCKED,
    answer: soql => {
      if (soql.includes('FROM Log__c')) controller.abort();
      return soql.includes('FROM Log__c') ? page([logRecord(1)]) : undefined;
    }
  });
  const { core, username } = await coreFor(t, org, 'abort@example.com');

  await assert.rejects(
    core.customLog.list({ targetOrg: username, projectDir: undefined }, { signal: controller.signal }),
    (error: unknown) => error instanceof AlvError && error.code === 'ABORTED'
  );
});
