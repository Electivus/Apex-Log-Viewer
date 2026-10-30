/**
 * Query plans: for each operation, the SOQL and the decoder of its records, side by side.
 *
 * A plan's SELECT list and its decoder read the same `ResolvedField.api` paths, so they cannot
 * drift apart. Everything here is pure: `ResolvedSource` + params in, `QueryPlan` out. The
 * golden tests pin the SOQL text for unlocked Nebula, managed Nebula, an FLS-trimmed Nebula
 * and an `entries` source with a payload.
 *
 * Paging is keyset, never OFFSET: new logs arriving at the top do not shift later pages, and a
 * retried request with the same cursor returns the same page boundary. Each page asks for
 * `limit + 1` rows; the extra row only decides `nextCursor`. List pages key on
 * `CreatedDate DESC, Id DESC` because CreatedDate is never null; Nebula's `StartTime__c` is a
 * nillable formula (measured) and stays a display field.
 */

import { AlvError } from '../errors.js';
import { escapeSoqlLiteral, isSalesforceId, normalizeSoqlDateTimeLiteral } from '../soql.js';
import {
  CUSTOM_LOG_CELL_CHARS,
  CUSTOM_LOG_MESSAGE_PREVIEW_CHARS,
  type CustomLogApexLogLink,
  type CustomLogDetail,
  type CustomLogEntry,
  type CustomLogFilter,
  type CustomLogLevel,
  type CustomLogLongValue,
  type CustomLogPayloadField,
  type CustomLogPayloadView,
  type CustomLogRow,
  type CustomLogScalar
} from './contracts.js';
import { APEX_LEVEL_ORDINALS, normalizeLevel, type LevelTable } from './levels.js';
import { decodePayload, selectPayloadPaths, summarizePayloadFields, toLongValue } from './payload.js';
import {
  CREATED_DATE,
  type LevelPredicate,
  type ResolvedEntryObject,
  type ResolvedField,
  type ResolvedPayload,
  type ResolvedSource,
  type ResolvedTimeField
} from './resolve.js';

declare const brand: unique symbol;
/** 15- or 18-char Salesforce id, validated at the facade boundary. */
export type RecordId = string & { readonly [brand]: 'SalesforceRecordId' };

/** SOQL text built only by this module from resolved names and escaped literals. */
export type Soql = string & { readonly [brand]: 'Soql' };

export function parseRecordId(value: string, what: string): RecordId {
  if (isSalesforceId(value)) return value as RecordId;
  throw new AlvError('INVALID_ARGUMENT', `${what} must be a 15 or 18 character Salesforce record id.`);
}

export type QueryPlan<T> = {
  readonly soql: Soql;
  /** API used to run it. ApexLog lives in the Tooling API; custom objects in the data API. */
  readonly api: 'data' | 'tooling';
  /** Hard cap handed to `queryData`; equals the LIMIT. */
  readonly maxRecords: number;
  readonly decode: (records: readonly Record<string, unknown>[]) => T;
};

// ---------------------------------------------------------------------------------------------
// Cursor

/**
 * Opaque to callers: base64url of a versioned JSON payload. Bound to the org, the source id and
 * its mapping digest, the plan kind and a hash of the normalized filter or scope, so a cursor
 * replayed against another org, after a mapping edit, or against another query fails with
 * CUSTOM_LOG_INVALID_CURSOR instead of returning a wrong page. Decoding revalidates every field
 * (version, lengths, id pattern, ISO dates, numbers) before any value reaches SOQL.
 */
export type CursorPayload = {
  v: 1;
  /** Org id from the connection's auth fields. */
  o: string;
  s: string;
  /** `ResolvedSource.digest`. */
  m: string;
  k: 'list' | 'entries';
  /** Hash of the filter as given (list) or of the scope (entries). */
  f: string;
  /** The list window with durations resolved on the first page, so later pages reuse the same instants. */
  w?: { since?: string; until?: string };
  /** Last row's sort value: CreatedDate (list) or the sequence value (entries; null when the mapped order is empty). */
  t: string | number | null;
  id: string;
  /** Entries already returned, so a source with no `order` field keeps counting positions across pages. */
  n?: number;
};

export type CursorBinding = Pick<CursorPayload, 'o' | 's' | 'm' | 'k' | 'f'>;

