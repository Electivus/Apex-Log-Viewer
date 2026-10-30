/**
 * Turning definitions into what this org and this user can actually query.
 *
 * Input: parsed config + built-in presets. Output: a `SourceCatalog` of `CatalogEntry`s, where
 * a `ready` entry carries a `ResolvedSource` whose every field is known to exist, to be
 * readable by the running user, and to have a compatible type. Query builders take only
 * `ResolvedSource`, so a SELECT can only name readable fields (the `LoggerEndUser` FLS gap
 * cannot reach a query) and a filter can only use a capability the source has.
 *
 * Two questions, two mechanisms, no fallback between them:
 * - Is the object there, and is it this framework? `EntityDefinition` for existence and
 *   `FieldDefinition` for the preset fingerprint. Both answer for `LoggerEndUser`, and
 *   `FieldDefinition` ignores FLS (measured on unlocked and managed orgs).
 * - What may this user SELECT? Describe, which omits FLS-hidden fields (measured: 151 of 240).
 * A refused metadata query makes the affected sources `unavailable: metadataQueryRefused`.
 *
 * Shared state: one `SourceRegistry` per core instance. Per username it keeps a `SchemaMemo`
 * (metadata answers, misses included) and the catalogs built from it, keyed by config
 * fingerprint. Pending promises are shared by concurrent callers, like `createOrgConnections`,
 * and a rejected one is evicted. Nothing else caches schema facts.
 */

import type { Connection } from '@salesforce/core';

import { AlvError, awaitWithAbort, throwIfAborted } from '../errors.js';
import { toolingQuery } from '../dataQuery.js';
import { escapeSoqlLiteral } from '../soql.js';
import {
  ENTRY_ROLES,
  FLAG_TYPES,
  LONG_TEXT_TYPES,
  TRANSACTION_ROLES,
  type DescribeFieldType,
  type DetailDefinition,
  type EntryDefinition,
  type EntryRole,
  type FieldPath,
  type ParsedCustomLogsConfig,
  type PayloadDefinition,
  type PayloadPath,
  type SourceDefinition,
  type SourceId,
  type TransactionDefinition,
  type TransactionRole
} from './config.js';
import type {
  CustomLogColumn,
  CustomLogPayloadInfo,
  CustomLogSourceInfo,
  CustomLogSourceOrigin,
  CustomLogSourceShape,
  CustomLogSourceState,
  CustomLogUnavailableReason
} from './contracts.js';
import { buildLevelTable, type LevelTable } from './levels.js';
import { qualifyPath, type BuiltinPreset } from './presets.js';

// ---------------------------------------------------------------------------------------------
// Resolved model (internal; never crosses the package boundary)

/** A field confirmed by describe. `api` is the qualified path to put in SOQL. */
export type ResolvedField = {
  /** As written in the definition, unprefixed. Stable across namespaces; used as DTO key. */
  readonly key: string;
  readonly api: string;
  readonly label: string;
  readonly type: DescribeFieldType;
  readonly sortable: boolean;
  readonly filterable: boolean;
};

/** Time is read as ISO either way; the builder needs to know how to write literals. */
export type ResolvedTimeField = ResolvedField & { readonly encoding: 'datetime' | 'epochMillis' };

/** `CreatedDate`: never null, always sortable and filterable. The list keyset and the time fallback. */
export const CREATED_DATE: ResolvedTimeField = {
  key: 'CreatedDate',
  api: 'CreatedDate',
  label: 'Created Date',
  type: 'datetime',
  sortable: true,
  filterable: true,
  encoding: 'datetime'
};

/** How a minimum-level filter becomes SOQL. Computed once; builders switch on `kind`. */
export type LevelPredicate =
  | { readonly kind: 'ordinal'; readonly field: ResolvedField } // field >= APEX_LEVEL_ORDINALS[min]
  | { readonly kind: 'values'; readonly field: ResolvedField } // field IN table.rawAtOrAbove[min]
  | { readonly kind: 'semiJoin'; readonly entry: LevelPredicate & { kind: 'ordinal' | 'values' } } // header Id IN (SELECT parent FROM entry WHERE …)
  | { readonly kind: 'none' };

/** A mapped long field. Hidden ones stay listed so `entry` can answer `hidden` instead of dropping them. */
export type ResolvedLongField =
  | { readonly state: 'readable'; readonly key: string; readonly field: ResolvedField }
  | { readonly state: 'hidden'; readonly key: string; readonly label: string };

