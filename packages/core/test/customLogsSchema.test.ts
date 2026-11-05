import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Ajv from 'ajv';

import {
  CONFIG_KEYS,
  CONFIG_POINTER,
  DETAIL_KEYS,
  ENTRY_KEYS,
  ENTRY_ROLES,
  EVENT_KEYS,
  EVENT_OBJECT_PATTERN,
  EVENT_PAYLOAD_KEYS,
  FIELD_NAME_PATTERN,
  FIELD_PATH_PATTERN,
  MAX_ENTRY_FIELDS,
  MAX_EVENT_RETENTION_DAYS,
  MIN_EVENT_RETENTION_DAYS,
  OBJECT_NAME_PATTERN,
  PAYLOAD_KEYS,
  ROLE_PATH_KEYS,
  SOURCE_ID_PATTERN,
  SOURCE_KEYS,
  TRANSACTION_KEYS,
  TRANSACTION_ROLES,
  parseCustomLogsConfig
} from '../src/customLogs/config.ts';
import {
  CUSTOM_LOG_CONFIG_ISSUE_SEVERITY,
  CUSTOM_LOG_LEVELS,
  type CustomLogConfigIssueCode
} from '../src/customLogs/contracts.ts';
import { NEBULA_PRESET } from '../src/customLogs/presets.ts';
import {
  appEntriesSource,
  appEventSource,
  appLogSource,
  entriesRole,
  entriesSource,
  entrySource,
  eventSource,
  headerFields,
  headerSource,
  projectWith,
  usageProject,
  type Json
} from './support/customLogsFixtures.ts';

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../schemas/sfdx-project.electivus.schema.json'), 'utf8')
) as Json & { definitions: Record<string, any> };
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const schemaAccepts = (project: unknown) => validate(JSON.parse(JSON.stringify(project)));

const unknown = { zzFutureKey: true };

