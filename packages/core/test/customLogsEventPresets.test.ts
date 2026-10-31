import assert from 'node:assert/strict';
import test from 'node:test';

import { toSourceInfo } from '../src/customLogs/catalog.ts';
import { NEBULA_EVENTS_MANAGED_PRESET, NEBULA_EVENTS_PRESET, qualifyPath } from '../src/customLogs/presets.ts';
import { resolveDefinition } from '../src/customLogs/resolve.ts';
import type { CatalogEntry } from '../src/customLogs/resolved.ts';
import type { ObjectDescribe } from '../src/customLogs/schema.ts';
import { logEntryEventDescribe } from './support/describeFixtures.ts';

/** `LogEntryEvent__e` as the managed package ships it: the object and every custom field carry `Nebula__`. */
function managedDescribe(): ObjectDescribe {
  const unprefixed = logEntryEventDescribe();
  return {
    ...unprefixed,
    name: qualifyPath(unprefixed.name, 'Nebula'),
    fields: unprefixed.fields.map(field => ({ ...field, name: qualifyPath(field.name, 'Nebula') }))
  };
}

function ready(entry: CatalogEntry) {
  assert.equal(entry.state, 'ready', entry.state === 'unavailable' ? entry.message : entry.state);
  return entry;
}

test('nebula-events resolves against the measured LogEntryEvent__e describe with no mapped field hidden', () => {
  const describe = logEntryEventDescribe();

  const entry = ready(
    resolveDefinition(NEBULA_EVENTS_PRESET.definition, 'builtin', '', new Map([[describe.name, describe]]))
  );

  assert.ok(entry.state === 'ready' && entry.source.shape.kind === 'events');
  assert.deepEqual(entry.source.hidden, []);
  assert.equal(entry.source.shape.event.object, 'LogEntryEvent__e');
  assert.equal(entry.source.shape.event.channel, '/event/LogEntryEvent__e');
  assert.deepEqual(toSourceInfo(entry).capabilities, { levelFilter: true, userFilter: true, apexLogLink: true });
  assert.deepEqual(toSourceInfo(entry).objects, { event: 'LogEntryEvent__e' });
});

test('nebula-events-managed resolves the same mapping in the Nebula namespace', () => {
  const describe = managedDescribe();

  const entry = ready(
    resolveDefinition(
      NEBULA_EVENTS_MANAGED_PRESET.definition,
      'builtin',
      'Nebula',
      new Map([[describe.name, describe]])
    )
  );

  assert.ok(entry.state === 'ready' && entry.source.shape.kind === 'events');
  assert.deepEqual(entry.source.hidden, []);
  assert.equal(entry.source.shape.event.object, 'Nebula__LogEntryEvent__e');
  assert.equal(entry.source.shape.event.channel, '/event/Nebula__LogEntryEvent__e');
  assert.equal(entry.source.namespace, 'Nebula');
});

test('every field the nebula-events fingerprint names exists on the measured describe', () => {
  const fields = new Set(logEntryEventDescribe().fields.map(field => field.name));

  assert.ok(NEBULA_EVENTS_PRESET.fingerprint.length > 0);
  assert.deepEqual(
    NEBULA_EVENTS_PRESET.fingerprint.filter(name => !fields.has(name)),
    []
  );
});

test('a mapped field the org does not have hides one optional field and leaves the source ready', () => {
  const describe = logEntryEventDescribe();
  const without = { ...describe, fields: describe.fields.filter(field => field.name !== 'TransactionScenario__c') };

  const entry = ready(
    resolveDefinition(NEBULA_EVENTS_PRESET.definition, 'builtin', '', new Map([[without.name, without]]))
  );

  assert.ok(entry.state === 'ready');
  assert.deepEqual(entry.source.hidden, ['event.columns.TransactionScenario__c']);
});
