import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CustomLogConfigIssue } from '../src/customLogs/contracts.ts';
import {
  loadCustomLogsConfig,
  parseCustomLogsConfig,
  parseSourceDefinition,
  type EntryDefinition,
  type SourceDefinition
} from '../src/customLogs/config.ts';
import { BUILTIN_PRESETS, NEBULA_MANAGED_PRESET, NEBULA_PRESET, qualifyPath } from '../src/customLogs/presets.ts';
import {
  appEntriesSource,
  appEventSource,
  appLogSource,
  entriesRole,
  entriesSource,
  entrySource,
  eventSource,
  headerSource,
  projectWith,
  type Json
} from './support/customLogsFixtures.ts';

const parseSources = (...sources: unknown[]) => parseCustomLogsConfig({ sources });
const codes = (issues: readonly CustomLogConfigIssue[]) => issues.map(issue => `${issue.code}@${issue.pointer}`);

/** The `entry` object of a parsed source that maps records. */
function entryOf(source: SourceDefinition | undefined): EntryDefinition {
  assert.ok(source && source.shape.kind !== 'events', 'a source that maps records');
  return source.shape.entry;
}

test('a one-object mapping parses into an entries source with every part of the usage example', () => {
  const { sources, issues } = parseSources(appLogSource);

  assert.deepEqual(issues, []);
  const [source] = sources;
  assert.ok(source?.shape.kind === 'entries', 'an entries source');
  assert.equal(source.id, 'app-log');
  assert.equal(source.label, 'App Log');
  assert.equal(source.shape.entry.object, 'App_Log__c');
  assert.equal(source.shape.entry.fields.message, 'Message__c');
  assert.deepEqual(source.shape.entry.columns, ['Category__c']);
  assert.deepEqual(source.shape.entry.details, [
    { field: 'Stack_Trace__c' },
    { field: 'Http_Body__c', truncated: 'Http_Body_Truncated__c' }
  ]);
  assert.deepEqual(source.shape.entry.payload, { field: 'Payload__c', columns: ['orderId', 'http.status'] });
  assert.deepEqual(source.levels, { Critical: 'ERROR', Notice: 'INFO' });
});

test('the short forms of details and payload expand to the object forms', () => {
  const { sources, issues } = parseSources(entrySource({ details: ['Body__c'], payload: 'Payload__c' }));

  assert.deepEqual(issues, []);
  assert.deepEqual(entryOf(sources[0]).details, [{ field: 'Body__c' }]);
  assert.deepEqual(entryOf(sources[0]).payload, { field: 'Payload__c', columns: [] });
  assert.deepEqual(entryOf(parseSources(entrySource({ payload: { field: 'Payload__c' } })).sources[0]).payload, {
    field: 'Payload__c',
    columns: []
  });
});

test('a header source needs entry.parent and a one-object source must not have one', () => {
  const header = parseSources(headerSource({ payload: 'Body__c' }));
  assert.deepEqual(header.issues, []);
  const headerShape = header.sources[0]?.shape;
  assert.ok(headerShape?.kind === 'transactions', 'a transactions source');
  assert.equal(headerShape.entry.parent, 'Acme_Log__c');
  assert.deepEqual(headerShape.transaction.payload, {
    field: 'Body__c',
    columns: []
  });

  const noParent = parseSources({ ...headerSource({}), entry: { ...(appLogSource.entry as Json) } });
  assert.deepEqual(codes(noParent.issues), ['missingRequired@/plugins/electivus/customLogs/sources/0/entry/parent']);
  assert.deepEqual(noParent.sources, []);

  const orphanParent = parseSources(entrySource({ parent: 'X__c' }));
  assert.deepEqual(codes(orphanParent.issues), ['invalidValue@/plugins/electivus/customLogs/sources/0/entry/parent']);
  assert.deepEqual(orphanParent.sources, []);
});

