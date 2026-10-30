/**
 * Turning definitions into what this org and this user can actually query: `locateSource` asks
 * the org whether a definition's objects are there (and, for a built-in, whether they are its
 * framework), then `resolveDefinition` checks every mapped field against describe and yields the
 * `CatalogEntry` of `resolved.ts`.
 */

import {
  ENTRY_ROLES,
  FLAG_TYPES,
  LONG_TEXT_TYPES,
  TRANSACTION_ROLES,
  type ByRole,
  type DescribeFieldType,
  type DetailDefinition,
  type EntryDefinition,
  type FieldPath,
  type PayloadDefinition,
  type RoleSpec,
  type SourceDefinition,
  type TransactionDefinition
} from './config.js';
import type { CustomLogSourceOrigin, CustomLogUnavailableReason } from './contracts.js';
import { buildLevelTable } from './levels.js';
import { qualifyPath, type BuiltinPreset } from './presets.js';
import {
  CREATED_DATE,
  assertNever,
  filterableField,
  type CatalogEntry,
  type CatalogHead,
  type EntryLevelPredicate,
  type HeaderLevelPredicate,
  type ResolvedDetail,
  type ResolvedEntryObject,
  type ResolvedField,
  type ResolvedLongField,
  type ResolvedPayload,
  type ResolvedShape,
  type ResolvedTimeField,
  type ResolvedTransactionObject
} from './resolved.js';
import { findField, referenceFor, type DescribedField, type ObjectDescribe, type SchemaReader } from './schema.js';

/** The object names a definition reads, qualified for `namespace`: header, entry, never relationship targets. */
export function definitionObjects(
  definition: SourceDefinition,
  namespace: string
): { transaction?: string; entry: string } {
  const { shape } = definition;
  switch (shape.kind) {
    case 'transactions':
      return {
        transaction: qualifyPath(shape.transaction.object, namespace),
        entry: qualifyPath(shape.entry.object, namespace)
      };
    case 'entries':
      return { entry: qualifyPath(shape.entry.object, namespace) };
    default:
      return assertNever(shape, 'source shape');
  }
}

/** The objects of `definitionObjects` as a list: the header first, then the entry. */
export function objectNames(objects: CatalogHead['objects']): string[] {
  return [...(objects.transaction ? [objects.transaction] : []), objects.entry];
}