const MAX_CURSOR_CHARS = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HEX_DIGEST = /^[0-9a-f]{12}$/;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const ORG_ID = /^[a-zA-Z0-9]{15,18}$/;

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function invalidCursor(reason: string): never {
  throw new AlvError(
    'CUSTOM_LOG_INVALID_CURSOR',
    `The cursor does not belong to this request (${reason}). Run the command again without --cursor.`
  );
}

function isoInstant(value: unknown): value is string {
  return typeof value === 'string' && normalizeSoqlDateTimeLiteral(value) === value;
}

/** Throws AlvError('CUSTOM_LOG_INVALID_CURSOR') on malformed tokens or on any binding mismatch. */
export function decodeCursor(token: string, expected: CursorBinding): CursorPayload {
  if (token.length > MAX_CURSOR_CHARS || !BASE64URL.test(token)) invalidCursor('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return invalidCursor('malformed');
  }
  const cursor = parsed as Partial<CursorPayload> | null;
  const window = cursor?.w;
  const wellFormed =
    typeof cursor === 'object' &&
    cursor !== null &&
    cursor.v === 1 &&
    typeof cursor.o === 'string' &&
    ORG_ID.test(cursor.o) &&
    typeof cursor.s === 'string' &&
    SOURCE_ID.test(cursor.s) &&
    typeof cursor.m === 'string' &&
    HEX_DIGEST.test(cursor.m) &&
    (cursor.k === 'list' || cursor.k === 'entries') &&
    typeof cursor.f === 'string' &&
    HEX_DIGEST.test(cursor.f) &&
    (window === undefined ||
      (typeof window === 'object' &&
        window !== null &&
        (window.since === undefined || isoInstant(window.since)) &&
        (window.until === undefined || isoInstant(window.until)))) &&
    (cursor.t === null || (typeof cursor.t === 'number' && Number.isFinite(cursor.t)) || isoInstant(cursor.t)) &&
    typeof cursor.id === 'string' &&
    isSalesforceId(cursor.id) &&
    (cursor.n === undefined || (Number.isInteger(cursor.n) && cursor.n >= 0));
  if (!wellFormed) return invalidCursor('malformed');

  const mismatches: [keyof CursorBinding, string][] = [
    ['o', 'another org'],
    ['s', 'another source'],
    ['m', 'the mapping changed'],
    ['k', 'another kind of page'],
    ['f', 'other filters']
  ];
  for (const [key, reason] of mismatches) if (cursor[key] !== expected[key]) invalidCursor(reason);
  return cursor as CursorPayload;
}

// ---------------------------------------------------------------------------------------------
// SOQL text and record reading

const quote = (value: string): string => `'${escapeSoqlLiteral(value)}'`;

function datetimeLiteral(iso: string): string {
  const normalized = normalizeSoqlDateTimeLiteral(iso);
  if (!normalized) throw new AlvError('INVALID_ARGUMENT', `"${iso}" is not an ISO-8601 instant.`);
  return normalized;
}

const NUMERIC_TYPES: ReadonlySet<string> = new Set(['double', 'int']);

/** A value of the field's own kind, written as a SOQL literal: unquoted datetime, or a number. */
function literalFor(field: ResolvedField, value: string | number): string {
  const numeric = NUMERIC_TYPES.has(field.type);
  if (numeric !== (typeof value === 'number')) invalidCursor('its position does not fit the ordering of this source');
  return typeof value === 'number' ? String(value) : datetimeLiteral(value);
}

function soql(text: string): Soql {
  return text as Soql;
}

