import fs from 'node:fs';
import path from 'node:path';

import type { ObjectDescribe, SchemaReader } from '../../src/customLogs/schema.ts';

export type DescribeFixtureName = 'unlocked-admin' | 'unlocked-enduser' | 'managed-admin' | 'managed-enduser';

/** Describe results captured from the dedicated Nebula scratch orgs by `scripts/custom-logs-smoke.mjs --capture-fixtures`. */
export function describeFixture(name: DescribeFixtureName): Map<string, ObjectDescribe> {
  const file = path.resolve(__dirname, `../fixtures/customLogs/describe-${name}.json`);
  return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, ObjectDescribe>));
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