/** A detail with its flags. A flag is kept even when the text is hidden: `LoggerEndUser` reads `HasStackTrace__c`, not `StackTrace__c`. */
export type ResolvedDetail = ResolvedLongField & {
  readonly presence?: ResolvedField;
  readonly truncated?: ResolvedField;
};

export type ResolvedPayload = ResolvedLongField & { readonly columns: readonly PayloadPath[] };

type RoleFields<R extends string> = { readonly [K in R]?: ResolvedField };

export type ResolvedEntryObject = {
  readonly object: string;
  /** 3-char key prefix from describe; routes `get`/`entry` ids to their source. */
  readonly keyPrefix: string;
  /** Display time. */
  readonly time: ResolvedTimeField;
  /** `time` when filterable, else CREATED_DATE. Drives since/until of an `entries` list. */
  readonly timeFilter: ResolvedTimeField;
  /** Order inside a transaction: the first sortable of `order`, `time`, CREATED_DATE; ties by Id. */
  readonly sequence: ResolvedField;
  readonly message: ResolvedField;
  readonly roles: RoleFields<Exclude<EntryRole, 'time' | 'message'>>;
  readonly columns: readonly ResolvedField[];
  readonly details: readonly ResolvedDetail[];
  readonly payload?: ResolvedPayload;
  readonly levelPredicate: LevelPredicate;
  readonly systemMessagePrefix?: string;
};

export type ResolvedTransactionObject = {
  readonly object: string;
  readonly keyPrefix: string;
  /** Display time. Nebula's `StartTime__c` is a nillable formula (measured), so rows fall back to CreatedDate. */
  readonly startTime: ResolvedTimeField;
  /** `startTime` when filterable, else CREATED_DATE. */
  readonly timeFilter: ResolvedTimeField;
  readonly roles: RoleFields<Exclude<TransactionRole, 'startTime'>>;
  readonly columns: readonly ResolvedField[];
  readonly payload?: ResolvedPayload;
  readonly levelPredicate: LevelPredicate;
};

export type ResolvedShape =
  | { readonly kind: 'entries'; readonly entry: ResolvedEntryObject }
  | {
      readonly kind: 'transactions';
      readonly transaction: ResolvedTransactionObject;
      readonly entry: ResolvedEntryObject & { readonly parent: ResolvedField };
    };

export type ResolvedSource = {
  readonly id: SourceId;
  readonly label: string;
  readonly origin: CustomLogSourceOrigin;
  readonly namespace?: string;
  /** `SourceDefinition.digest`. Cursors carry it. */
  readonly digest: string;
  readonly shape: ResolvedShape;
  readonly levels: LevelTable;
  /** Definition paths dropped because describe omits them (FLS or absent). */
  readonly hidden: readonly string[];
};

/** What `sources` can say about a source that is not ready: which objects it looked for, and in what shape. */
type CatalogHead = {
  readonly id: SourceId;
  readonly label: string;
  readonly origin: CustomLogSourceOrigin;
  readonly shape: CustomLogSourceShape;
  readonly namespace?: string;
  readonly objects: { readonly transaction?: string; readonly entry: string };
};

export type CatalogEntry =
  | { readonly state: 'ready'; readonly source: ResolvedSource }
  | (CatalogHead & {
      readonly state: 'notInstalled' | 'unavailable';
      readonly detail: Exclude<CustomLogSourceState, { state: 'ready' }>;
    });

export type SourceCatalog = {
  readonly username: string;
  /** Config sources in file order, then the built-ins they do not replace. Order decides key-prefix ties. */
  readonly entries: readonly CatalogEntry[];
};

// ---------------------------------------------------------------------------------------------
// Catalog queries (pure)

function readyEntries(catalog: SourceCatalog): ResolvedSource[] {
  return catalog.entries.flatMap(entry => (entry.state === 'ready' ? [entry.source] : []));
}

function describeUnavailable(entry: Exclude<CatalogEntry, { state: 'ready' }>): string {
  const { detail } = entry;
  if (detail.state === 'unavailable') return `${detail.reason}: ${detail.message}`;
  return detail.state === 'notInstalled' && detail.hint === 'collision'
    ? 'not installed (a Log__c exists that is not Nebula Logger)'
    : 'not installed';
}