/** Each fixture names the issue code the parser must report; the schema must reject it exactly when that code is an error. */
const fixtures: [CustomLogConfigIssueCode, string, Json][] = [
  ['unknownKey', 'unknown key on a source', { ...appLogSource, ...unknown }],
  ['unknownKey', 'unknown key on entry', entrySource(unknown)],
  [
    'unknownKey',
    'unknown key on entry.fields',
    entrySource({ fields: { ...((appLogSource.entry as Json).fields as Json), ...unknown } })
  ],
  ['unknownKey', 'typo of an optional key', entrySource({ detials: [] })],
  ['unknownKey', 'unknown key on a detail object', entrySource({ details: [{ field: 'Body__c', ...unknown }] })],
  ['unknownKey', 'unknown key on a payload object', entrySource({ payload: { field: 'Payload__c', ...unknown } })],
  ['unknownKey', 'unknown key on transaction', headerSource(unknown)],
  ['unknownKey', 'unknown key on transaction.fields', headerSource({ fields: { ...headerFields, ...unknown } })],
  [
    'missingRequired',
    'typo of a required key',
    entrySource({ fields: undefined, feilds: (appLogSource.entry as Json).fields })
  ],
  ['missingRequired', 'missing message role', entrySource({ fields: { time: 'CreatedDate' } })],
  [
    'missingRequired',
    'transaction without entry.parent',
    { ...headerSource({}), entry: { ...(appLogSource.entry as Json) } }
  ],
  ['missingRequired', 'payload object without field', entrySource({ payload: { columns: ['a'] } })],
  ['missingRequired', 'detail object without field', entrySource({ details: [{ presence: 'Has_Body__c' }] })],
  ['invalidValue', 'entry.parent without transaction', entrySource({ parent: 'X__c' })],
  ['invalidValue', 'non-canonical level', { ...appLogSource, levels: { Critical: 'FATAL' } }],
  [
    'invalidValue',
    'field path with a space',
    entrySource({ fields: { ...((appLogSource.entry as Json).fields as Json), origin: 'Source Field' } })
  ],
  ['invalidValue', 'source id with capitals', { ...appLogSource, id: 'AppLog' }],
  [
    'invalidValue',
    'payload column that is not a string',
    entrySource({ payload: { field: 'Payload__c', columns: [42] } })
  ],
  ['unknownKey', 'unknown key on event', eventSource(unknown)],
  [
    'unknownKey',
    'unknown key on event.fields',
    eventSource({ fields: { ...((appEventSource.event as Json).fields as Json), ...unknown } })
  ],
  ['unknownKey', 'parent under event', eventSource({ parent: 'Log__c' })],
  [
    'unknownKey',
    'unknown key on an event payload object',
    eventSource({ payload: { field: 'Payload__c', ...unknown } })
  ],
  ['missingRequired', 'neither entry nor event', { id: 'empty' }],
  ['missingRequired', 'event without the message role', eventSource({ fields: { time: 'Logged_At__c' } })],
  ['missingRequired', 'event payload object without field', eventSource({ payload: { columns: ['a'] } })],
  ['invalidValue', 'event beside entry', { ...appLogSource, event: appEventSource.event }],
  [
    'invalidValue',
    'event beside transaction',
    { id: 'x', transaction: headerSource({}).transaction, event: appEventSource.event }
  ],
  ['invalidValue', 'event object that is not a platform event', eventSource({ object: 'App_Log__c' })],
  [
    'invalidValue',
    'relationship path in an event role',
    eventSource({ fields: { time: 'Logged_At__c', message: 'Message__c', user: 'CreatedBy.Username' } })
  ],
  ['invalidValue', 'relationship path in an event column', eventSource({ columns: ['CreatedBy.Name'] })],
  ['invalidValue', 'relationship path in an event detail', eventSource({ details: ['Owner.Name'] })],
  ['invalidValue', 'relationship path in an event payload', eventSource({ payload: 'Owner.Json' })],
  ['unknownKey', 'role object with an extra key', entriesRole('level', { path: 'level', ...unknown })],
  ['missingRequired', 'role object without path', entriesRole('level', { paht: 'level' })],
  ['invalidValue', 'path that is not a string', entriesRole('level', { path: 7 })],
  ['invalidValue', 'empty path', entriesRole('level', { path: '' })],
  ['invalidValue', 'path over 255 characters', entriesRole('level', { path: 'x'.repeat(256) })],
  ['invalidValue', 'role that is a number', entriesRole('level', 7)],
  ['invalidValue', 'role that is an array', entriesRole('level', ['Level__c'])],
  ['invalidValue', 'role string with a bracket', entriesRole('level', 'levels[0]')],
  [
    'missingRequired',
    'path role without a payload',
    eventSource({ fields: { time: 'Logged_At__c', message: { path: 'msg' } }, payload: undefined })
  ],
  [
    'invalidValue',
    'field and entries together',
    entriesSource({ payload: { field: 'Payload__c', entries: ['Payload__c'] } })
  ],
  ['missingRequired', 'payload object with neither field nor entries', entriesSource({ payload: { columns: ['a'] } })],
  ['invalidValue', 'entries that is a string', entriesSource({ payload: { entries: 'Payload__c' } })],
  ['invalidValue', 'empty entries', entriesSource({ payload: { entries: [] } })],
  [
    'invalidValue',
    'entries past the limit',
    entriesSource({ payload: { entries: Array.from({ length: MAX_ENTRY_FIELDS + 1 }, (_, i) => `F${i}__c`) } })
  ],
  ['invalidValue', 'entries item that is not a field name', entriesSource({ payload: { entries: ['Owner.Json'] } })],
  ['invalidValue', 'entries item that is a number', entriesSource({ payload: { entries: [1] } })],
  [
    'invalidValue',
    'the same entries field twice',
    entriesSource({ payload: { entries: ['Payload__c', 'Payload__c'] } })
  ],
  [
    'unknownKey',
    'unknown key on an entries payload',
    entriesSource({ payload: { entries: ['Payload__c'], ...unknown } })
  ],
  [
    'invalidValue',
    'path role on a record entry',
    entrySource({ fields: { time: 'CreatedDate', message: { path: 'msg' } } })
  ],
  ['invalidValue', 'path role on a record header', headerSource({ fields: { startTime: { path: 'start' } } })],
  ['invalidValue', 'entries payload on a record entry', entrySource({ payload: { entries: ['Payload__c'] } })],
  ['invalidValue', 'entries payload on a record header', headerSource({ payload: { entries: ['Body__c'] } })]
];

