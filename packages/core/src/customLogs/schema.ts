/**
 * Schema reads, behind a seam so resolution is testable with fixtures.
 *
 * Two questions, two mechanisms, no fallback between them:
 * - Is the object there, and is it this framework? `EntityDefinition` for existence and
 *   `FieldDefinition` for the preset fingerprint. Both answer for `LoggerEndUser`, and
 *   `FieldDefinition` ignores FLS (measured on unlocked and managed orgs).
 * - What may this user SELECT? Describe, which omits FLS-hidden fields (measured: 151 of 240).
 * A refused metadata query makes the affected sources `unavailable: metadataQueryRefused`.
 */

import type { Connection } from '@salesforce/core';

import { errorCodeOf } from '../errors.js';
import { toolingQuery } from '../dataQuery.js';
import { escapeSoqlLiteral } from '../soql.js';
import { CANNOT_READ_CODES } from './errors.js';

/** The subset of describe this module reads. Parsed from jsforce's DescribeSObjectResult. */
export type ObjectDescribe = {
  name: string;
  keyPrefix: string;
  /** False for objects SOQL cannot read, such as platform events. */
  queryable: boolean;
  fields: readonly {
    name: string;
    label: string;
    type: string;
    relationshipName?: string;
    referenceTo: readonly string[];
    sortable: boolean;
    filterable: boolean;
    picklistValues: readonly { value: string; active: boolean }[];
  }[];
};

export type SchemaReader = {
  /** EntityDefinition lookup: the lower-cased names that exist. `refused` when this user cannot run the query. */
  existingObjects(names: readonly string[]): Promise<ReadonlySet<string> | 'refused'>;
  /** FieldDefinition lookup on one object, FLS-independent: the lower-cased names that exist. `refused` as above. */
  existingFields(object: string, names: readonly string[]): Promise<ReadonlySet<string> | 'refused'>;
  /** `undefined` when describe answers NOT_FOUND. */
  describe(object: string): Promise<ObjectDescribe | undefined>;
};

const MISSING_OBJECT_CODES: ReadonlySet<string> = new Set(['NOT_FOUND', 'INVALID_TYPE']);

function inList(names: readonly string[]): string {
  return names.map(name => `'${escapeSoqlLiteral(name)}'`).join(',');
}

async function metadataNames(connection: Connection, soql: string): Promise<ReadonlySet<string> | 'refused'> {
  try {
    const result = await toolingQuery<{ QualifiedApiName?: string }>(connection, soql);
    return new Set(
      result.records.flatMap(record => (record.QualifiedApiName ? [record.QualifiedApiName.toLowerCase()] : []))
    );
  } catch (error) {
    const code = errorCodeOf(error);
    if (code && CANNOT_READ_CODES.has(code)) return 'refused';
    throw error;
  }
}

/** The subset of jsforce's describe result that `ObjectDescribe` keeps. */
export function toObjectDescribe(described: Awaited<ReturnType<Connection['describe']>>): ObjectDescribe {
  return {
    name: described.name,
    keyPrefix: described.keyPrefix ?? '',
    queryable: described.queryable,
    fields: described.fields.map(field => ({
      name: field.name,
      label: field.label,
      type: field.type,
      ...(field.relationshipName ? { relationshipName: field.relationshipName } : {}),
      referenceTo: field.referenceTo ?? [],
      sortable: field.sortable,
      filterable: field.filterable,
      picklistValues: (field.picklistValues ?? []).map(({ value, active }) => ({ value, active }))
    }))
  };
}

export function createSchemaReader(connection: Connection): SchemaReader {
  return {
    existingObjects: names =>
      metadataNames(
        connection,
        `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN (${inList(names)})`
      ),
    existingFields: (object, names) =>
      metadataNames(
        connection,
        `SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${escapeSoqlLiteral(object)}' AND QualifiedApiName IN (${inList(names)})`
      ),
    async describe(object) {
      try {
        return toObjectDescribe(await connection.describe(object));
      } catch (error) {
        const code = errorCodeOf(error);
        if (code && MISSING_OBJECT_CODES.has(code)) return undefined;
        throw error;
      }
    }
  };
}