function findEntry(catalog: SourceCatalog, sourceId: string): CatalogEntry {
  const entry = catalog.entries.find(item => (item.state === 'ready' ? item.source.id : item.id) === sourceId);
  if (!entry) {
    const known = catalog.entries.map(item => (item.state === 'ready' ? item.source.id : item.id)).join(', ');
    throw new AlvError(
      'CUSTOM_LOG_SOURCE_NOT_FOUND',
      `Unknown log source "${sourceId}". Known sources: ${known || 'none'}.`
    );
  }
  return entry;
}

/**
 * Explicit id → that source (SOURCE_NOT_FOUND / SOURCE_UNAVAILABLE). None → the only ready source;
 * several ready → SOURCE_REQUIRED with their ids; none ready → NO_SOURCE. Never "first wins", so a
 * script that omits `--source` cannot start reading another source when the project adds one.
 */
export function requireSource(catalog: SourceCatalog, sourceId: string | undefined): ResolvedSource {
  if (sourceId !== undefined) {
    const entry = findEntry(catalog, sourceId);
    if (entry.state === 'ready') return entry.source;
    throw new AlvError(
      'CUSTOM_LOG_SOURCE_UNAVAILABLE',
      `Log source "${sourceId}" is not available: ${describeUnavailable(entry)}.`
    );
  }
  const ready = readyEntries(catalog);
  if (ready.length === 1) return ready[0]!;
  if (ready.length === 0) {
    throw new AlvError(
      'CUSTOM_LOG_NO_SOURCE',
      'No log source is ready in this org. Run "sf electivus custom-log sources" to see why.'
    );
  }
  throw new AlvError(
    'CUSTOM_LOG_SOURCE_REQUIRED',
    `Several log sources are ready (${ready.map(source => source.id).join(', ')}). Pass one with --source.`
  );
}

function prefixOf(recordId: string): string {
  return recordId.slice(0, 3);
}

function levelOwning(source: ResolvedSource, prefix: string): 'transaction' | 'entry' | undefined {
  if (source.shape.kind === 'transactions' && source.shape.transaction.keyPrefix === prefix) return 'transaction';
  return source.shape.entry.keyPrefix === prefix ? 'entry' : undefined;
}

/**
 * Route a record id to the source that owns it: explicit id must own the prefix; otherwise
 * first ready source in catalog order whose transaction or entry key prefix matches.
 */
export function requireSourceForRecord(
  catalog: SourceCatalog,
  sourceId: string | undefined,
  recordId: string
): { source: ResolvedSource; level: 'transaction' | 'entry' } {
  const prefix = prefixOf(recordId);
  const candidates = sourceId === undefined ? readyEntries(catalog) : [requireSource(catalog, sourceId)];
  for (const source of candidates) {
    const level = levelOwning(source, prefix);
    if (level) return { source, level };
  }
  throw new AlvError(
    'CUSTOM_LOG_SOURCE_NOT_FOUND',
    sourceId === undefined
      ? `No ready log source owns record id ${recordId}.`
      : `Record id ${recordId} does not belong to log source "${sourceId}".`
  );
}

/** `defaultSourceId` of the `sources` result: the ready source `requireSource(catalog, undefined)` would pick. */
export function defaultSourceId(catalog: SourceCatalog): string | undefined {
  const ready = readyEntries(catalog);
  return ready.length === 1 ? ready[0]!.id : undefined;
}

function payloadInfo(payload: ResolvedPayload | undefined): CustomLogPayloadInfo | undefined {
  return payload?.state === 'readable' ? { field: payload.field.api, columns: [...payload.columns] } : undefined;
}

export function toSourceInfo(entry: CatalogEntry): CustomLogSourceInfo {
  if (entry.state !== 'ready') {
    return {
      id: entry.id,
      label: entry.label,
      origin: entry.origin,
      shape: entry.shape,
      ...(entry.namespace ? { namespace: entry.namespace } : {}),
      objects: { ...entry.objects },
      hiddenFields: [],
      unmappedLevels: [],
      capabilities: { levelFilter: false, userFilter: false, apexLogLink: false },
      payload: {},
      ...entry.detail
    };
  }
  const { source } = entry;
  const { shape } = source;
  const listed = shape.kind === 'transactions' ? shape.transaction : shape.entry;
  const payload = {
    ...(shape.kind === 'transactions' && payloadInfo(shape.transaction.payload)
      ? { transaction: payloadInfo(shape.transaction.payload) }
      : {}),
    ...(payloadInfo(shape.entry.payload) ? { entry: payloadInfo(shape.entry.payload) } : {})
  };
  return {
    id: source.id,
    label: source.label,
    origin: source.origin,
    shape: shape.kind,
    ...(source.namespace ? { namespace: source.namespace } : {}),
    objects: {
      ...(shape.kind === 'transactions' ? { transaction: shape.transaction.object } : {}),
      entry: shape.entry.object
    },
    hiddenFields: [...source.hidden],
    unmappedLevels: [...source.levels.unmapped],
    capabilities: {
      levelFilter: listed.levelPredicate.kind !== 'none',
      userFilter: listed.roles.user !== undefined,
      apexLogLink: listed.roles.requestId !== undefined
    },
    payload,
    state: 'ready'
  };
}

