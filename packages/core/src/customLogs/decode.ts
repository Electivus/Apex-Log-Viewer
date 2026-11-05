/**
 * Subject → DTO decoders. A `Subject` is one row as the decoders see it: a plain record read
 * through `ResolvedField.api`, its identity and CreatedDate fallback, and the row's decoded
 * payload. A role reads a field of the record or a path of the payload; `valueOf` is the one
 * place that switches on which. A SOQL record and an event entry with the same mapping decode
 * through one function and produce the same DTO, `CUSTOM_LOG_CELL_CHARS` clipping included.
 */

import { normalizeSoqlDateTimeLiteral } from '../soql.js';
import {
  CUSTOM_LOG_CELL_CHARS,
  CUSTOM_LOG_MESSAGE_PREVIEW_CHARS,
  type CustomLogDetail,
  type CustomLogEntry,
  type CustomLogLevel,
  type CustomLogLongValue,
  type CustomLogRow,
  type CustomLogScalar
} from './contracts.js';
import { normalizeLevel, type LevelTable } from './levels.js';
import { HIDDEN_DOC, docOfText, toLongValue, type PayloadDoc } from './payload.js';
import {
  assertNever,
  type DecodableEntryObject,
  type DecodableRoles,
  type ResolvedField,
  type ResolvedLongField,
  type ResolvedTransactionObject,
  type RoleSource,
  type TimeSource
} from './resolved.js';

/** What a row is called and when it was created, as the record's own source knows them. */
export type RowIdentity = { readonly id: string; readonly createdDate: string };

/** One row to decode: the record, its identity, and its payload doc (undefined when the object maps none). */
export type Subject = {
  readonly record: Readonly<Record<string, unknown>>;
  readonly identity: RowIdentity;
  readonly payload: PayloadDoc | undefined;
};

const NONE: ReadonlySet<string> = new Set();

/** A record's subject: its mapped payload field decoded once, hidden when describe hides it. */
export function recordSubject(
  payload: ResolvedLongField | undefined,
  record: Readonly<Record<string, unknown>>,
  identity: RowIdentity,
  pick: ReadonlySet<string> = NONE
): Subject {
  const doc =
    payload === undefined
      ? undefined
      : payload.state === 'readable'
        ? docOfText(read(record, payload.field.api), pick)
        : HIDDEN_DOC;
  return { record, identity, payload: doc };
}