function read(record: Record<string, unknown>, api: string): unknown {
  let value: unknown = record;
  for (const part of api.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
/** A string bound for a row or entry cell. Long text stays whole only in `entry` and the long values. */
const cell = (value: unknown): string | undefined => text(value)?.slice(0, CUSTOM_LOG_CELL_CHARS);
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const scalar = (value: unknown): CustomLogScalar =>
  typeof value === 'string'
    ? value.slice(0, CUSTOM_LOG_CELL_CHARS)
    : typeof value === 'number' || typeof value === 'boolean'
      ? value
      : null;

/** The display time as ISO: the mapped field, or the record's CreatedDate when it is empty. */
function displayTime(field: ResolvedTimeField, record: Record<string, unknown>): string {
  const value = read(record, field.api);
  const mapped =
    field.encoding === 'epochMillis'
      ? typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15
        ? new Date(value).toISOString()
        : undefined
      : normalizeSoqlDateTimeLiteral(value);
  return mapped ?? createdDateOf(record);
}

class Select {
  private readonly paths = new Set<string>(['Id', 'CreatedDate']);

  add(...fields: readonly (ResolvedField | undefined)[]): this {
    for (const field of fields) if (field) this.paths.add(field.api);
    return this;
  }

  toString(): string {
    return [...this.paths].join(', ');
  }
}

/** Drops `undefined` members, so a DTO carries only the keys it has. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T;
}

function payloadField(payload: ResolvedPayload | undefined): ResolvedField | undefined {
  return payload?.state === 'readable' ? payload.field : undefined;
}

function payloadView(
  payload: ResolvedPayload | undefined,
  record: Record<string, unknown>
): CustomLogPayloadView | undefined {
  if (!payload) return undefined;
  const raw = payload.state === 'readable' ? read(record, payload.field.api) : undefined;
  return decodePayload(raw, { hidden: payload.state === 'hidden' });
}

function extras(columns: readonly ResolvedField[], record: Record<string, unknown>): Record<string, CustomLogScalar> {
  return Object.fromEntries(columns.map(column => [column.key, scalar(read(record, column.api))]));
}

function valueOf(record: Record<string, unknown>, field: ResolvedField | undefined): unknown {
  return field ? read(record, field.api) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Plans

/** A list filter after the boundary: level checked, durations resolved to ISO instants. */
export type ResolvedListFilter = Omit<CustomLogFilter, 'since' | 'until'> & { since?: string; until?: string };

/** A page and what continues it. `payloadFields` summarizes whole payloads, before `keep` trims them. */
export type Page<T> = {
  items: T[];
  payloadFields: CustomLogPayloadField[];
  next?: Pick<CursorPayload, 't' | 'id' | 'n'>;
};

export type ListPlanParams = {
  limit: number;
  filter: ResolvedListFilter;
  after?: CursorPayload;
  /** `payloadFields` from the params; absent keeps every path. */
  keep?: ReadonlySet<string>;
};

function unsupported(source: ResolvedSource, what: string): never {
  throw new AlvError(
    'CUSTOM_LOG_UNSUPPORTED_FILTER',
    `Log source "${source.id}" has no ${what}, so it cannot be filtered that way.`
  );
}

type OrdinalOrValues = LevelPredicate & { kind: 'ordinal' | 'values' };

function levelCondition(predicate: OrdinalOrValues, table: LevelTable, min: CustomLogLevel): string {
  if (predicate.kind === 'ordinal') return `${predicate.field.api} >= ${APEX_LEVEL_ORDINALS[min]}`;
  const spellings = table.rawAtOrAbove[min];
  return spellings.length > 0 ? `${predicate.field.api} IN (${spellings.map(quote).join(',')})` : 'Id = null';
}

function timeWindow(field: ResolvedTimeField, filter: ResolvedListFilter): string[] {
  const bound = (iso: string) =>
    field.encoding === 'epochMillis' ? String(Date.parse(datetimeLiteral(iso))) : datetimeLiteral(iso);
  return [
    ...(filter.since ? [`${field.api} >= ${bound(filter.since)}`] : []),
    ...(filter.until ? [`${field.api} < ${bound(filter.until)}`] : [])
  ];
}

function where(conditions: readonly string[]): string {
  return conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
}

/**
 * The first `limit` records decoded, their payload summary taken over whole payloads, then trimmed to
 * `keep`; `next` only when the extra record proves another page exists.
 */
function paged<T extends { payload?: CustomLogPayloadView }>(
  records: readonly Record<string, unknown>[],
  limit: number,
  offset: number,
  keep: ReadonlySet<string> | undefined,
  decode: (record: Record<string, unknown>, position: number) => T,
  sortValue: (record: Record<string, unknown>) => string | number | null
): Page<T> {
  const kept = records.slice(0, limit);
  const items = kept.map((record, index) => decode(record, offset + index + 1));
  const last = kept[kept.length - 1];
  return {
    items: keep
      ? items.map(item => (item.payload ? { ...item, payload: selectPayloadPaths(item.payload, keep) } : item))
      : items,
    payloadFields: summarizePayloadFields(items.flatMap(item => item.payload ?? [])),
    ...(records.length > limit && last
      ? { next: { t: sortValue(last), id: String(last.Id), n: offset + kept.length } }
      : {})
  };
}

function createdDateOf(record: Record<string, unknown>): string {
  return normalizeSoqlDateTimeLiteral(record.CreatedDate) ?? new Date(0).toISOString();
}

function entryRow(source: ResolvedSource, record: Record<string, unknown>): CustomLogRow {
  const { entry } = source.shape;
  const message = text(valueOf(record, entry.message));
  return defined({
    id: String(record.Id),
    time: displayTime(entry.time, record),
    title: cell(message),
    user: cell(valueOf(record, entry.roles.user)),
    level: normalizeLevel(source.levels, valueOf(record, entry.roles.level), valueOf(record, entry.roles.levelOrdinal))
      .level,
    transactionId: cell(valueOf(record, entry.roles.transactionId)),
    requestId: cell(valueOf(record, entry.roles.requestId)),
    extra: extras(entry.columns, record),
    payload: payloadView(entry.payload, record)
  });
}

function transactionRow(
  source: ResolvedSource,
  transaction: Extract<ResolvedSource['shape'], { kind: 'transactions' }>['transaction'],
  record: Record<string, unknown>
): CustomLogRow {
  const { roles } = transaction;
  const counts = defined({
    entries: count(valueOf(record, roles.entryCount)),
    errors: count(valueOf(record, roles.errorCount)),
    warnings: count(valueOf(record, roles.warningCount))
  });
  const ordinal = valueOf(record, roles.maxLevelOrdinal);
  return defined({
    id: String(record.Id),
    time: displayTime(transaction.startTime, record),
    title: cell(valueOf(record, roles.name)),
    user: cell(valueOf(record, roles.user)),
    level: ordinal === undefined ? undefined : normalizeLevel(source.levels, undefined, ordinal).level,
    counts: Object.keys(counts).length > 0 ? counts : undefined,
    transactionId: cell(valueOf(record, roles.transactionId)),
    requestId: cell(valueOf(record, roles.requestId)),
    extra: extras(transaction.columns, record),
    payload: payloadView(transaction.payload, record)
  });
}

/** What a list row (or `get`'s header row) reads: the header object, or the entry object of an `entries` source. */
function rowObject(source: ResolvedSource) {
  const { shape } = source;
  if (shape.kind === 'transactions') {
    const { transaction } = shape;
    const { roles } = transaction;
    return {
      object: transaction.object,
      timeFilter: transaction.timeFilter,
      levelPredicate: transaction.levelPredicate,
      user: roles.user,
      select: new Select().add(
        transaction.startTime,
        roles.name,
        roles.user,
        roles.transactionId,
        roles.requestId,
        roles.entryCount,
        roles.errorCount,
        roles.warningCount,
        roles.maxLevelOrdinal,
        ...transaction.columns,
        payloadField(transaction.payload)
      ),
      decode: (record: Record<string, unknown>) => transactionRow(source, transaction, record)
    };
  }
  const { entry } = shape;
  const { roles } = entry;
  return {
    object: entry.object,
    timeFilter: entry.timeFilter,
    levelPredicate: entry.levelPredicate,
    user: roles.user,
    select: new Select().add(
      entry.time,
      entry.message,
      roles.level,
      roles.levelOrdinal,
      roles.user,
      roles.transactionId,
      roles.requestId,
      ...entry.columns,
      payloadField(entry.payload)
    ),
    decode: (record: Record<string, unknown>) => entryRow(source, record)
  };
}

function levelWhere(source: ResolvedSource, predicate: LevelPredicate, min: CustomLogLevel): string {
  if (predicate.kind === 'none') return unsupported(source, 'level mapping');
  if (predicate.kind === 'semiJoin') {
    const { shape } = source;
    if (shape.kind !== 'transactions') return unsupported(source, 'level mapping');
    return `Id IN (SELECT ${shape.entry.parent.api} FROM ${shape.entry.object} WHERE ${levelCondition(predicate.entry, source.levels, min)})`;
  }
  return levelCondition(predicate, source.levels, min);
}

/**
 * `transactions`: header object. `entries`: entry object; `title` is the message preview.
 * Both: `ORDER BY CreatedDate DESC, Id DESC`; `time` is the display time, or CreatedDate when null.
 * SELECT adds the payload field when readable; the decoder runs `decodePayload` per row,
 * `summarizePayloadFields` over the page, then `selectPayloadPaths` with `keep`.
 *
 * Filter → WHERE, by resolved capability:
 * - minLevel → `levelPredicate` (ordinal ≥ n | IN raw spellings | `Id IN (SELECT parent …)`);
 *   `none` throws CUSTOM_LOG_UNSUPPORTED_FILTER.
 * - user → `<user> = '<escaped>'`; no user role → UNSUPPORTED_FILTER.
 * - since/until → on `timeFilter` (the display time when filterable, else CreatedDate), literal per `encoding`.
 * - after → `(CreatedDate < :t OR (CreatedDate = :t AND Id < :id))`.
 */
export function listPlan(source: ResolvedSource, params: ListPlanParams): QueryPlan<Page<CustomLogRow>> {
  const row = rowObject(source);
  const { filter, after, limit } = params;
  const conditions = [
    ...(filter.minLevel ? [levelWhere(source, row.levelPredicate, filter.minLevel)] : []),
    ...(filter.user ? [`${row.user?.api ?? unsupported(source, 'user mapping')} = ${quote(filter.user)}`] : []),
    ...timeWindow(row.timeFilter, filter),
    ...(after ? [beforeCreated(after)] : [])
  ];
  return {
    soql: soql(
      `SELECT ${row.select} FROM ${row.object}${where(conditions)} ORDER BY CreatedDate DESC, Id DESC LIMIT ${limit + 1}`
    ),
    api: 'data',
    maxRecords: limit + 1,
    decode: records => paged(records, limit, after?.n ?? 0, params.keep, record => row.decode(record), createdDateOf)
  };
}

/** `(CreatedDate < :t OR (CreatedDate = :t AND Id < :id))`, the keyset step of a list page. */
function beforeCreated(after: CursorPayload): string {
  if (typeof after.t !== 'string') invalidCursor('its position does not fit the ordering of this list');
  const literal = literalFor(CREATED_DATE, after.t);
  return `(CreatedDate < ${literal} OR (CreatedDate = ${literal} AND Id < ${quote(after.id)}))`;
}

/** One header (`transactions`) or one entry (`entries`) by id, as a `CustomLogRow`, plus the header's full payload when mapped. */
export function rowPlan(
  source: ResolvedSource,
  id: RecordId
): QueryPlan<{ row: CustomLogRow; logPayload?: CustomLogLongValue } | undefined> {
  const row = rowObject(source);
  const payload = source.shape.kind === 'transactions' ? source.shape.transaction.payload : undefined;
  return {
    soql: soql(`SELECT ${row.select} FROM ${row.object} WHERE Id = ${quote(id)} LIMIT 1`),
    api: 'data',
    maxRecords: 1,
    decode: ([record]) =>
      record && {
        row: row.decode(record),
        ...(payload
          ? {
              logPayload: toLongValue(payload.state === 'readable' ? valueOf(record, payload.field) : undefined, {
                hidden: payload.state === 'hidden'
              })
            }
          : {})
      }
  };
}

/**
 * `get --transaction-id`, turned into the record id `get --log-id` takes, so the rest of `get`
 * has one path: the ids of headers whose `transactionId` equals the value (`LIMIT 2`; two ids →
 * CUSTOM_LOG_AMBIGUOUS_TRANSACTION, never a silent pick), or, for an `entries` source, the id of
 * the first entry of that transaction by `sequence`. No filterable `transactionId` role →
 * CUSTOM_LOG_UNSUPPORTED_FILTER. Nebula's `TransactionId__c` is a unique external id.
 */
export function transactionLookupPlan(source: ResolvedSource, transactionId: string): QueryPlan<RecordId[]> {
  const { shape } = source;
  const owner = shape.kind === 'transactions' ? shape.transaction : shape.entry;
  const field = owner.roles.transactionId;
  if (!field?.filterable) return unsupported(source, 'filterable transaction id mapping');
  const [object, order, limit] =
    shape.kind === 'transactions'
      ? [shape.transaction.object, 'CreatedDate DESC, Id DESC', 2]
      : [shape.entry.object, `${shape.entry.sequence.api} ASC NULLS FIRST, Id ASC`, 1];
  return {
    soql: soql(
      `SELECT Id FROM ${object} WHERE ${field.api} = ${quote(transactionId)} ORDER BY ${order} LIMIT ${limit}`
    ),
    api: 'data',
    maxRecords: limit,
    decode: records => records.map(record => parseRecordId(String(record.Id), 'Id'))
  };
}

export type EntriesScope =
  { kind: 'header'; id: RecordId } | { kind: 'transactionKey'; value: string } | { kind: 'single'; id: RecordId };

function scopeCondition(source: ResolvedSource, scope: EntriesScope): string {
  const { shape } = source;
  if (scope.kind === 'single') return `Id = ${quote(scope.id)}`;
  if (scope.kind === 'header') {
    if (shape.kind !== 'transactions') return unsupported(source, 'header object');
    return `${shape.entry.parent.api} = ${quote(scope.id)}`;
  }
  const field = shape.entry.roles.transactionId;
  if (!field?.filterable) return unsupported(source, 'filterable transaction id mapping');
  return `${field.api} = ${quote(scope.value)}`;
}

function sequenceValue(entry: ResolvedEntryObject, record: Record<string, unknown>): string | number | null {
  const value = read(record, entry.sequence.api);
  return NUMERIC_TYPES.has(entry.sequence.type)
    ? (count(value) ?? null)
    : (normalizeSoqlDateTimeLiteral(value) ?? null);
}

/** `(sequence > t OR (sequence = t AND Id > id))`; a null `t` means the page ended inside the rows with no sequence. */
function afterEntry(entry: ResolvedEntryObject, after: CursorPayload): string {
  const field = entry.sequence.api;
  if (after.t === null) return `(${field} != null OR (${field} = null AND Id > ${quote(after.id)}))`;
  const literal = literalFor(entry.sequence, after.t);
  return `(${field} > ${literal} OR (${field} = ${literal} AND Id > ${quote(after.id)}))`;
}

function entryDto(
  source: ResolvedSource,
  record: Record<string, unknown>,
  position: number,
  clip: boolean
): CustomLogEntry {
  const { entry } = source.shape;
  const { roles } = entry;
  const full = text(valueOf(record, entry.message)) ?? '';
  const clipped = clip && full.length > CUSTOM_LOG_MESSAGE_PREVIEW_CHARS;
  const { level, rawLevel } = normalizeLevel(
    source.levels,
    valueOf(record, roles.level),
    valueOf(record, roles.levelOrdinal)
  );
  const truncated = valueOf(record, roles.messageTruncated);
  return defined({
    id: String(record.Id),
    sequence: count(valueOf(record, roles.order)) ?? position,
    time: displayTime(entry.time, record),
    level,
    rawLevel,
    message: clipped ? full.slice(0, CUSTOM_LOG_MESSAGE_PREVIEW_CHARS) : full,
    previewClipped: clipped,
    messageTruncated: typeof truncated === 'boolean' ? truncated : undefined,
    origin: cell(valueOf(record, roles.origin)),
    user: cell(valueOf(record, roles.user)),
    exceptionType: cell(valueOf(record, roles.exceptionType)),
    recordId: cell(valueOf(record, roles.recordId)),
    system: entry.systemMessagePrefix !== undefined && full.startsWith(entry.systemMessagePrefix),
    presentDetails: entry.details.filter(detail => valueOf(record, detail.presence) === true).map(detail => detail.key),
    extra: extras(entry.columns, record),
    payload: payloadView(entry.payload, record)
  });
}

function entrySelect(entry: ResolvedEntryObject): Select {
  const { roles } = entry;
  return new Select().add(
    entry.time,
    entry.message,
    roles.messageTruncated,
    roles.order,
    roles.level,
    roles.levelOrdinal,
    roles.origin,
    roles.user,
    roles.transactionId,
    roles.requestId,
    roles.exceptionType,
    roles.recordId,
    entry.sequence,
    ...entry.columns,
    ...entry.details.map(detail => detail.presence),
    payloadField(entry.payload)
  );
}

/**
 * Entries of one transaction, ascending by `sequence`, then Id.
 * - `transactions`: `WHERE <parent> = :headerId`.
 * - `entries` with `transactionId` and a value: `WHERE <transactionId> = :value`.
 * - `entries` otherwise: `WHERE Id = :entryId` (a transaction of one).
 * SELECT: roles, columns, the message, `messageTruncated`, detail `presence` flags and the
 * payload; never detail text. Messages are cut to CUSTOM_LOG_MESSAGE_PREVIEW_CHARS
 * (`previewClipped`), `system` comes from `systemMessagePrefix`, `presentDetails` from the flags.
 */
export function entriesPlan(
  source: ResolvedSource,
  scope: EntriesScope,
  params: { limit: number; minLevel?: CustomLogLevel; after?: CursorPayload; keep?: ReadonlySet<string> }
): QueryPlan<Page<CustomLogEntry>> {
  const { entry } = source.shape;
  const { limit, after } = params;
  const conditions = [
    scopeCondition(source, scope),
    ...(params.minLevel ? [levelWhere(source, entry.levelPredicate, params.minLevel)] : []),
    ...(after ? [afterEntry(entry, after)] : [])
  ];
  return {
    soql: soql(
      `SELECT ${entrySelect(entry)} FROM ${entry.object}${where(conditions)} ORDER BY ${entry.sequence.api} ASC NULLS FIRST, Id ASC LIMIT ${limit + 1}`
    ),
    api: 'data',
    maxRecords: limit + 1,
    decode: records =>
      paged(
        records,
        limit,
        after?.n ?? 0,
        params.keep,
        (record, position) => entryDto(source, record, position, true),
        record => sequenceValue(entry, record)
      )
  };
}

/**
 * One entry with its full message, every readable detail with its `truncated` flag, and the raw
 * payload. Hidden details and payload become `hidden`; an unmapped payload is `unmapped`. The
 * decoder returns the header id (via `parent`) so `entry` can answer `logId`.
 */
export function entryPlan(
  source: ResolvedSource,
  id: RecordId
): QueryPlan<
  | {
      entry: CustomLogEntry;
      details: CustomLogDetail[];
      rawPayload: CustomLogLongValue;
      logId: string;
    }
  | undefined
> {
  const { shape } = source;
  const { entry } = shape;
  const parent = shape.kind === 'transactions' ? shape.entry.parent : undefined;
  const select = entrySelect(entry).add(
    parent,
    ...entry.details.flatMap(detail => [detail.state === 'readable' ? detail.field : undefined, detail.truncated])
  );
  return {
    soql: soql(`SELECT ${select} FROM ${entry.object} WHERE Id = ${quote(id)} LIMIT 1`),
    api: 'data',
    maxRecords: 1,
    decode: ([record]) => {
      if (!record) return undefined;
      const details = entry.details.map((detail): CustomLogDetail => {
        const label = detail.state === 'readable' ? detail.field.label : detail.label;
        const flag = valueOf(record, detail.truncated);
        return {
          key: detail.key,
          label,
          ...toLongValue(detail.state === 'readable' ? valueOf(record, detail.field) : undefined, {
            hidden: detail.state === 'hidden',
            ...(typeof flag === 'boolean' ? { truncated: flag } : {})
          })
        };
      });
      const rawPayload: CustomLogLongValue = !entry.payload
        ? { state: 'unmapped' }
        : toLongValue(entry.payload.state === 'readable' ? valueOf(record, entry.payload.field) : undefined, {
            hidden: entry.payload.state === 'hidden'
          });
      return defined({
        entry: entryDto(source, record, 1, false),
        details,
        rawPayload,
        logId: parent ? (text(valueOf(record, parent)) ?? '') : String(record.Id)
      });
    }
  };
}

/**
 * Tooling API: `SELECT Id, StartTime, LogLength FROM ApexLog WHERE RequestIdentifier = '<escaped>'
 * ORDER BY StartTime ASC LIMIT 1`. `ApexLog.RequestIdentifier` equals Nebula's
 * `Log__c.RequestId__c`, and the Tooling API accepts this WHERE (both measured).
 */
export function apexLogLinkPlan(requestId: string): QueryPlan<CustomLogApexLogLink> {
  return {
    soql: soql(
      `SELECT Id, StartTime, LogLength FROM ApexLog WHERE RequestIdentifier = ${quote(requestId)} ORDER BY StartTime ASC LIMIT 1`
    ),
    api: 'tooling',
    maxRecords: 1,
    decode: ([record]) =>
      record
        ? defined({
            state: 'linked' as const,
            logId: String(record.Id),
            startTime: normalizeSoqlDateTimeLiteral(record.StartTime),
            logLength: count(record.LogLength)
          })
        : { state: 'notFound' }
  };
}