export function toColumns(fields: readonly ResolvedField[]): CustomLogColumn[] {
  return fields.map(field => ({ key: field.key, label: field.label }));
}

// ---------------------------------------------------------------------------------------------
// Schema reads (I/O behind a seam so the pure part is testable with fixtures)

/** The subset of describe this module reads. Parsed from jsforce's DescribeSObjectResult. */
export type ObjectDescribe = {
  name: string;
  keyPrefix: string;
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
  existingObjects(names: readonly string[], signal?: AbortSignal): Promise<ReadonlySet<string> | 'refused'>;
  /** FieldDefinition lookup on one object, FLS-independent: the lower-cased names that exist. `refused` as above. */
  existingFields(
    object: string,
    names: readonly string[],
    signal?: AbortSignal
  ): Promise<ReadonlySet<string> | 'refused'>;
  /** `undefined` when describe answers NOT_FOUND. */
  describe(object: string, signal?: AbortSignal): Promise<ObjectDescribe | undefined>;
};

const REFUSED_CODES: ReadonlySet<string> = new Set([
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'API_DISABLED_FOR_ORG',
  'API_CURRENTLY_DISABLED',
  'FORBIDDEN'
]);
const MISSING_OBJECT_CODES: ReadonlySet<string> = new Set(['NOT_FOUND', 'INVALID_TYPE']);

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { errorCode?: unknown } | undefined)?.errorCode;
  return typeof code === 'string' ? code : undefined;
}

function inList(names: readonly string[]): string {
  return names.map(name => `'${escapeSoqlLiteral(name)}'`).join(',');
}

async function metadataNames(
  connection: Connection,
  soql: string,
  signal: AbortSignal | undefined
): Promise<ReadonlySet<string> | 'refused'> {
  try {
    const result = await toolingQuery<{ QualifiedApiName?: string }>(connection, soql, signal);
    return new Set(
      (result.records ?? []).flatMap(record => (record.QualifiedApiName ? [record.QualifiedApiName.toLowerCase()] : []))
    );
  } catch (error) {
    const code = errorCodeOf(error);
    if (code && REFUSED_CODES.has(code)) return 'refused';
    throw error;
  }
}