const valid: [string, Json][] = [
  ['the usage example', appLogSource],
  ['a bare payload field', entrySource({ payload: 'Payload__c' })],
  [
    'a payload object with columns',
    entrySource({ payload: { field: 'Payload__c', columns: ['orderId', 'http.status', 'lines[0].sku'] } })
  ],
  ['a payload object without columns', entrySource({ payload: { field: 'Payload__c' } })],
  ['a bare header payload', headerSource({ payload: 'Body__c' })],
  ['a header payload object', headerSource({ payload: { field: 'Body__c', columns: ['tenant'] } })],
  [
    'both detail forms',
    entrySource({
      details: ['Stack_Trace__c', { field: 'Body__c', presence: 'Has_Body__c', truncated: 'Body_Truncated__c' }]
    })
  ],
  ['the event usage example', appEventSource],
  ['a bare event payload', eventSource({ payload: 'Payload__c' })],
  ['an event payload object with columns', eventSource({ payload: { field: 'Payload__c', columns: ['orderId'] } })],
  ['an event with only the required roles', eventSource({ fields: { time: 'Logged_At__c', message: 'Message__c' } })],
  ['an event source with levels', { ...appEventSource, levels: { Critical: 'ERROR' } }],
  ['the entries mapping of issue #1240', appEntriesSource],
  ['a bare entries payload', entriesSource({ payload: { entries: ['Payload__c'] } })],
  [
    'entries at the limit',
    entriesSource({ payload: { entries: Array.from({ length: MAX_ENTRY_FIELDS }, (_, i) => `F${i}__c`) } })
  ],
  [
    'path roles over a document payload',
    eventSource({ fields: { time: 'Logged_At__c', message: { path: 'msg' }, messageTruncated: { path: 'cut' } } })
  ],
  [
    'an entries field spelled twice in two cases',
    entriesSource({ payload: { entries: ['Payload__c', 'payload__c'] } })
  ],
  ['a source that replaces a built-in id', { ...appLogSource, id: 'nebula' }],
  ['the nebula preset', NEBULA_PRESET.raw as Json],
  [
    'the nebula-managed preset',
    { ...(NEBULA_PRESET.raw as Json), id: 'nebula-managed', label: 'Nebula Logger (managed)' }
  ]
];

test('the usage example from the design is valid for the schema and the parser', () => {
  assert.equal(validate(usageProject), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseCustomLogsConfig((usageProject.plugins as any).electivus.customLogs).issues, []);
});

test('schema and parser accept the same valid mappings', () => {
  for (const [name, source] of valid) {
    assert.equal(schemaAccepts(projectWith(source)), true, `${name}: ${JSON.stringify(validate.errors)}`);
    const parsed = parseCustomLogsConfig({ sources: [JSON.parse(JSON.stringify(source))] });
    assert.deepEqual(
      parsed.issues.filter(issue => issue.severity === 'error'),
      [],
      name
    );
    assert.equal(parsed.sources.length, 1, name);
  }
});

test('the schema rejects a mapping exactly when the parser reports an error for it', () => {
  for (const [code, name, source] of fixtures) {
    const parsed = parseCustomLogsConfig({ sources: [JSON.parse(JSON.stringify(source))] });
    assert.ok(
      parsed.issues.some(issue => issue.code === code),
      `${name}: parser reports ${code}, got ${JSON.stringify(parsed.issues)}`
    );
    const expectsError = CUSTOM_LOG_CONFIG_ISSUE_SEVERITY[code] === 'error';
    assert.equal(schemaAccepts(projectWith(source)), !expectsError, `schema and parser agree: ${name} (${code})`);
    assert.equal(
      parsed.issues.some(issue => issue.severity === 'error'),
      expectsError,
      `${name}: only ${code} is reported`
    );
    assert.equal(
      parsed.sources.length === 1,
      !expectsError,
      `${name}: the source loads exactly when there is no error`
    );
  }
});

test('a customLogs section that is not an object is rejected by both', () => {
  const section = 'nebula';
  assert.equal(CUSTOM_LOG_CONFIG_ISSUE_SEVERITY.notAnObject, 'error');
  assert.equal(schemaAccepts({ plugins: { electivus: { customLogs: section } } }), false);
  assert.deepEqual(
    parseCustomLogsConfig(section).issues.map(issue => issue.code),
    ['notAnObject']
  );
});

test('every issue code has a fixture or a stated reason the schema cannot see it', () => {
  const parserOnly = new Set<CustomLogConfigIssueCode>(['invalidJson', 'duplicateId']);
  const covered = new Set<CustomLogConfigIssueCode>([...fixtures.map(([code]) => code), 'notAnObject', ...parserOnly]);
  assert.deepEqual([...covered].sort(), Object.keys(CUSTOM_LOG_CONFIG_ISSUE_SEVERITY).sort());
  assert.equal(CUSTOM_LOG_CONFIG_ISSUE_SEVERITY.unknownKey, 'warning');
});