/**
 * Metadata answers for one username, misses cached like hits: an object EntityDefinition does not
 * list, a field FieldDefinition does not list, a describe NOT_FOUND, a refused query. A mapping
 * edit re-resolves against these answers and asks Salesforce only about names it has not seen, so
 * an org without Nebula pays for that absence once per session, not on every refresh.
 */
export type SchemaMemo = {
  readonly objects: Map<string, Promise<boolean | 'refused'>>;
  /** Keyed `${object}.${field}`, lower-cased. */
  readonly fields: Map<string, Promise<boolean | 'refused'>>;
  readonly describes: Map<string, Promise<ObjectDescribe | undefined>>;
};

export function createSchemaMemo(): SchemaMemo {
  return { objects: new Map(), fields: new Map(), describes: new Map() };
}

/** Answers `names` from `known`, asking `fetch` once for the ones it lacks and recording each answer. */
async function memoizedExistence(
  known: Map<string, Promise<boolean | 'refused'>>,
  names: readonly string[],
  keyOf: (name: string) => string,
  fetch: (missing: string[]) => Promise<ReadonlySet<string> | 'refused'>
): Promise<ReadonlySet<string> | 'refused'> {
  const wanted = new Map(names.map(name => [name.toLowerCase(), name]));
  const missing = [...wanted].filter(([lower]) => !known.has(keyOf(lower)));
  if (missing.length > 0) {
    const batch = fetch(missing.map(([, name]) => name));
    for (const [lower] of missing) {
      const answer = batch.then(result => (result === 'refused' ? 'refused' : result.has(lower)));
      known.set(keyOf(lower), answer);
      answer.catch(() => {
        if (known.get(keyOf(lower)) === answer) known.delete(keyOf(lower));
      });
    }
  }
  const answers = await Promise.all(
    [...wanted.keys()].map(async lower => [lower, await known.get(keyOf(lower))!] as const)
  );
  if (answers.some(([, answer]) => answer === 'refused')) return 'refused';
  return new Set(answers.flatMap(([lower, answer]) => (answer ? [lower] : [])));
}

/** A `SchemaReader` that answers from `memo` and records each new answer there. Batches the names it lacks. */
export function memoizedSchemaReader(reader: SchemaReader, memo: SchemaMemo): SchemaReader {
  return {
    existingObjects: names =>
      memoizedExistence(
        memo.objects,
        names,
        name => name,
        missing => reader.existingObjects(missing)
      ),
    existingFields: (object, names) =>
      memoizedExistence(
        memo.fields,
        names,
        name => `${object.toLowerCase()}.${name}`,
        missing => reader.existingFields(object, missing)
      ),
    describe(object) {
      const key = object.toLowerCase();
      let pending = memo.describes.get(key);
      if (!pending) {
        pending = reader.describe(object);
        memo.describes.set(key, pending);
        const own = pending;
        own.catch(() => {
          if (memo.describes.get(key) === own) memo.describes.delete(key);
        });
      }
      return pending;
    }
  };
}

export type DescribedField = ObjectDescribe['fields'][number];

const fieldIndexes = new WeakMap<ObjectDescribe, Map<string, DescribedField>>();

export function findField(describe: ObjectDescribe, name: string): DescribedField | undefined {
  let index = fieldIndexes.get(describe);
  if (!index) {
    index = new Map(describe.fields.map(field => [field.name.toLowerCase(), field]));
    fieldIndexes.set(describe, index);
  }
  return index.get(name.toLowerCase());
}

/** The reference field behind `relationship`, the first hop of a `Rel.Field` path. */
export function referenceFor(describe: ObjectDescribe, relationship: string): DescribedField | undefined {
  const wanted = relationship.toLowerCase();
  return describe.fields.find(field => field.type === 'reference' && field.relationshipName?.toLowerCase() === wanted);
}
