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
  type EventDefinition,
  type EventPayloadDefinition,
  type FieldPath,
  type PathRef,
  type PayloadDefinition,
  type RecordShapeDefinition,
  type RoleSpec,
  type SourceDefinition,
  type TransactionDefinition
} from './config.js';
import type { CustomLogSourceObjects, CustomLogSourceOrigin, CustomLogUnavailableReason } from './contracts.js';
import { buildLevelTable } from './levels.js';
import { qualifyPath, type BuiltinPreset } from './presets.js';
import {
  CREATED_DATE,
  assertNever,
  filterableField,
  readablePayloadFields,
  type CatalogEntry,
  type CatalogHead,
  type EntryLevelPredicate,
  type HeaderLevelPredicate,
  type ResolvedDetail,
  type ResolvedEntryObject,
  type ResolvedEventObject,
  type ResolvedEventPayload,
  type ResolvedField,
  type ResolvedLongField,
  type ResolvedParent,
  type ResolvedPayload,
  type ResolvedPayloadPath,
  type ResolvedRecordShape,
  type ResolvedTimeField,
  type ResolvedTransactionObject,
  type RoleSource
} from './resolved.js';
import { findField, referenceFor, type DescribedField, type ObjectDescribe, type SchemaReader } from './schema.js';

function recordObjects(shape: RecordShapeDefinition, namespace: string): { transaction?: string; entry: string } {
  switch (shape.kind) {
    case 'transactions':
      return {
        transaction: qualifyPath(shape.transaction.object, namespace),
        entry: qualifyPath(shape.entry.object, namespace)
      };
    case 'entries':
      return { entry: qualifyPath(shape.entry.object, namespace) };
    default:
      return assertNever(shape, 'record shape');
  }
}

/** The object names a definition reads, qualified for `namespace`: header, entry or event, never relationship targets. */
export function definitionObjects(definition: SourceDefinition, namespace: string): CustomLogSourceObjects {
  const { shape } = definition;
  switch (shape.kind) {
    case 'transactions':
    case 'entries':
      return recordObjects(shape, namespace);
    case 'events':
      return { event: qualifyPath(shape.event.object, namespace) };
    default:
      return assertNever(shape, 'source shape');
  }
}