test('unknown keys warn at every level and the source still loads', () => {
  const typo = parseSources(entrySource({ detials: [] }), {
    ...headerSource({ future: true }),
    zz: 1
  });

  assert.deepEqual(codes(typo.issues), [
    'unknownKey@/plugins/electivus/customLogs/sources/0/entry/detials',
    'unknownKey@/plugins/electivus/customLogs/sources/1/zz',
    'unknownKey@/plugins/electivus/customLogs/sources/1/transaction/future'
  ]);
  assert.ok(typo.issues.every(issue => issue.severity === 'warning'));
  assert.equal(typo.sources.length, 2);

  const nested = parseSources(
    entrySource({
      fields: { ...((appLogSource.entry as Json).fields as Json), future: 'X__c' },
      details: [{ field: 'Body__c', future: 1 }],
      payload: { field: 'Payload__c', future: 1 }
    })
  );
  assert.deepEqual(
    nested.issues.map(issue => issue.pointer.replace('/plugins/electivus/customLogs/sources/0/entry', '')).sort(),
    ['/details/0/future', '/fields/future', '/payload/future']
  );
  assert.equal(nested.sources.length, 1);
});

test('a source with an error is skipped and the others still load', () => {
  const { sources, issues } = parseSources(
    entrySource({ fields: { time: 'CreatedDate' } }),
    { ...appLogSource, id: 'AppLog' },
    { ...appLogSource, id: 'good' }
  );

  assert.deepEqual(codes(issues), [
    'missingRequired@/plugins/electivus/customLogs/sources/0/entry/fields/message',
    'invalidValue@/plugins/electivus/customLogs/sources/1/id'
  ]);
  assert.deepEqual(
    sources.map(source => source.id),
    ['good']
  );
});

test('invalid values are errors with a pointer to the offending value', () => {
  const cases: [string, Json, string][] = [
    [
      'field path with a space',
      entrySource({ fields: { time: 'CreatedDate', message: 'Source Field' } }),
      'entry/fields/message'
    ],
    ['non-canonical level', { ...appLogSource, levels: { Critical: 'FATAL' } }, 'levels/Critical'],
    [
      'payload column that is not a string',
      entrySource({ payload: { field: 'P__c', columns: [42] } }),
      'entry/payload/columns/0'
    ],
    ['payload object without field', entrySource({ payload: { columns: ['a'] } }), 'entry/payload/field'],
    ['detail object without field', entrySource({ details: [{ presence: 'Has_Body__c' }] }), 'entry/details/0/field'],
    ['label past 80 characters', { ...appLogSource, label: 'x'.repeat(81) }, 'label'],
    ['empty system message prefix', entrySource({ systemMessagePrefix: '' }), 'entry/systemMessagePrefix'],
    ['object name with a dot', entrySource({ object: 'a.b' }), 'entry/object']
  ];
  for (const [name, source, tail] of cases) {
    const { sources, issues } = parseSources(source);
    assert.equal(sources.length, 0, name);
    assert.ok(
      issues.some(
        issue => issue.severity === 'error' && issue.pointer === `/plugins/electivus/customLogs/sources/0/${tail}`
      ),
      `${name}: ${JSON.stringify(issues)}`
    );
  }
});

test('shapes that are not objects are reported without throwing', () => {
  assert.deepEqual(codes(parseCustomLogsConfig('nebula').issues), ['notAnObject@/plugins/electivus/customLogs']);
  assert.deepEqual(codes(parseCustomLogsConfig({ sources: {} }).issues), [
    'invalidValue@/plugins/electivus/customLogs/sources'
  ]);
  assert.deepEqual(codes(parseSources('nope').issues), ['notAnObject@/plugins/electivus/customLogs/sources/0']);
  assert.deepEqual(codes(parseSources({ id: 'x', entry: 'y' }).issues), [
    'notAnObject@/plugins/electivus/customLogs/sources/0/entry'
  ]);
  assert.deepEqual(parseCustomLogsConfig(undefined), { sources: [], issues: [], eventRetentionDays: 30 });
  assert.deepEqual(parseCustomLogsConfig({}), { sources: [], issues: [], eventRetentionDays: 30 });
});

test('a later source with the same id is an error and the first one stays', () => {
  const { sources, issues } = parseSources(appLogSource, { ...appLogSource, label: 'Second' });

  assert.deepEqual(codes(issues), ['duplicateId@/plugins/electivus/customLogs/sources/1/id']);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.label, 'App Log');
});