export function createSchemaReader(connection: Connection): SchemaReader {
  return {
    existingObjects: (names, signal) =>
      metadataNames(
        connection,
        `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN (${inList(names)})`,
        signal
      ),
    existingFields: (object, names, signal) =>
      metadataNames(
        connection,
        `SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${escapeSoqlLiteral(object)}' AND QualifiedApiName IN (${inList(names)})`,
        signal
      ),
    async describe(object, signal) {
      try {
        const described = await awaitWithAbort(connection.describe(object), signal);
        return {
          name: described.name,
          keyPrefix: described.keyPrefix ?? '',
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
  const wanted = [...new Set(names.map(name => name.toLowerCase()))];
  const missing = wanted.filter(name => !known.has(keyOf(name)));
  if (missing.length > 0) {
    const batch = fetch(missing);
    for (const name of missing) {
      const answer = batch.then(result => (result === 'refused' ? 'refused' : result.has(name)));
      known.set(keyOf(name), answer);
      answer.catch(() => {
        if (known.get(keyOf(name)) === answer) known.delete(keyOf(name));
      });
    }
  }
  const answers = await Promise.all(wanted.map(async name => [name, await known.get(keyOf(name))!] as const));
  if (answers.some(([, answer]) => answer === 'refused')) return 'refused';
  return new Set(answers.flatMap(([name, answer]) => (answer ? [name] : [])));
}

/** A `SchemaReader` that answers from `memo` and records each new answer there. Batches the names it lacks. */
export function memoizedSchemaReader(reader: SchemaReader, memo: SchemaMemo): SchemaReader {
  return {
    existingObjects: (names, signal) =>
      memoizedExistence(
        memo.objects,
        names,
        name => name,
        missing => reader.existingObjects(missing, signal)
      ),
    existingFields: (object, names, signal) =>
      memoizedExistence(
        memo.fields,
        names,
        name => `${object.toLowerCase()}.${name}`,
        missing => reader.existingFields(object, missing, signal)
      ),
    describe(object, signal) {
      const key = object.toLowerCase();
      let pending = memo.describes.get(key);
      if (!pending) {
        pending = reader.describe(object, signal);
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

// ---------------------------------------------------------------------------------------------
// Resolution

type DescribedField = ObjectDescribe['fields'][number];

const fieldIndexes = new WeakMap<ObjectDescribe, Map<string, DescribedField>>();

function findField(describe: ObjectDescribe, name: string): DescribedField | undefined {
  let index = fieldIndexes.get(describe);
  if (!index) {
    index = new Map(describe.fields.map(field => [field.name.toLowerCase(), field]));
    fieldIndexes.set(describe, index);
  }
  return index.get(name.toLowerCase());
}

/** The object names a definition reads, qualified for `namespace`: header, entry, never relationship targets. */
export function definitionObjects(
  definition: SourceDefinition,
  namespace: string
): { transaction?: string; entry: string } {
  const { shape } = definition;
  return {
    ...(shape.kind === 'transactions' ? { transaction: qualifyPath(shape.transaction.object, namespace) } : {}),
    entry: qualifyPath(shape.entry.object, namespace)
  };
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
      const reference = this.describe.fields.find(
        item => item.type === 'reference' && item.relationshipName?.toLowerCase() === first!.toLowerCase()
      );
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

  /** An optional field: hidden ones are dropped and reported at `at`. */
  optional(path: string, types: readonly string[] | undefined, what: string, at: string): ResolvedField | undefined {
    const field = this.field(path, types, what);
    if (!field) this.hidden.push(at);
    return field;
  }

  roles(
    roles: Record<string, { required: boolean; types: readonly string[] }>,
    fields: Record<string, FieldPath | undefined>,
    at: string,
    skip: readonly string[]
  ): Record<string, ResolvedField> {
    const resolved: Record<string, ResolvedField> = {};
    for (const [role, spec] of Object.entries(roles)) {
      const path = fields[role];
      if (path === undefined || skip.includes(role)) continue;
      const field = this.optional(path, spec.types, `${at}.fields.${role}`, `${at}.fields.${role}`);
      if (field) resolved[role] = field;
    }
    return resolved;
  }

  columns(paths: readonly FieldPath[], at: string): ResolvedField[] {
    return paths.flatMap(path => {
      const field = this.optional(path, undefined, `${at}.columns.${path}`, `${at}.columns.${path}`);
      return field ? [field] : [];
    });
  }

  longField(path: FieldPath, at: string): ResolvedLongField {
    const field = this.optional(path, LONG_TEXT_TYPES, at, at);
    return field
      ? { state: 'readable', key: path, field }
      : { state: 'hidden', key: path, label: humanizeApiName(path) };
  }

  details(details: readonly DetailDefinition[]): ResolvedDetail[] {
    return details.map(detail => {
      const at = `entry.details.${detail.field}`;
      const text = this.longField(detail.field, at);
      const presence = detail.presence
        ? this.optional(detail.presence, FLAG_TYPES, `${at}.presence`, `${at}.presence`)
        : undefined;
      const truncated = detail.truncated
        ? this.optional(detail.truncated, FLAG_TYPES, `${at}.truncated`, `${at}.truncated`)
        : undefined;
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

function usableForFilter(field: ResolvedField | undefined): field is ResolvedField {
  return field !== undefined && field.filterable;
}

function predicateOf(ordinal: ResolvedField | undefined, level: ResolvedField | undefined): LevelPredicate {
  if (usableForFilter(ordinal)) return { kind: 'ordinal', field: ordinal };
  if (usableForFilter(level)) return { kind: 'values', field: level };
  return { kind: 'none' };
}

function picklistValuesOf(describe: ObjectDescribe, field: ResolvedField | undefined): string[] | undefined {
  if (field?.type !== 'picklist') return undefined;
  return findField(describe, field.api)?.picklistValues.map(item => item.value);
}

function resolveEntry(
  definition: EntryDefinition,
  resolver: ObjectResolver,
  parent: FieldPath | undefined
): { entry: ResolvedEntryObject; parent?: ResolvedField } {
  const fields = definition.fields as Record<string, FieldPath | undefined>;
  const time = timeFieldOf(resolver.required(fields.time!, ENTRY_ROLES.time.types, 'entry.fields.time'));
  const message = resolver.required(fields.message!, ENTRY_ROLES.message.types, 'entry.fields.message');
  const parentField = parent && resolver.required(parent, ['reference'], 'entry.parent');
  const roles = resolver.roles(ENTRY_ROLES, fields, 'entry', ['time', 'message']) as ResolvedEntryObject['roles'];
  const order = roles.order;
  return {
    entry: {
      object: resolver.object,
      keyPrefix: resolver.keyPrefix,
      time,
      timeFilter: time.filterable ? time : CREATED_DATE,
      sequence: [order, time, CREATED_DATE].find(field => field?.sortable) ?? CREATED_DATE,
      message,
      roles,
      columns: resolver.columns(definition.columns, 'entry'),
      details: resolver.details(definition.details),
      ...(definition.payload ? { payload: resolver.payload(definition.payload, 'entry.payload') } : {}),
      levelPredicate: predicateOf(roles.levelOrdinal, roles.level),
      ...(definition.systemMessagePrefix ? { systemMessagePrefix: definition.systemMessagePrefix } : {})
    },
    ...(parentField ? { parent: parentField } : {})
  };
}

function resolveTransaction(
  definition: TransactionDefinition,
  resolver: ObjectResolver,
  entryPredicate: LevelPredicate
): ResolvedTransactionObject {
  const fields = definition.fields as Record<string, FieldPath | undefined>;
  const startTime = timeFieldOf(
    resolver.required(fields.startTime!, TRANSACTION_ROLES.startTime.types, 'transaction.fields.startTime')
  );
  const roles = resolver.roles(TRANSACTION_ROLES, fields, 'transaction', [
    'startTime'
  ]) as ResolvedTransactionObject['roles'];
  const own = predicateOf(roles.maxLevelOrdinal, undefined);
  return {
    object: resolver.object,
    keyPrefix: resolver.keyPrefix,
    startTime,
    timeFilter: startTime.filterable ? startTime : CREATED_DATE,
    roles,
    columns: resolver.columns(definition.columns, 'transaction'),
    ...(definition.payload ? { payload: resolver.payload(definition.payload, 'transaction.payload') } : {}),
    levelPredicate:
      own.kind !== 'none'
        ? own
        : entryPredicate.kind === 'ordinal' || entryPredicate.kind === 'values'
          ? { kind: 'semiJoin', entry: entryPredicate }
          : { kind: 'none' }
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
  const unavailable = (failure: ResolveFailure): CatalogEntry => ({
    ...head,
    state: 'unavailable',
    detail: { state: 'unavailable', reason: failure.reason, message: failure.message }
  });
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
    const resolvedEntry = resolveEntry(
      shape.entry,
      entryResolver,
      shape.kind === 'transactions' ? shape.entry.parent : undefined
    );
    let resolvedShape: ResolvedShape;
    let hidden: string[];
    if (shape.kind === 'transactions') {
      const transactionResolver = new ObjectResolver(transactionDescribe!, describes, namespace);
      const transaction = resolveTransaction(
        shape.transaction,
        transactionResolver,
        resolvedEntry.entry.levelPredicate
      );
      resolvedShape = {
        kind: 'transactions',
        transaction,
        entry: { ...resolvedEntry.entry, parent: resolvedEntry.parent! }
      };
      hidden = [...transactionResolver.hidden, ...entryResolver.hidden];
    } else {
      resolvedShape = { kind: 'entries', entry: resolvedEntry.entry };
      hidden = entryResolver.hidden;
    }
    return {
      state: 'ready',
      source: {
        id: definition.id,
        label: definition.label,
        origin,
        ...(namespace ? { namespace } : {}),
        digest: definition.digest,
        shape: resolvedShape,
        levels: buildLevelTable(definition.levels, picklistValuesOf(entryDescribe, resolvedEntry.entry.roles.level)),
        hidden
      }
    };
  } catch (error) {
    if (error instanceof Fail) return unavailable(error.failure);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Detection and the registry

/** Describe the definition's objects, then the one-hop relationship targets its paths name. Undefined: an object describe refuses. */
async function describeAll(
  definition: SourceDefinition,
  namespace: string,
  reader: SchemaReader,
  signal: AbortSignal | undefined
): Promise<{ describes: Map<string, ObjectDescribe> } | { unreadable: string }> {
  const objects = definitionObjects(definition, namespace);
  const names = [objects.entry, ...(objects.transaction ? [objects.transaction] : [])];
  const described = await Promise.all(names.map(async name => [name, await reader.describe(name, signal)] as const));
  const describes = new Map<string, ObjectDescribe>();
  for (const [name, describe] of described) {
    if (!describe) return { unreadable: name };
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
  if (shape.kind === 'transactions') {
    addPaths(objects.transaction!, [
      ...roleFields(shape.transaction.fields),
      ...shape.transaction.columns,
      ...(shape.transaction.payload ? [shape.transaction.payload.field] : [])
    ]);
  }
  const targets = new Set<string>();
  for (const [describe, path] of paths) {
    const [relationship, field] = qualifyPath(path, namespace).split('.');
    if (field === undefined) continue;
    const reference = describe.fields.find(
      item => item.type === 'reference' && item.relationshipName?.toLowerCase() === relationship!.toLowerCase()
    );
    reference?.referenceTo.forEach(target => targets.add(target));
  }
  await Promise.all(
    [...targets].map(async target => {
      const describe = await reader.describe(target, signal);
      if (describe) describes.set(target, describe);
    })
  );
  return { describes };
}

/** `notInstalled` and `metadataQueryRefused` answers share the definition's head. */
function absent(head: CatalogHead, detail: Exclude<CustomLogSourceState, { state: 'ready' }>): CatalogEntry {
  return { ...head, state: detail.state, detail };
}

/**
 * Detect a built-in preset in its one namespace: qualify the definition, check object existence
 * (EntityDefinition) and the fingerprint (FieldDefinition), then describe and `resolveDefinition`.
 *
 * Outcomes:
 * - no object → `notInstalled`
 * - objects exist, fingerprint fails → `notInstalled` with `hint: 'collision'`, unless a config
 *   source already maps that object (then the hint is noise and is omitted)
 * - objects exist, describe NOT_FOUND → `unavailable: objectNotReadable`
 * - EntityDefinition or FieldDefinition `refused` → `unavailable: metadataQueryRefused`
 */
export async function detectPreset(
  preset: BuiltinPreset,
  reader: SchemaReader,
  configuredObjects: ReadonlySet<string>,
  signal?: AbortSignal
): Promise<CatalogEntry> {
  const { definition, namespace } = preset;
  const head = headOf(definition, 'builtin', namespace);
  const refused = absent(head, {
    state: 'unavailable',
    reason: 'metadataQueryRefused',
    message: 'This user cannot query EntityDefinition or FieldDefinition, so the object cannot be detected.'
  });

  const wanted = [head.objects.entry, ...(head.objects.transaction ? [head.objects.transaction] : [])];
  const existing = await reader.existingObjects(wanted, signal);
  if (existing === 'refused') return refused;
  if (!wanted.every(name => existing.has(name.toLowerCase()))) return absent(head, { state: 'notInstalled' });

  const fingerprint = await reader.existingFields(
    head.objects.entry,
    preset.fingerprint.fields.map(field => qualifyPath(field, namespace)),
    signal
  );
  if (fingerprint === 'refused') return refused;
  if (!preset.fingerprint.fields.every(field => fingerprint.has(qualifyPath(field, namespace).toLowerCase()))) {
    const mapped = wanted.some(name => configuredObjects.has(name.toLowerCase()));
    return absent(head, mapped ? { state: 'notInstalled' } : { state: 'notInstalled', hint: 'collision' });
  }

  const described = await describeAll(definition, namespace, reader, signal);
  if ('unreadable' in described) {
    return absent(head, {
      state: 'unavailable',
      reason: 'objectNotReadable',
      message: `${described.unreadable} exists, but describe does not return it for this user.`
    });
  }
  return resolveDefinition(definition, 'builtin', namespace, described.describes);
}

async function resolveConfigSource(
  definition: SourceDefinition,
  reader: SchemaReader,
  signal: AbortSignal | undefined
): Promise<CatalogEntry> {
  const head = headOf(definition, 'config', '');
  const wanted = [head.objects.entry, ...(head.objects.transaction ? [head.objects.transaction] : [])];
  const existing = await reader.existingObjects(wanted, signal);
  if (existing === 'refused') {
    return absent(head, {
      state: 'unavailable',
      reason: 'metadataQueryRefused',
      message: 'This user cannot query EntityDefinition, so the mapped objects cannot be checked.'
    });
  }
  const missing = wanted.find(name => !existing.has(name.toLowerCase()));
  if (missing) {
    return absent(head, {
      state: 'unavailable',
      reason: 'objectNotFound',
      message: `${missing} does not exist in this org.`
    });
  }
  const described = await describeAll(definition, '', reader, signal);
  if ('unreadable' in described) {
    return absent(head, {
      state: 'unavailable',
      reason: 'objectNotReadable',
      message: `${described.unreadable} exists, but describe does not return it for this user.`
    });
  }
  return resolveDefinition(definition, 'config', '', described.describes);
}

export type RegistryContext = { connection: Connection; username: string };

export type SourceRegistry = {
  /**
   * The catalog for this org and config: per username, the `SchemaMemo` plus catalogs keyed by
   * `config.fingerprint`, shared by concurrent callers, evicted on rejection. `refresh` drops the
   * username's memo and catalogs first.
   */
  catalog(
    ctx: RegistryContext,
    config: ParsedCustomLogsConfig,
    options: { refresh?: boolean; signal?: AbortSignal }
  ): Promise<SourceCatalog>;
  /**
   * Run a query against a resolved source. If Salesforce rejects it with INVALID_FIELD or
   * INVALID_TYPE (schema or FLS changed since resolution), drop the username's memo and catalogs,
   * re-resolve once and retry. Converges instead of serving a stale catalog until restart.
   */
  withSource<T>(
    ctx: RegistryContext,
    config: ParsedCustomLogsConfig,
    pick: (catalog: SourceCatalog) => ResolvedSource,
    run: (source: ResolvedSource) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;
  clear(): void;
};

type OrgState = { memo: SchemaMemo; catalogs: Map<string, Promise<SourceCatalog>> };

const MAX_CATALOGS_PER_ORG = 8;
const DRIFT_CODES: ReadonlySet<string> = new Set(['INVALID_FIELD', 'INVALID_TYPE']);

export function createSourceRegistry(presets: readonly BuiltinPreset[]): SourceRegistry {
  const orgs = new Map<string, OrgState>();

  const build = async (
    ctx: RegistryContext,
    config: ParsedCustomLogsConfig,
    memo: SchemaMemo
  ): Promise<SourceCatalog> => {
    const reader = memoizedSchemaReader(createSchemaReader(ctx.connection), memo);
    const replaced = new Set<string>(config.sources.map(source => source.id));
    const kept = presets.filter(preset => !replaced.has(preset.definition.id));
    const configured = new Set(config.sources.map(source => definitionObjects(source, '').entry.toLowerCase()));
    for (const source of config.sources) {
      const { transaction } = definitionObjects(source, '');
      if (transaction) configured.add(transaction.toLowerCase());
    }

    const everyObject = [
      ...config.sources.flatMap(source => Object.values(definitionObjects(source, ''))),
      ...kept.flatMap(preset => Object.values(definitionObjects(preset.definition, preset.namespace)))
    ];
    await reader.existingObjects(everyObject);

    const entries = await Promise.all([
      ...config.sources.map(source => resolveConfigSource(source, reader, undefined)),
      ...kept.map(preset => detectPreset(preset, reader, configured, undefined))
    ]);
    return { username: ctx.username, entries };
  };

  const stateOf = (username: string): OrgState => {
    let state = orgs.get(username);
    if (!state) {
      state = { memo: createSchemaMemo(), catalogs: new Map() };
      orgs.set(username, state);
    }
    return state;
  };

  const catalog: SourceRegistry['catalog'] = async (ctx, config, options) => {
    throwIfAborted(options.signal);
    if (options.refresh) orgs.delete(ctx.username);
    const state = stateOf(ctx.username);
    let pending = state.catalogs.get(config.fingerprint);
    if (!pending) {
      pending = build(ctx, config, state.memo);
      state.catalogs.set(config.fingerprint, pending);
      const own = pending;
      own.catch(() => {
        if (state.catalogs.get(config.fingerprint) === own) state.catalogs.delete(config.fingerprint);
      });
      while (state.catalogs.size > MAX_CATALOGS_PER_ORG) state.catalogs.delete(state.catalogs.keys().next().value!);
    }
    return awaitWithAbort(pending, options.signal);
  };

  return {
    catalog,
    async withSource(ctx, config, pick, run, signal) {
      const attempt = async () => run(pick(await catalog(ctx, config, { signal })));
      try {
        return await attempt();
      } catch (error) {
        const code = errorCodeOf(error);
        if (!code || !DRIFT_CODES.has(code)) throw error;
        orgs.delete(ctx.username);
        return attempt();
      }
    },
    clear: () => orgs.clear()
  };
}