export function read(record: Readonly<Record<string, unknown>>, api: string): unknown {
  let value: unknown = record;
  for (const part of api.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** The single switch on where a role's value comes from. */
function valueOf(subject: Subject, source: RoleSource | undefined): unknown {
  switch (source?.from) {
    case undefined:
      return undefined;
    case 'field':
      return read(subject.record, source.api);
    case 'path':
      return subject.payload?.picked.get(source.path);
    default:
      return assertNever(source, 'role source');
  }
}

export const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
export const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** A role's text, whole: a non-empty string, or a finite number as its decimal text. */
export function roleText(subject: Subject, source: RoleSource | undefined): string | undefined {
  const value = valueOf(subject, source);
  return text(value) ?? (count(value) === undefined ? undefined : String(value));
}

export function roleNumber(subject: Subject, source: RoleSource | undefined): number | undefined {
  return count(valueOf(subject, source));
}

/** A string bound for a row or entry cell. Long text stays whole only in `entry` and the long values. */
const cell = (value: string | undefined): string | undefined => value?.slice(0, CUSTOM_LOG_CELL_CHARS);
const scalar = (value: unknown): CustomLogScalar =>
  typeof value === 'string'
    ? value.slice(0, CUSTOM_LOG_CELL_CHARS)
    : typeof value === 'number' || typeof value === 'boolean'
      ? value
      : null;

const isEpochMillis = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15;

/**
 * The display time as ISO: the mapped field by its encoding, or a path value by what it is (a
 * finite number is epoch milliseconds, a string a datetime literal), else the row's CreatedDate.
 */
function displayTime(source: TimeSource, subject: Subject): string {
  const value = valueOf(subject, source);
  const mapped =
    source.from === 'path'
      ? isEpochMillis(value)
        ? new Date(value).toISOString()
        : normalizeSoqlDateTimeLiteral(value)
      : source.encoding === 'epochMillis'
        ? isEpochMillis(value)
          ? new Date(value).toISOString()
          : undefined
        : normalizeSoqlDateTimeLiteral(value);
  return mapped ?? subject.identity.createdDate;
}

/**
 * The message, whole. A path message that reads nothing on a parsed doc falls back to the doc's
 * compact JSON, so an element without the mapped key still shows what it holds.
 */
function messageOf(roles: DecodableRoles, subject: Subject): string | undefined {
  const mapped = roleText(subject, roles.message);
  if (mapped !== undefined || roles.message.from !== 'path') return mapped;
  return subject.payload?.compact();
}

export function levelOf(entry: DecodableEntryObject, levels: LevelTable, subject: Subject): CustomLogLevel | undefined {
  const { roles } = entry;
  return normalizeLevel(levels, valueOf(subject, roles.level), valueOf(subject, roles.levelOrdinal)).level;
}

/** Drops `undefined` members, so a DTO carries only the keys it has. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T;
}

/** A long field decoded from the record, or `hidden` when describe hides it from this user. */
function readLong<T>(
  long: ResolvedLongField,
  record: Readonly<Record<string, unknown>>,
  decode: (raw: unknown) => T
): T | { state: 'hidden' } {
  return long.state === 'readable' ? decode(read(record, long.field.api)) : { state: 'hidden' };
}

export function longValueOf(long: ResolvedLongField, record: Readonly<Record<string, unknown>>): CustomLogLongValue {
  return readLong(long, record, toLongValue);
}

function extras(
  columns: readonly ResolvedField[],
  record: Readonly<Record<string, unknown>>
): Record<string, CustomLogScalar> {
  return Object.fromEntries(columns.map(column => [column.key, scalar(read(record, column.api))]));
}

export function entryRow(entry: DecodableEntryObject, levels: LevelTable, subject: Subject): CustomLogRow {
  const { roles } = entry;
  return defined({
    id: subject.identity.id,
    time: displayTime(roles.time, subject),
    title: cell(messageOf(roles, subject)),
    user: cell(roleText(subject, roles.user)),
    level: levelOf(entry, levels, subject),
    transactionId: cell(roleText(subject, roles.transactionId)),
    requestId: cell(roleText(subject, roles.requestId)),
    extra: extras(entry.columns, subject.record),
    payload: subject.payload?.view
  });
}

export function transactionRow(
  transaction: ResolvedTransactionObject,
  levels: LevelTable,
  subject: Subject
): CustomLogRow {
  const { roles } = transaction;
  const counts = defined({
    entries: roleNumber(subject, roles.entryCount),
    errors: roleNumber(subject, roles.errorCount),
    warnings: roleNumber(subject, roles.warningCount)
  });
  const ordinal = valueOf(subject, roles.maxLevelOrdinal);
  return defined({
    id: subject.identity.id,
    time: displayTime(roles.startTime, subject),
    title: cell(roleText(subject, roles.name)),
    user: cell(roleText(subject, roles.user)),
    level: ordinal === undefined ? undefined : normalizeLevel(levels, undefined, ordinal).level,
    counts: Object.keys(counts).length > 0 ? counts : undefined,
    transactionId: cell(roleText(subject, roles.transactionId)),
    requestId: cell(roleText(subject, roles.requestId)),
    extra: extras(transaction.columns, subject.record),
    payload: subject.payload?.view
  });
}

export function entryDto(
  entry: DecodableEntryObject,
  levels: LevelTable,
  subject: Subject,
  position: number,
  clip: boolean
): CustomLogEntry {
  const { roles } = entry;
  const full = messageOf(roles, subject) ?? '';
  const clipped = clip && full.length > CUSTOM_LOG_MESSAGE_PREVIEW_CHARS;
  const { level, rawLevel } = normalizeLevel(
    levels,
    valueOf(subject, roles.level),
    valueOf(subject, roles.levelOrdinal)
  );
  const truncated = valueOf(subject, roles.messageTruncated);
  return defined({
    id: subject.identity.id,
    sequence: roleNumber(subject, roles.order) ?? position,
    time: displayTime(roles.time, subject),
    level,
    rawLevel,
    message: clipped ? full.slice(0, CUSTOM_LOG_MESSAGE_PREVIEW_CHARS) : full,
    previewClipped: clipped,
    messageTruncated: typeof truncated === 'boolean' ? truncated : undefined,
    origin: cell(roleText(subject, roles.origin)),
    user: cell(roleText(subject, roles.user)),
    exceptionType: cell(roleText(subject, roles.exceptionType)),
    recordId: cell(roleText(subject, roles.recordId)),
    system: entry.systemMessagePrefix !== undefined && full.startsWith(entry.systemMessagePrefix),
    presentDetails: entry.details
      .filter(detail => valueOf(subject, detail.presence) === true)
      .map(detail => detail.key),
    extra: extras(entry.columns, subject.record),
    payload: subject.payload?.view
  });
}

/** Every mapped detail with its state and its `truncated` flag, in definition order. */
export function detailsOf(entry: DecodableEntryObject, subject: Subject): CustomLogDetail[] {
  return entry.details.map((detail): CustomLogDetail => {
    const label = detail.state === 'readable' ? detail.field.label : detail.label;
    const flag = valueOf(subject, detail.truncated);
    const truncated = typeof flag === 'boolean' ? { truncated: flag } : {};
    return { key: detail.key, label, ...readLong(detail, subject.record, raw => toLongValue(raw, truncated)) };
  });
}

/** The row's full payload text; `unmapped` when the object maps none. */
export function rawPayloadOf(subject: Subject): CustomLogLongValue {
  return subject.payload?.text() ?? { state: 'unmapped' };
}
