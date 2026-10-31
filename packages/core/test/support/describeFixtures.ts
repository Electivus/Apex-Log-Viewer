import fs from 'node:fs';
import path from 'node:path';

import { toObjectDescribe, type ObjectDescribe, type SchemaReader } from '../../src/customLogs/schema.ts';

export type DescribeFixtureName = 'unlocked-admin' | 'unlocked-enduser' | 'managed-admin' | 'managed-enduser';

/** Describe results captured from the dedicated Nebula scratch orgs by `scripts/custom-logs-smoke.mjs --capture-fixtures`. */
export function describeFixture(name: DescribeFixtureName): Map<string, ObjectDescribe> {
  const file = path.resolve(__dirname, `../fixtures/customLogs/describe-${name}.json`);
  const captured = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Omit<ObjectDescribe, 'queryable'>>;
  // The capture keeps no `queryable`; every captured object is a record object SOQL reads.
  return new Map(Object.entries(captured).map(([object, described]) => [object, { ...described, queryable: true }]));
}

/** The measured describe of Nebula's `LogEntryEvent__e` (`queryable: false`, key prefix `e00`), reduced as the reader does. */
export function logEntryEventDescribe(): ObjectDescribe {
  const file = path.resolve(__dirname, '../../../../test/fixtures/customLogs/events/describe-log-entry-event.json');
  return toObjectDescribe(JSON.parse(fs.readFileSync(file, 'utf8')) as Parameters<typeof toObjectDescribe>[0]);
}

/** The describe of the events org's `ALV_Test_Log__e` (`queryable: false`), already in the reduced form. */
export function alvTestLogDescribe(): ObjectDescribe {
  const file = path.resolve(__dirname, '../../../../test/fixtures/customLogs/events/describe-alv-test-log.json');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, ObjectDescribe>).ALV_Test_Log__e!;
}

/** The raw describe bodies a Salesforce double serves for `sobjects/<name>/describe`. */
export function describeBodies(name: DescribeFixtureName): Record<string, ObjectDescribe> {
  return Object.fromEntries(describeFixture(name));
}

export type FakeSchema = {
  objects: readonly string[];
  /** Fields FieldDefinition lists, per object. Missing: every field of the described object. */
  fields?: Record<string, readonly string[]>;
  describes: ReadonlyMap<string, ObjectDescribe>;
  refuse?: 'objects' | 'fields';
};

export type FakeSchemaReader = SchemaReader & { calls: { objects: string[][]; fields: string[]; describes: string[] } };

/** A `SchemaReader` over fixtures that records what it was asked, for tests of detection and memoization. */
export function fakeSchemaReader(schema: FakeSchema): FakeSchemaReader {
  const calls = { objects: [] as string[][], fields: [] as string[], describes: [] as string[] };
  const listed = new Set(schema.objects.map(name => name.toLowerCase()));
  return {
    calls,
    async existingObjects(names) {
      calls.objects.push([...names]);
      if (schema.refuse === 'objects') return 'refused';
      return new Set(names.map(name => name.toLowerCase()).filter(name => listed.has(name)));
    },
    async existingFields(object, names) {
      calls.fields.push(object);
      if (schema.refuse === 'fields') return 'refused';
      const known = new Set(
        (schema.fields?.[object] ?? schema.describes.get(object)?.fields.map(field => field.name) ?? []).map(name =>
          name.toLowerCase()
        )
      );
      return new Set(names.map(name => name.toLowerCase()).filter(name => known.has(name)));
    },
    async describe(object) {
      calls.describes.push(object);
      return schema.describes.get(object);
    }
  };
}