test('a source may reuse a built-in id, and the label falls back to the id', () => {
  const { sources, issues } = parseSources({ id: 'nebula', entry: appLogSource.entry as Json });

  assert.deepEqual(issues, []);
  assert.equal(sources[0]?.id, 'nebula');
  assert.equal(sources[0]?.label, 'nebula');
});

test('the digest follows the mapping and ignores key order and the label', () => {
  const digest = (source: Json) => parseSources(source).sources[0]!.digest;
  const base = digest(appLogSource);

  assert.match(base, /^[0-9a-f]{12}$/);
  assert.equal(digest({ ...appLogSource, label: 'Renamed' }), base);
  assert.equal(digest({ levels: appLogSource.levels, entry: appLogSource.entry, id: 'app-log' }), base);
  assert.notEqual(digest(entrySource({ columns: ['Other__c'] })), base);
  assert.notEqual(digest({ ...appLogSource, levels: { Critical: 'WARN' } }), base);
});

test('the Nebula presets are ordinary definitions registered under two ids per source shape', () => {
  assert.deepEqual(
    BUILTIN_PRESETS.map(preset => [preset.definition.id, preset.namespace]),
    [
      ['nebula', ''],
      ['nebula-managed', 'Nebula'],
      ['nebula-events', ''],
      ['nebula-events-managed', 'Nebula']
    ]
  );
  const [shape, other] = [NEBULA_PRESET.definition, NEBULA_MANAGED_PRESET.definition];
  assert.equal(shape.shape.kind, 'transactions');
  assert.equal(shape.shape.entry.fields.messageTruncated, 'MessageTruncated__c');
  assert.equal(shape.shape.entry.payload, undefined);
  assert.equal(shape.shape.entry.systemMessagePrefix, 'Nebula Logger - ');
  assert.equal(shape.shape.entry.details.length, 11);
  assert.notEqual(shape.digest, other.digest);
  assert.deepEqual(parseSourceDefinition(NEBULA_PRESET.raw, '/builtin').issues, []);
});

test('qualifyPath prefixes only the custom segments that carry no namespace yet', () => {
  assert.equal(qualifyPath('Log__c', 'Nebula'), 'Nebula__Log__c');
  assert.equal(qualifyPath('LoggedBy__r.Username', 'Nebula'), 'Nebula__LoggedBy__r.Username');
  assert.equal(qualifyPath('Owner.Custom__c', 'Nebula'), 'Owner.Nebula__Custom__c');
  assert.equal(qualifyPath('pharos__Log__c', 'Nebula'), 'pharos__Log__c');
  assert.equal(qualifyPath('Name', 'Nebula'), 'Name');
  assert.equal(qualifyPath('CreatedBy.Username', 'Nebula'), 'CreatedBy.Username');
  assert.equal(qualifyPath('Log__c', ''), 'Log__c');
  assert.equal(qualifyPath('Setting__mdt', 'Nebula'), 'Nebula__Setting__mdt');
});