/** The objects of `definitionObjects` as a list: the header first, then the entry; or the event alone. */
export function objectNames(objects: CustomLogSourceObjects): string[] {
  if ('event' in objects) return [objects.event];
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
    private readonly namespace: string,
    /** Rows are filtered and ordered in memory, not by SOQL, so no field is sortable or filterable. */
    private readonly inMemory = false
  ) {}

  /** The API name Salesforce reports, qualified for the org. */
  get object(): string {
    return this.describe.name;
  }

  get keyPrefix(): string {
    return this.describe.keyPrefix;
  }

  /** The described field at `qualified` and the relationship it is read through, at most one hop away. */
  private locate(qualified: string): { field: DescribedField; via: string | undefined } | undefined {
    const [first, second, ...rest] = qualified.split('.');
    if (second === undefined) {
      const field = findField(this.describe, first!);
      return field && { field, via: undefined };
    }
    if (rest.length > 0) return undefined;
    const reference = referenceFor(this.describe, first!);
    for (const target of reference?.referenceTo ?? []) {
      const field = this.describes.has(target) ? findField(this.describes.get(target)!, second) : undefined;
      if (field) return { field, via: reference!.relationshipName };
    }
    return undefined;
  }

  /** The field at `path`, or undefined when describe omits it (absent, or hidden by FLS for this user). */
  field(path: string, types?: readonly string[], what?: string): ResolvedField | undefined {
    const found = this.locate(qualifyPath(path, this.namespace));
    if (!found) return undefined;
    const api = found.via ? `${found.via}.${found.field.name}` : found.field.name;
    const accepted = types ? types.includes(found.field.type) : !COMPOUND_TYPES.has(found.field.type);
    if (!accepted) {
      throw new Fail({
        reason: 'fieldTypeMismatch',
        message: `${what ?? path} ("${api}") is a ${found.field.type} field, which this mapping cannot use here.`
      });
    }
    return {
      from: 'field',
      key: path,
      api,
      label: found.field.label,
      type: found.field.type as DescribeFieldType,
      sortable: !this.inMemory && found.field.sortable,
      filterable: !this.inMemory && found.field.filterable
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

  /**
   * The entry's reference to its header, with the relationship path a header field is read through:
   * `Log__r` for `Log__c`, and `Log__r.ParentLog__r` for `Log__r.ParentLog__c`.
   */
  parent(path: string): ResolvedParent {
    const field = this.required(path, ['reference'], 'entry.parent');
    const found = this.locate(qualifyPath(path, this.namespace));
    const relationshipName = found?.field.relationshipName;
    if (!found || !relationshipName) {
      throw new Fail({
        reason: 'fieldTypeMismatch',
        message: `entry.parent ("${field.api}") has no relationship name in describe, so an entry cannot read its header.`
      });
    }
    return { ...field, relationshipPath: found.via ? `${found.via}.${relationshipName}` : relationshipName };
  }

  /**
   * Every mapped role. A required one missing or hidden fails the source; a hidden optional one is
   * dropped. A `{ path }` role is never checked against describe: being mapped satisfies it.
   */
  roles<R extends Record<string, RoleSpec>>(
    specs: R,
    refs: Readonly<Partial<Record<string, string>>>,
    at: string
  ): ByRole<R, ResolvedField>;
  roles<R extends Record<string, RoleSpec>>(
    specs: R,
    refs: Readonly<Partial<Record<string, string | PathRef>>>,
    at: string
  ): ByRole<R, RoleSource>;
  roles<R extends Record<string, RoleSpec>>(
    specs: R,
    refs: Readonly<Partial<Record<string, string | PathRef>>>,
    at: string
  ): ByRole<R, RoleSource> {
    const resolved: Record<string, RoleSource> = {};
    for (const [role, spec] of Object.entries(specs)) {
      const ref = refs[role];
      if (ref === undefined) continue;
      const what = `${at}.fields.${role}`;
      const source =
        typeof ref === 'string'
          ? spec.required
            ? this.required(ref, spec.types, what)
            : this.optional(ref, spec.types, what)
          : pathSource(ref);
      if (source) resolved[role] = source;
    }
    return resolved as ByRole<R, RoleSource>;
  }

  columns(paths: readonly string[], at: string): ResolvedField[] {
    return paths.flatMap(path => {
      const field = this.optional(path, undefined, `${at}.columns.${path}`);
      return field ? [field] : [];
    });
  }

  longField(path: string, at: string): ResolvedLongField {
    const field = this.optional(path, LONG_TEXT_TYPES, at);
    return field
      ? { state: 'readable', key: path, field }
      : { state: 'hidden', key: path, label: humanizeApiName(path) };
  }

  details(details: readonly DetailDefinition<string>[], owner: 'entry' | 'event'): ResolvedDetail[] {
    return details.map(detail => {
      const at = `${owner}.details.${detail.field}`;
      const text = this.longField(detail.field, at);
      const presence = detail.presence ? this.optional(detail.presence, FLAG_TYPES, `${at}.presence`) : undefined;
      const truncated = detail.truncated ? this.optional(detail.truncated, FLAG_TYPES, `${at}.truncated`) : undefined;
      return { ...text, ...(presence ? { presence } : {}), ...(truncated ? { truncated } : {}) };
    });
  }

  payload(definition: PayloadDefinition<string> | undefined, at: string): ResolvedPayload | undefined {
    return definition && { ...this.longField(definition.field, at), columns: definition.columns };
  }

  /**
   * An event's payload. Two `entries` names describe resolves to one field (`findField` compares
   * case-insensitively, the parser exactly) collapse to the first, so no element is listed twice.
   */
  eventPayload(definition: EventPayloadDefinition, rolePaths: ReadonlySet<string>): ResolvedEventPayload {
    const { columns } = definition;
    if ('field' in definition) {
      return { kind: 'document', field: this.longField(definition.field, 'event.payload'), columns, rolePaths };
    }
    const seen = new Set<string>();
    const names = definition.entries.filter(name => {
      const lower = name.toLowerCase();
      return seen.has(lower) ? false : seen.add(lower);
    });
    const [first, ...rest] = names.map(name => this.longField(name, `event.payload.entries.${name}`));
    return { kind: 'entries', fields: [first!, ...rest], columns, rolePaths };
  }
}

const pathSource = ({ path }: PathRef): ResolvedPayloadPath => ({ from: 'path', key: path, path });

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
    details: resolver.details(definition.details, 'entry'),
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

/** A record mapping of an object SOQL cannot read. A platform event gets the mapping that fits it. */
function notQueryable(described: ObjectDescribe, mapping: 'transaction' | 'entry'): ResolveFailure {
  const detail = described.name.endsWith('__e')
    ? `is a platform event. Map it under \`event\` instead of \`${mapping}\`.`
    : 'cannot be read with SOQL.';
  return { reason: 'notQueryable', message: `${described.name} ${detail}` };
}

/** An `event` mapping of an object that is not a platform event. A record object gets the mapping that fits it. */
function notAnEvent(described: ObjectDescribe): ResolveFailure {
  const detail = described.queryable
    ? 'is a record object, not a platform event. Map it under `entry` instead of `event`.'
    : 'is not a platform event.';
  return { reason: 'notAnEvent', message: `${described.name} ${detail}` };
}

/**
 * When nothing can read the payload, a path role reads nothing: a required one fails the source,
 * an optional one is dropped and listed as hidden, like a field describe omits.
 */
function dropUnreadablePathRoles(
  roles: ByRole<typeof ENTRY_ROLES, RoleSource>,
  payload: ResolvedEventPayload | undefined,
  hidden: string[]
): ByRole<typeof ENTRY_ROLES, RoleSource> {
  if (payload && readablePayloadFields(payload).length > 0) return roles;
  const kept: Record<string, RoleSource> = {};
  for (const [role, spec] of Object.entries(ENTRY_ROLES)) {
    const source = (roles as Partial<Record<string, RoleSource>>)[role];
    if (!source) continue;
    if (source.from === 'field') kept[role] = source;
    else if (spec.required) {
      throw new Fail({
        reason: 'requiredFieldMissing',
        message: `event.fields.${role} reads the payload path "${source.path}", but every payload field is missing or hidden from this user.`
      });
    } else hidden.push(`event.fields.${role}`);
  }
  return kept as ByRole<typeof ENTRY_ROLES, RoleSource>;
}

/**
 * One `event` mapping against the describe of its object, live or stored. Platform event custom
 * fields cannot be picklists, so the level table falls back to the aliases and the source's `levels`.
 */
function resolveEventObject(
  event: EventDefinition,
  described: ObjectDescribe,
  namespace: string
): { object: ResolvedEventObject; hidden: string[] } {
  if (!described.name.endsWith('__e') || described.queryable) throw new Fail(notAnEvent(described));
  const resolver = new ObjectResolver(described, new Map([[described.name, described]]), namespace, true);
  const mapped = resolver.roles(ENTRY_ROLES, event.fields, 'event');
  const rolePaths = new Set(Object.values(mapped).flatMap(source => (source.from === 'path' ? [source.path] : [])));
  const payload = event.payload && resolver.eventPayload(event.payload, rolePaths);
  const roles = dropUnreadablePathRoles(mapped, payload, resolver.hidden);
  const object: ResolvedEventObject = {
    object: described.name,
    channel: `/event/${described.name}`,
    roles: { ...roles, time: roles.time.from === 'field' ? timeFieldOf(roles.time) : roles.time },
    columns: resolver.columns(event.columns, 'event'),
    details: resolver.details(event.details, 'event'),
    ...(payload ? { payload } : {}),
    ...(event.systemMessagePrefix ? { systemMessagePrefix: event.systemMessagePrefix } : {})
  };
  return { object, hidden: resolver.hidden };
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
 *   (role table, FLAG_TYPES, LONG_TEXT_TYPES) → `unavailable: fieldTypeMismatch`, as is an
 *   `entry.parent` describe reports no relationship name for.
 * - Optional role, column, detail flag hidden → dropped, listed in `hidden`.
 * - Detail or payload text hidden → kept as `{ state: 'hidden' }`, listed in `hidden`.
 * - Relationship path `Rel.Field`: the first hop must be a reference whose `relationshipName`
 *   is `Rel`; the second hop is checked on the referenced object's describe (`describes`). An
 *   `entry.parent` path reads the header through both relationships.
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
  const { shape } = definition;
  switch (shape.kind) {
    case 'transactions':
    case 'entries':
      return resolveRecordSource({ head, definition, shape, origin, namespace, describes });
    case 'events':
      return resolveEventSource({ head, definition, event: shape.event, origin, namespace, describes });
    default:
      return assertNever(shape, 'source shape');
  }
}

type SourceResolution = {
  head: CatalogHead;
  definition: SourceDefinition;
  origin: CustomLogSourceOrigin;
  namespace: string;
  describes: ReadonlyMap<string, ObjectDescribe>;
};

const unavailableEntry = (head: CatalogHead, failure: ResolveFailure): CatalogEntry => ({
  head,
  state: 'unavailable',
  ...failure
});

function resolveRecordSource({
  head,
  definition,
  shape,
  origin,
  namespace,
  describes
}: SourceResolution & { shape: RecordShapeDefinition }): CatalogEntry {
  const objects = recordObjects(shape, namespace);
  const entryDescribe = describes.get(objects.entry);
  const transactionDescribe = objects.transaction ? describes.get(objects.transaction) : undefined;
  if (!entryDescribe || (objects.transaction && !transactionDescribe)) {
    const missing = !entryDescribe ? objects.entry : objects.transaction;
    return unavailableEntry(head, {
      reason: 'objectNotReadable',
      message: `${missing} exists, but describe does not return it for this user.`
    });
  }

  for (const [mapping, described] of [
    ['transaction', transactionDescribe],
    ['entry', entryDescribe]
  ] as const) {
    if (described && !described.queryable) return unavailableEntry(head, notQueryable(described, mapping));
  }

  try {
    const entryResolver = new ObjectResolver(entryDescribe, describes, namespace);
    const entry = resolveEntry(shape.entry, entryResolver);
    let resolvedShape: ResolvedRecordShape;
    let hidden: string[];
    switch (shape.kind) {
      case 'transactions': {
        const parent = entryResolver.parent(shape.entry.parent);
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
        return assertNever(shape, 'record shape');
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
    if (error instanceof Fail) return unavailableEntry(head, error.failure);
    throw error;
  }
}

function resolveEventSource({
  head,
  definition,
  event,
  origin,
  namespace,
  describes
}: SourceResolution & { event: EventDefinition }): CatalogEntry {
  const name = qualifyPath(event.object, namespace);
  const described = describes.get(name);
  if (!described) {
    return unavailableEntry(head, {
      reason: 'objectNotReadable',
      message: `${name} exists, but describe does not return it for this user.`
    });
  }

  try {
    const { object, hidden } = resolveEventObject(event, described, namespace);
    return {
      head,
      state: 'ready',
      source: {
        id: definition.id,
        label: definition.label,
        origin,
        ...(namespace ? { namespace } : {}),
        digest: definition.digest,
        shape: { kind: 'events', event: object },
        levels: buildLevelTable(
          definition.levels,
          picklistValuesOf(described, object.roles.level?.from === 'field' ? object.roles.level : undefined)
        ),
        hidden
      }
    };
  } catch (error) {
    if (error instanceof Fail) return unavailableEntry(head, error.failure);
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
  const described = await Promise.all(
    objectNames(definitionObjects(definition, namespace)).map(
      async name => [name, await reader.describe(name)] as const
    )
  );
  const describes = new Map<string, ObjectDescribe>();
  for (const [name, describe] of described) {
    if (!describe) return describes;
    describes.set(name, describe);
  }

  const { shape } = definition;
  switch (shape.kind) {
    case 'transactions':
    case 'entries':
      await describeRelationshipTargets(shape, namespace, reader, describes);
      return describes;
    case 'events':
      return describes;
    default:
      return assertNever(shape, 'source shape');
  }
}

/** Adds the describe of every object a one-hop path of the mapping reaches. */
async function describeRelationshipTargets(
  shape: RecordShapeDefinition,
  namespace: string,
  reader: SchemaReader,
  describes: Map<string, ObjectDescribe>
): Promise<void> {
  const objects = recordObjects(shape, namespace);
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
      assertNever(shape, 'record shape');
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
}

/** The object a preset's fingerprint is read on: the entry object of a record source, the event of an event source. */
function fingerprintObject(objects: CustomLogSourceObjects): string {
  return 'event' in objects ? objects.event : objects.entry;
}

/** A definition to look for in the org: a project source as written, or a built-in preset in its namespace. */
export type SourceCandidate =
  | { readonly origin: 'config'; readonly definition: SourceDefinition }
  | ({ readonly origin: 'builtin' } & BuiltinPreset);

/** Project sources are written as they are in the org; only a built-in preset is qualified. */
export const namespaceOf = (candidate: SourceCandidate): string =>
  candidate.origin === 'builtin' ? candidate.namespace : '';

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
  const namespace = namespaceOf(candidate);
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
    const found = await reader.existingFields(fingerprintObject(head.objects), fingerprint);
    if (found === 'refused') return refused;
    if (!fingerprint.every(field => found.has(field.toLowerCase()))) {
      const mapped = wanted.some(name => configuredObjects.has(name.toLowerCase()));
      return mapped ? { head, state: 'notInstalled' } : { head, state: 'notInstalled', hint: 'collision' };
    }
  }
  return resolveDefinition(definition, origin, namespace, await describeAll(definition, namespace, reader));
}