test('the parser knows exactly the keys and name patterns the schema declares', () => {
  const { definitions } = schema;
  const keys = (definition: any) => Object.keys(definition.properties).sort();
  const objectForm = (definition: any) => definition.oneOf.find((member: any) => member.type === 'object');

  assert.deepEqual(
    keys((schema as any).properties.plugins.properties.electivus.properties.customLogs),
    [...CONFIG_KEYS].sort()
  );
  assert.deepEqual(keys(definitions.source), [...SOURCE_KEYS].sort());
  assert.deepEqual(keys(definitions.source.properties.transaction), [...TRANSACTION_KEYS].sort());
  assert.deepEqual(keys(definitions.source.properties.entry), [...ENTRY_KEYS].sort());
  assert.deepEqual(keys(definitions.source.properties.event), [...EVENT_KEYS].sort());
  assert.deepEqual(keys(objectForm(definitions.eventDetail)), [...DETAIL_KEYS].sort());
  const objectForms = (definition: any) => definition.oneOf.filter((member: any) => member.type === 'object');
  assert.deepEqual(
    [...new Set(objectForms(definitions.eventPayload).flatMap(keys))].sort(),
    [...EVENT_PAYLOAD_KEYS].sort()
  );
  assert.equal(objectForms(definitions.eventPayload).at(-1).properties.entries.maxItems, MAX_ENTRY_FIELDS);
  assert.deepEqual(keys(objectForm(definitions.eventRole)), [...ROLE_PATH_KEYS].sort());
  assert.deepEqual(keys(objectForm(definitions.detail)), [...DETAIL_KEYS].sort());
  assert.deepEqual(keys(objectForm(definitions.payload)), [...PAYLOAD_KEYS].sort());
  assert.equal(definitions.source.properties.id.pattern, SOURCE_ID_PATTERN.source);
  assert.equal(definitions.fieldPath.pattern, FIELD_PATH_PATTERN.source);
  assert.equal(definitions.objectName.pattern, OBJECT_NAME_PATTERN.source);
  assert.equal(definitions.eventObjectName.pattern, EVENT_OBJECT_PATTERN.source);
  assert.equal(definitions.fieldName.pattern, FIELD_NAME_PATTERN.source);
});

test('the schema lists exactly the roles of the roles tables and the canonical levels', () => {
  const roleKeys = (definition: any) => Object.keys(definition.properties.fields.properties).sort();
  assert.deepEqual(roleKeys(schema.definitions.source.properties.entry), Object.keys(ENTRY_ROLES).sort());
  assert.deepEqual(roleKeys(schema.definitions.source.properties.event), Object.keys(ENTRY_ROLES).sort());
  assert.deepEqual(roleKeys(schema.definitions.source.properties.transaction), Object.keys(TRANSACTION_ROLES).sort());
  assert.deepEqual(schema.definitions.level.enum, [...CUSTOM_LOG_LEVELS]);

  const required = (definition: any) => [...definition.properties.fields.required].sort();
  const requiredRoles = (roles: Record<string, { required: boolean }>) =>
    Object.entries(roles)
      .filter(([, spec]) => spec.required)
      .map(([role]) => role)
      .sort();
  assert.deepEqual(required(schema.definitions.source.properties.entry), requiredRoles(ENTRY_ROLES));
  assert.deepEqual(required(schema.definitions.source.properties.event), requiredRoles(ENTRY_ROLES));
  assert.deepEqual(required(schema.definitions.source.properties.transaction), requiredRoles(TRANSACTION_ROLES));

  const event = schema.definitions.source.properties.event;
  for (const role of Object.keys(ENTRY_ROLES)) {
    assert.deepEqual(event.properties.fields.properties[role], { $ref: '#/definitions/eventRole' }, role);
  }
  const pathRoles = event.if.properties.fields.anyOf.map((member: any) => member.required[0]).sort();
  assert.deepEqual(pathRoles, Object.keys(ENTRY_ROLES).sort(), 'a path in any role requires a payload');
  assert.deepEqual(event.then, { required: ['payload'] });
});

test('the schema and the parser give the same verdict on eventRetentionDays', () => {
  const section = (eventRetentionDays: unknown) => ({ plugins: { electivus: { customLogs: { eventRetentionDays } } } });
  const parserRejects = (days: unknown) =>
    parseCustomLogsConfig({ eventRetentionDays: days }).issues.some(
      issue => issue.severity === 'error' && issue.pointer === `${CONFIG_POINTER}/eventRetentionDays`
    );
  const accepted = [MIN_EVENT_RETENTION_DAYS, 30, MAX_EVENT_RETENTION_DAYS];
  const rejected = [0, MIN_EVENT_RETENTION_DAYS - 1, MAX_EVENT_RETENTION_DAYS + 1, 1.5, '30', null];

  for (const days of accepted) {
    assert.equal(schemaAccepts(section(days)), true, String(days));
    assert.equal(parserRejects(days), false, String(days));
  }
  for (const days of rejected) {
    assert.equal(schemaAccepts(section(days)), false, String(days));
    assert.equal(parserRejects(days), true, String(days));
  }
  assert.equal(schemaAccepts({ plugins: { electivus: { customLogs: {} } } }), true);
});

test('a source with both entry and event, or neither, is rejected by the schema', () => {
  const both = { ...appLogSource, event: appEventSource.event };
  const neither = { id: 'empty' };

  assert.equal(schemaAccepts(projectWith(both)), false);
  assert.equal(schemaAccepts(projectWith(neither)), false);
  assert.equal(schemaAccepts(projectWith(appEventSource)), true);
  assert.equal(schemaAccepts(projectWith(appLogSource)), true);
});