async function withProject<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-custom-logs-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), content);
    }
    return await run(await fs.realpath(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('loadCustomLogsConfig walks up to sfdx-project.json and parses the plugins.electivus section', async () => {
  const project = JSON.stringify(projectWith(appLogSource));
  await withProject({ 'sfdx-project.json': project, 'force-app/main/default/.keep': '' }, async root => {
    const config = await loadCustomLogsConfig(path.join(root, 'force-app/main/default'));

    assert.equal(config.projectFile, path.join(root, 'sfdx-project.json'));
    assert.deepEqual(config.issues, []);
    assert.deepEqual(
      config.sources.map(source => source.id),
      ['app-log']
    );
  });
});

test('loadCustomLogsConfig reads the file fresh and its fingerprint follows the section', async () => {
  await withProject({ 'sfdx-project.json': JSON.stringify(projectWith(appLogSource)) }, async root => {
    const before = await loadCustomLogsConfig(root);
    await fs.writeFile(
      path.join(root, 'sfdx-project.json'),
      JSON.stringify(projectWith(entrySource({ columns: ['Other__c'] })))
    );
    const after = await loadCustomLogsConfig(root);
    await fs.writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify({ sourceApiVersion: '65.0' }));
    const without = await loadCustomLogsConfig(root);

    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.deepEqual(entryOf(after.sources[0]).columns, ['Other__c']);
    assert.deepEqual(without.sources, []);
    assert.equal(without.projectFile, path.join(root, 'sfdx-project.json'));
    assert.notEqual(without.fingerprint, after.fingerprint);
  });
});

test('loadCustomLogsConfig without a project, or with a broken one, leaves only the built-ins', async () => {
  const none = await loadCustomLogsConfig(undefined);
  assert.deepEqual([none.sources, none.issues, none.projectFile], [[], [], undefined]);

  await withProject({ 'sfdx-project.json': '{ "plugins": ' }, async root => {
    const broken = await loadCustomLogsConfig(root);
    assert.deepEqual(broken.sources, []);
    assert.deepEqual(
      broken.issues.map(issue => [issue.code, issue.severity]),
      [['invalidJson', 'error']]
    );
    assert.equal(broken.projectFile, path.join(root, 'sfdx-project.json'));
  });

  await withProject({ 'nested/readme.md': '' }, async root => {
    assert.equal((await loadCustomLogsConfig(path.join(root, 'nested'))).projectFile, undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// Platform event sources

const SOURCE_0 = '/plugins/electivus/customLogs/sources/0';

test('an event mapping parses into an events source with the roles and keys of an entry', () => {
  const { sources, issues } = parseSources(appEventSource);

  assert.deepEqual(issues, []);
  const [source] = sources;
  assert.ok(source, 'a source');
  assert.equal(source.shape.kind, 'events');
  assert.equal(source.shape.kind === 'events' && source.shape.event.object, 'App_Log__e');
  assert.deepEqual(source.shape.kind === 'events' && source.shape.event.fields, {
    time: 'Logged_At__c',
    message: 'Message__c',
    level: 'Level__c',
    user: 'Username__c',
    transactionId: 'Transaction_Id__c',
    order: 'Sequence__c'
  });
  assert.deepEqual(source.shape.kind === 'events' && source.shape.event.columns, ['Request_Id__c']);
  assert.deepEqual(source.shape.kind === 'events' && source.shape.event.details, [
    { field: 'Stack_Trace__c', presence: 'Has_Stack_Trace__c' }
  ]);
  assert.deepEqual(source.shape.kind === 'events' && source.shape.event.payload, {
    field: 'Payload__c',
    columns: []
  });
});

test('an event source takes the short forms and the system message prefix like an entry', () => {
  const { sources, issues } = parseSources(
    eventSource({ details: ['Body__c'], payload: 'Payload__c', systemMessagePrefix: 'Logger - ' })
  );

  assert.deepEqual(issues, []);
  const event = sources[0]?.shape.kind === 'events' ? sources[0].shape.event : undefined;
  assert.deepEqual(event?.details, [{ field: 'Body__c' }]);
  assert.deepEqual(event?.payload, { field: 'Payload__c', columns: [] });
  assert.equal(event?.systemMessagePrefix, 'Logger - ');
});

test('a source maps an entry or an event, never both and never neither', () => {
  const entryAndEvent = parseSources({ ...appLogSource, event: appEventSource.event });
  const headerAndEvent = parseSources({ ...headerSource({}), event: appEventSource.event });
  const neither = parseSources({ id: 'empty' });

  assert.deepEqual(codes(entryAndEvent.issues), [`invalidValue@${SOURCE_0}/event`]);
  assert.deepEqual(codes(headerAndEvent.issues), [`invalidValue@${SOURCE_0}/event`]);
  assert.deepEqual(codes(neither.issues), [`missingRequired@${SOURCE_0}/entry`]);
  assert.deepEqual([entryAndEvent.sources, headerAndEvent.sources, neither.sources], [[], [], []]);
});

test('an event mapping is refused where a record path or a record object would not make sense', () => {
  const cases: [string, Json, string][] = [
    ['an object that is not a platform event', eventSource({ object: 'App_Log__c' }), 'event/object'],
    ['an event object with a dot', eventSource({ object: 'a.b__e' }), 'event/object'],
    [
      'a relationship path in a role',
      eventSource({ fields: { time: 'Logged_At__c', message: 'Message__c', user: 'CreatedBy.Username' } }),
      'event/fields/user'
    ],
    ['a relationship path in a column', eventSource({ columns: ['CreatedBy.Name'] }), 'event/columns/0'],
    ['a relationship path in a detail', eventSource({ details: ['Owner.Name'] }), 'event/details/0'],
    [
      'a relationship path in a detail flag',
      eventSource({ details: [{ field: 'Body__c', presence: 'Owner.Has' }] }),
      'event/details/0/presence'
    ],
    ['a relationship path in the payload', eventSource({ payload: 'Owner.Json' }), 'event/payload'],
    ['an event that is not an object', { id: 'x', event: 'App_Log__e' }, 'event']
  ];
  for (const [name, source, tail] of cases) {
    const { sources, issues } = parseSources(source);
    assert.equal(sources.length, 0, name);
    assert.ok(
      issues.some(issue => issue.severity === 'error' && issue.pointer === `${SOURCE_0}/${tail}`),
      `${name}: ${JSON.stringify(issues)}`
    );
  }
});

test('a relationship path under event tells the user which field to map instead', () => {
  const { issues } = parseSources(
    eventSource({ fields: { time: 'Logged_At__c', message: 'Message__c', user: 'CreatedBy.Username' } })
  );

  assert.match(issues[0]!.message, /Platform events have no relationships/);
  assert.match(issues[0]!.message, /"CreatedBy\.Username"/);
  assert.match(issues[0]!.message, /LoggedByUsername__c/);
});

test('parent is not a key of an event: it warns and the source loads', () => {
  const { sources, issues } = parseSources(eventSource({ parent: 'Log__c' }));

  assert.deepEqual(codes(issues), [`unknownKey@${SOURCE_0}/event/parent`]);
  assert.equal(sources.length, 1);
});

test('the event digest follows the event mapping and ignores the label', () => {
  const digest = (source: Json) => parseSources(source).sources[0]!.digest;
  const base = digest(appEventSource);

  assert.equal(digest({ ...appEventSource, label: 'Renamed' }), base);
  assert.notEqual(digest(eventSource({ columns: ['Other__c'] })), base);
  assert.notEqual(digest({ ...appEventSource, levels: { Critical: 'WARN' } }), base);
});

test('eventRetentionDays is a whole number of days from 1 to 365 and defaults to 30', () => {
  const retention = (value: unknown) => parseCustomLogsConfig({ eventRetentionDays: value, sources: [] });

  assert.equal(parseCustomLogsConfig({ sources: [] }).eventRetentionDays, 30);
  for (const days of [1, 7, 30, 365]) {
    const parsed = retention(days);
    assert.deepEqual([parsed.eventRetentionDays, parsed.issues], [days, []]);
  }
  for (const days of [0, -1, 366, 1.5, '30', null, Number.NaN]) {
    const parsed = retention(days);
    assert.equal(parsed.eventRetentionDays, 30, String(days));
    assert.deepEqual(
      codes(parsed.issues),
      ['invalidValue@/plugins/electivus/customLogs/eventRetentionDays'],
      String(days)
    );
  }
});

test('an invalid eventRetentionDays does not cost the project its sources', () => {
  const parsed = parseCustomLogsConfig({ eventRetentionDays: 0, sources: [appLogSource, appEventSource] });

  assert.deepEqual(
    parsed.sources.map(source => source.id),
    ['app-log', 'app-events']
  );
  assert.equal(parsed.eventRetentionDays, 30);
});

test('loadCustomLogsConfig reads eventRetentionDays from the project and defaults it without one', async () => {
  const project = { plugins: { electivus: { customLogs: { eventRetentionDays: 14, sources: [appEventSource] } } } };
  await withProject({ 'sfdx-project.json': JSON.stringify(project) }, async root => {
    const config = await loadCustomLogsConfig(root);

    assert.equal(config.eventRetentionDays, 14);
    assert.deepEqual(
      config.sources.map(source => source.shape.kind),
      ['events']
    );
  });
  assert.equal((await loadCustomLogsConfig(undefined)).eventRetentionDays, 30);
  await withProject({ 'sfdx-project.json': '{ "plugins": ' }, async root => {
    assert.equal((await loadCustomLogsConfig(root)).eventRetentionDays, 30);
  });
});

// ---------------------------------------------------------------------------------------------
// Payload entries and path roles (issue #1240)

test('the entries mapping of issue #1240 parses with every role kept as written and an entries payload', () => {
  const { sources, issues } = parseSources(appEntriesSource);

  assert.deepEqual(issues, []);
  const event = sources[0]?.shape.kind === 'events' ? sources[0].shape.event : undefined;
  assert.deepEqual(event?.fields, {
    time: { path: 'timestamp' },
    message: { path: 'msg' },
    level: { path: 'level' },
    user: { path: 'username' },
    transactionId: { path: 'traceId' },
    origin: { path: 'caller' }
  });
  assert.deepEqual(event?.payload, { entries: ['Payload__c', 'Payload2__c'], columns: ['traceId', 'level', 'msg'] });
});

test('a path role reads the one document of a field payload, and a field role sits beside path roles', () => {
  const { sources, issues } = parseSources(
    eventSource({ fields: { time: 'Logged_At__c', message: { path: 'msg' }, messageTruncated: { path: 'cut' } } })
  );

  assert.deepEqual(issues, []);
  const event = sources[0]?.shape.kind === 'events' ? sources[0].shape.event : undefined;
  assert.deepEqual(event?.fields, {
    time: 'Logged_At__c',
    message: { path: 'msg' },
    messageTruncated: { path: 'cut' }
  });
  assert.deepEqual(event?.payload, { field: 'Payload__c', columns: [] });
});

test('a bare entries payload has no columns, and entries may list up to eight fields', () => {
  const eight = Array.from({ length: 8 }, (_, i) => `F${i}__c`);
  const { sources, issues } = parseSources(entriesSource({ payload: { entries: eight } }));

  assert.deepEqual(issues, []);
  const event = sources[0]?.shape.kind === 'events' ? sources[0].shape.event : undefined;
  assert.deepEqual(event?.payload, { entries: eight, columns: [] });
});

test('every malformed path role or entries payload is reported at its own pointer with the existing codes', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `F${i}__c`);
  const cases: [string, Json, string, string][] = [
    [
      'a role object with an extra key',
      entriesRole('level', { path: 'level', zz: 1 }),
      'unknownKey',
      'event/fields/level/zz'
    ],
    [
      'a role object without path',
      entriesRole('level', { paht: 'level' }),
      'missingRequired',
      'event/fields/level/path'
    ],
    ['a path that is not a string', entriesRole('level', { path: 7 }), 'invalidValue', 'event/fields/level/path'],
    ['an empty path', entriesRole('level', { path: '' }), 'invalidValue', 'event/fields/level/path'],
    [
      'a path over 255 characters',
      entriesRole('level', { path: 'x'.repeat(256) }),
      'invalidValue',
      'event/fields/level/path'
    ],
    ['a role that is a number', entriesRole('level', 7), 'invalidValue', 'event/fields/level'],
    ['a role that is an array', entriesRole('level', ['Level__c']), 'invalidValue', 'event/fields/level'],
    ['a role that is null', entriesRole('level', null), 'invalidValue', 'event/fields/level'],
    ['a role string with a dot', entriesRole('level', 'ctx.level'), 'invalidValue', 'event/fields/level'],
    ['a role string with a bracket', entriesRole('level', 'levels[0]'), 'invalidValue', 'event/fields/level'],
    [
      'a path role without a payload',
      eventSource({ fields: { time: 'Logged_At__c', message: { path: 'msg' } }, payload: undefined }),
      'missingRequired',
      'event/payload'
    ],
    [
      'field and entries together',
      entriesSource({ payload: { field: 'Payload__c', entries: ['Payload__c'] } }),
      'invalidValue',
      'event/payload/entries'
    ],
    [
      'a payload object with neither',
      entriesSource({ payload: { columns: ['a'] } }),
      'missingRequired',
      'event/payload/field'
    ],
    [
      'entries that is a string',
      entriesSource({ payload: { entries: 'Payload__c' } }),
      'invalidValue',
      'event/payload/entries'
    ],
    ['empty entries', entriesSource({ payload: { entries: [] } }), 'invalidValue', 'event/payload/entries'],
    ['nine entries', entriesSource({ payload: { entries: nine } }), 'invalidValue', 'event/payload/entries'],
    [
      'an entries item that is not a field name',
      entriesSource({ payload: { entries: ['Payload__c', 'Owner.Json'] } }),
      'invalidValue',
      'event/payload/entries/1'
    ],
    [
      'an entries item that is a number',
      entriesSource({ payload: { entries: [1] } }),
      'invalidValue',
      'event/payload/entries/0'
    ],
    [
      'the same field twice',
      entriesSource({ payload: { entries: ['Payload__c', 'Payload2__c', 'Payload__c'] } }),
      'invalidValue',
      'event/payload/entries/2'
    ]
  ];
  for (const [name, source, code, tail] of cases) {
    const { sources, issues } = parseSources(source);
    assert.ok(
      issues.some(issue => issue.code === code && issue.pointer === `${SOURCE_0}/${tail}`),
      `${name}: expected ${code}@${tail}, got ${JSON.stringify(codes(issues))}`
    );
    assert.equal(sources.length, code === 'unknownKey' ? 1 : 0, name);
  }
});

test('the role message offers the path form for a dotted or indexed role, and the entries limit names its bound', () => {
  const dotted = parseSources(entriesRole('level', 'ctx.level')).issues[0]!.message;
  assert.match(dotted, /\{ "path": "ctx\.level" \}/);
  assert.match(dotted, /Platform events have no relationships/);
  const nine = parseSources(entriesSource({ payload: { entries: Array.from({ length: 9 }, (_, i) => `F${i}`) } }));
  assert.match(nine.issues[0]!.message, /1 to 8 fields/);
  assert.match(
    parseSources(entriesSource({ payload: { field: 'Payload__c', entries: ['Payload__c'] } })).issues[0]!.message,
    /cannot both be set/
  );
});

test('the same field name spelled in another case is a different entries item for the parser, as it is for the schema', () => {
  const { sources, issues } = parseSources(entriesSource({ payload: { entries: ['Payload__c', 'payload__c'] } }));

  assert.deepEqual(issues, []);
  assert.equal(sources.length, 1);
});

test('a record source takes field names only: a path role or an entries payload is an error there', () => {
  const entryRole = parseSources(entrySource({ fields: { time: 'CreatedDate', message: { path: 'msg' } } }));
  const headerRole = parseSources(headerSource({ fields: { startTime: { path: 'start' } } }));
  const entryEntries = parseSources(entrySource({ payload: { entries: ['Payload__c'] } }));
  const headerEntries = parseSources(headerSource({ payload: { entries: ['Body__c'] } }));

  assert.deepEqual(codes(entryRole.issues), [`invalidValue@${SOURCE_0}/entry/fields/message`]);
  assert.match(entryRole.issues[0]!.message, /event source only/);
  assert.deepEqual(codes(headerRole.issues), [`invalidValue@${SOURCE_0}/transaction/fields/startTime`]);
  assert.deepEqual(codes(entryEntries.issues), [`invalidValue@${SOURCE_0}/entry/payload/entries`]);
  assert.deepEqual(codes(headerEntries.issues), [`invalidValue@${SOURCE_0}/transaction/payload/entries`]);
  assert.deepEqual(
    [entryRole.sources, headerRole.sources, entryEntries.sources, headerEntries.sources].map(list => list.length),
    [0, 0, 0, 0]
  );
});

test('an existing event mapping keeps the digest it had before path roles and entries existed', () => {
  // Snapshots computed on main (145f046c) before this change, so an upgrade keeps every cursor valid.
  const digest = (source: Json) => parseSources(source).sources[0]!.digest;

  assert.equal(digest(appEventSource), '653dfbfaccd3');
  assert.equal(digest(eventSource({ details: ['Stack_Trace__c'], payload: 'Payload__c' })), '419272cfb3e3');
  assert.notEqual(
    digest(eventSource({ fields: { time: 'Logged_At__c', message: { path: 'msg' } } })),
    digest(appEventSource)
  );
  assert.notEqual(digest(entriesSource({ payload: { entries: ['Payload__c'] } })), digest(appEntriesSource));
});