function humanizeApiName(name: string): string {
  const base = name.replace(/__[a-z]+$/, '').replace(/^.*\./, '');
  return base
    .replace(/_+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

type ResolveFailure = { reason: CustomLogUnavailableReason; message: string };

/** Resolution works through `Fail` to abandon the whole source with a reason; `resolveDefinition` catches it. */
class Fail extends Error {
  constructor(public readonly failure: ResolveFailure) {
    super(failure.message);
  }
}

const COMPOUND_TYPES: ReadonlySet<string> = new Set(['address', 'location', 'base64', 'anyType', 'complexvalue']);

class ObjectResolver {
  readonly hidden: string[] = [];

  constructor(
    private readonly describe: ObjectDescribe,
    private readonly describes: ReadonlyMap<string, ObjectDescribe>,
    private readonly namespace: string
  ) {}

  /** The API name Salesforce reports, qualified for the org. */
  get object(): string {
    return this.describe.name;
  }

  get keyPrefix(): string {
    return this.describe.keyPrefix;
  }

  /** The field at `path`, or undefined when describe omits it (absent, or hidden by FLS for this user). */
  field(path: string, types?: readonly string[], what?: string): ResolvedField | undefined {
    const qualified = qualifyPath(path, this.namespace);
    const [first, second, ...rest] = qualified.split('.');
    let found: { field: DescribedField; api: string } | undefined;
    if (second === undefined) {
      const field = findField(this.describe, first!);
      found = field && { field, api: field.name };
    } else if (rest.length === 0) {
      const reference = referenceFor(this.describe, first!);
      for (const target of reference?.referenceTo ?? []) {
        const field = this.describes.has(target) ? findField(this.describes.get(target)!, second) : undefined;
        if (field) {
          found = { field, api: `${reference!.relationshipName}.${field.name}` };
          break;
        }
      }
    }
    if (!found) return undefined;
    const accepted = types ? types.includes(found.field.type) : !COMPOUND_TYPES.has(found.field.type);
    if (!accepted) {
      throw new Fail({
        reason: 'fieldTypeMismatch',
        message: `${what ?? path} ("${found.api}") is a ${found.field.type} field, which this mapping cannot use here.`
      });
    }
    return {
      key: path,
      api: found.api,
      label: found.field.label,
      type: found.field.type as DescribeFieldType,
      sortable: found.field.sortable,
      filterable: found.field.filterable
    };
  }

  required(path: string, types: readonly string[], what: string): ResolvedField {
    const field = this.field(path, types, what);
    if (!field) {
      throw new Fail({
        reason: 'requiredFieldMissing',
        message: `${what} ("${qualifyPath(path, this.namespace)}") is missing from ${this.object} or hidden from this user.`
      });
    }
    return field;
  }

  /** An optional field: a hidden one is dropped and listed in `hidden` as `what`. */
  optional(path: string, types: readonly string[] | undefined, what: string): ResolvedField | undefined {
    const field = this.field(path, types, what);
    if (!field) this.hidden.push(what);
    return field;
  }

  /** Every mapped role. A required one missing or hidden fails the source; a hidden optional one is dropped. */
  roles<R extends Record<string, RoleSpec>>(
    specs: R,
    paths: ByRole<R, FieldPath>,
    at: string
  ): ByRole<R, ResolvedField> {
    const resolved: Record<string, ResolvedField> = {};
    for (const [role, spec] of Object.entries(specs)) {
      const path = (paths as Partial<Record<string, FieldPath>>)[role];
      if (path === undefined) continue;
      const what = `${at}.fields.${role}`;
      const field = spec.required ? this.required(path, spec.types, what) : this.optional(path, spec.types, what);
      if (field) resolved[role] = field;
    }
    return resolved as ByRole<R, ResolvedField>;
  }

  columns(paths: readonly FieldPath[], at: string): ResolvedField[] {
    return paths.flatMap(path => {
      const field = this.optional(path, undefined, `${at}.columns.${path}`);
      return field ? [field] : [];
    });
  }

  longField(path: FieldPath, at: string): ResolvedLongField {
    const field = this.optional(path, LONG_TEXT_TYPES, at);
    return field
      ? { state: 'readable', key: path, field }
      : { state: 'hidden', key: path, label: humanizeApiName(path) };
  }

  details(details: readonly DetailDefinition[]): ResolvedDetail[] {
    return details.map(detail => {
      const at = `entry.details.${detail.field}`;
      const text = this.longField(detail.field, at);
      const presence = detail.presence ? this.optional(detail.presence, FLAG_TYPES, `${at}.presence`) : undefined;
      const truncated = detail.truncated ? this.optional(detail.truncated, FLAG_TYPES, `${at}.truncated`) : undefined;
      return { ...text, ...(presence ? { presence } : {}), ...(truncated ? { truncated } : {}) };
    });
  }

  payload(definition: PayloadDefinition | undefined, at: string): ResolvedPayload | undefined {
    return definition && { ...this.longField(definition.field, at), columns: definition.columns };
  }
}

function timeFieldOf(field: ResolvedField): ResolvedTimeField {
  return { ...field, encoding: field.type === 'datetime' ? 'datetime' : 'epochMillis' };
}

function entryPredicateOf(ordinal: ResolvedField | undefined, level: ResolvedField | undefined): EntryLevelPredicate {
  const byOrdinal = filterableField(ordinal);
  if (byOrdinal) return { kind: 'ordinal', field: byOrdinal };
  const byValue = filterableField(level);
  return byValue ? { kind: 'values', field: byValue } : { kind: 'none' };
}

function headerPredicateOf(
  ordinal: ResolvedField | undefined,
  entry: ResolvedEntryObject & { readonly parent: ResolvedField }
): HeaderLevelPredicate {
  const own = filterableField(ordinal);
  if (own) return { kind: 'ordinal', field: own };
  const { levelPredicate } = entry;
  return levelPredicate.kind === 'none'
    ? { kind: 'none' }
    : { kind: 'semiJoin', entryObject: entry.object, parent: entry.parent, entry: levelPredicate };
}

function picklistValuesOf(describe: ObjectDescribe, field: ResolvedField | undefined): string[] | undefined {
  if (field?.type !== 'picklist') return undefined;
  return findField(describe, field.api)?.picklistValues.map(item => item.value);
}

function resolveEntry(definition: EntryDefinition, resolver: ObjectResolver): ResolvedEntryObject {
  const roles = resolver.roles(ENTRY_ROLES, definition.fields, 'entry');
  const time = timeFieldOf(roles.time);
  return {
    object: resolver.object,
    keyPrefix: resolver.keyPrefix,
    roles: { ...roles, time },
    timeFilter: time.filterable ? time : CREATED_DATE,
    sequence: [roles.order, time, CREATED_DATE].find(field => field?.sortable) ?? CREATED_DATE,
    columns: resolver.columns(definition.columns, 'entry'),
    details: resolver.details(definition.details),
    ...(definition.payload ? { payload: resolver.payload(definition.payload, 'entry.payload') } : {}),
    levelPredicate: entryPredicateOf(roles.levelOrdinal, roles.level),
    ...(definition.systemMessagePrefix ? { systemMessagePrefix: definition.systemMessagePrefix } : {})
  };
}

function resolveTransaction(
  definition: TransactionDefinition,
  resolver: ObjectResolver,
  entry: ResolvedEntryObject & { readonly parent: ResolvedField }
): ResolvedTransactionObject {
  const roles = resolver.roles(TRANSACTION_ROLES, definition.fields, 'transaction');
  const startTime = timeFieldOf(roles.startTime);
  return {
    object: resolver.object,
    keyPrefix: resolver.keyPrefix,
    roles: { ...roles, startTime },
    timeFilter: startTime.filterable ? startTime : CREATED_DATE,
    columns: resolver.columns(definition.columns, 'transaction'),
    ...(definition.payload ? { payload: resolver.payload(definition.payload, 'transaction.payload') } : {}),
    levelPredicate: headerPredicateOf(roles.maxLevelOrdinal, entry)
  };
}

function headOf(definition: SourceDefinition, origin: CustomLogSourceOrigin, namespace: string): CatalogHead {
  return {
    id: definition.id,
    label: definition.label,
    origin,
    shape: definition.shape.kind,
    ...(namespace ? { namespace } : {}),
    objects: definitionObjects(definition, namespace)
  };
}

/**
 * Resolve one definition against describe results. Pure. `describes` is keyed by the object API
 * names of the org (header, entry, and the targets of one-hop relationship paths).
 *
 * - Required role missing or hidden → `unavailable: requiredFieldMissing`.
 * - A role, detail flag or payload field whose type is outside its accepted types
 *   (role table, FLAG_TYPES, LONG_TEXT_TYPES) → `unavailable: fieldTypeMismatch`.
 * - Optional role, column, detail flag hidden → dropped, listed in `hidden`.
 * - Detail or payload text hidden → kept as `{ state: 'hidden' }`, listed in `hidden`.
 * - Relationship path `Rel.Field`: the first hop must be a reference whose `relationshipName`
 *   is `Rel`; the second hop is checked on the referenced object's describe (`describes`).
 * - `timeFilter`, `sequence`: chosen by sortable/filterable flags as documented on the types.
 * - `levelPredicate`: ordinal field → 'ordinal'; else level field → 'values'; header without
 *   `maxLevelOrdinal` but entry predicate available → 'semiJoin'; else 'none'.
 */
export function resolveDefinition(
  definition: SourceDefinition,
  origin: CustomLogSourceOrigin,
  namespace: string,
  describes: ReadonlyMap<string, ObjectDescribe>
): CatalogEntry {
  const head = headOf(definition, origin, namespace);
  const unavailable = (failure: ResolveFailure): CatalogEntry => ({ head, state: 'unavailable', ...failure });
  const describeOf = (name: string) => describes.get(name);
  const entryDescribe = describeOf(head.objects.entry);
  const transactionDescribe = head.objects.transaction ? describeOf(head.objects.transaction) : undefined;
  if (!entryDescribe || (head.objects.transaction && !transactionDescribe)) {
    const missing = !entryDescribe ? head.objects.entry : head.objects.transaction;
    return unavailable({
      reason: 'objectNotReadable',
      message: `${missing} exists, but describe does not return it for this user.`
    });
  }

  try {
    const { shape } = definition;
    const entryResolver = new ObjectResolver(entryDescribe, describes, namespace);
    const entry = resolveEntry(shape.entry, entryResolver);
    let resolvedShape: ResolvedShape;
    let hidden: string[];
    switch (shape.kind) {
      case 'transactions': {
        const parent = entryResolver.required(shape.entry.parent, ['reference'], 'entry.parent');
        const withParent = { ...entry, parent };
        const transactionResolver = new ObjectResolver(transactionDescribe!, describes, namespace);
        resolvedShape = {
          kind: 'transactions',
          transaction: resolveTransaction(shape.transaction, transactionResolver, withParent),
          entry: withParent
        };
        hidden = [...transactionResolver.hidden, ...entryResolver.hidden];
        break;
      }
      case 'entries':
        resolvedShape = { kind: 'entries', entry };
        hidden = entryResolver.hidden;
        break;
      default:
        return assertNever(shape, 'source shape');
    }
    return {
      head,
      state: 'ready',
      source: {
        id: definition.id,
        label: definition.label,
        origin,
        ...(namespace ? { namespace } : {}),
        digest: definition.digest,
        shape: resolvedShape,
        levels: buildLevelTable(definition.levels, picklistValuesOf(entryDescribe, entry.roles.level)),
        hidden
      }
    };
  } catch (error) {
    if (error instanceof Fail) return unavailable(error.failure);
    throw error;
  }
}

/**
 * Describe the definition's objects, then the one-hop relationship targets its paths name. An
 * object describe does not return is left out, for `resolveDefinition` to report.
 */
async function describeAll(
  definition: SourceDefinition,
  namespace: string,
  reader: SchemaReader
): Promise<Map<string, ObjectDescribe>> {
  const objects = definitionObjects(definition, namespace);
  const described = await Promise.all(
    objectNames(objects).map(async name => [name, await reader.describe(name)] as const)
  );
  const describes = new Map<string, ObjectDescribe>();
  for (const [name, describe] of described) {
    if (!describe) return describes;
    describes.set(name, describe);
  }

  const { shape } = definition;
  const paths: [ObjectDescribe, string][] = [];
  const addPaths = (name: string, list: readonly string[]) =>
    list.forEach(path => paths.push([describes.get(name)!, path]));
  const roleFields = (fields: object) => Object.values(fields as Record<string, string>);
  addPaths(objects.entry, [
    ...roleFields(shape.entry.fields),
    ...shape.entry.columns,
    ...shape.entry.details.flatMap(detail =>
      [detail.field, detail.presence, detail.truncated].filter((item): item is FieldPath => !!item)
    ),
    ...(shape.entry.payload ? [shape.entry.payload.field] : [])
  ]);
  switch (shape.kind) {
    case 'transactions':
      addPaths(objects.transaction!, [
        ...roleFields(shape.transaction.fields),
        ...shape.transaction.columns,
        ...(shape.transaction.payload ? [shape.transaction.payload.field] : [])
      ]);
      break;
    case 'entries':
      break;
    default:
      assertNever(shape, 'source shape');
  }
  const targets = new Set<string>();
  for (const [describe, path] of paths) {
    const [relationship, field] = qualifyPath(path, namespace).split('.');
    if (field === undefined) continue;
    referenceFor(describe, relationship!)?.referenceTo.forEach(target => targets.add(target));
  }
  await Promise.all(
    [...targets].map(async target => {
      const describe = await reader.describe(target);
      if (describe) describes.set(target, describe);
    })
  );
  return describes;
}

/** A definition to look for in the org: a project source as written, or a built-in preset in its namespace. */
export type SourceCandidate =
  | { readonly origin: 'config'; readonly definition: SourceDefinition }
  | ({ readonly origin: 'builtin' } & BuiltinPreset);

/**
 * Look for a definition in the org, then `resolveDefinition` it against describe. Object existence
 * comes from EntityDefinition, a preset's fingerprint from FieldDefinition.
 *
 * - EntityDefinition or FieldDefinition `refused` → `unavailable: metadataQueryRefused`
 * - an object missing → a preset is `notInstalled`; a project source is `unavailable: objectNotFound`
 * - a preset whose fingerprint fails → `notInstalled` with `hint: 'collision'`, unless a project
 *   source already maps one of its objects (`configuredObjects`, lower-cased), where the hint is noise
 * - an object describe does not return → `unavailable: objectNotReadable`, from `resolveDefinition`
 */
export async function locateSource(
  candidate: SourceCandidate,
  reader: SchemaReader,
  configuredObjects: ReadonlySet<string>
): Promise<CatalogEntry> {
  const { origin, definition } = candidate;
  const namespace = candidate.origin === 'builtin' ? candidate.namespace : '';
  const head = headOf(definition, origin, namespace);
  const refused: CatalogEntry = {
    head,
    state: 'unavailable',
    reason: 'metadataQueryRefused',
    message: 'This user cannot query EntityDefinition or FieldDefinition, so the mapped objects cannot be checked.'
  };

  const wanted = objectNames(head.objects);
  const existing = await reader.existingObjects(wanted);
  if (existing === 'refused') return refused;
  const missing = wanted.find(name => !existing.has(name.toLowerCase()));
  if (missing) {
    return candidate.origin === 'builtin'
      ? { head, state: 'notInstalled' }
      : { head, state: 'unavailable', reason: 'objectNotFound', message: `${missing} does not exist in this org.` };
  }

  if (candidate.origin === 'builtin') {
    const fingerprint = candidate.fingerprint.map(field => qualifyPath(field, namespace));
    const found = await reader.existingFields(head.objects.entry, fingerprint);
    if (found === 'refused') return refused;
    if (!fingerprint.every(field => found.has(field.toLowerCase()))) {
      const mapped = wanted.some(name => configuredObjects.has(name.toLowerCase()));
      return mapped ? { head, state: 'notInstalled' } : { head, state: 'notInstalled', hint: 'collision' };
    }
  }
  return resolveDefinition(definition, origin, namespace, await describeAll(definition, namespace, reader));
}
