/**
 * Record → DTO decoders. They read a plain `Record<string, unknown>` through `ResolvedField.api`
 * and know nothing about where the record came from. Identity and the CreatedDate fallback come
 * in as a `RowIdentity`, so a SOQL record and any other record with the same mapping decode
 * through one function and produce the same DTO, `CUSTOM_LOG_CELL_CHARS` clipping included.
 */

import { normalizeSoqlDateTimeLiteral } from '../soql.js';
import {
  CUSTOM_LOG_CELL_CHARS,
  CUSTOM_LOG_MESSAGE_PREVIEW_CHARS,
  type CustomLogDetail,
  type CustomLogEntry,
  type CustomLogLongValue,
  type CustomLogPayloadView,
  type CustomLogRow,
  type CustomLogScalar
} from './contracts.js';
import { normalizeLevel, type LevelTable } from './levels.js';
import { decodePayload, toLongValue } from './payload.js';
import type {
  DecodableEntryObject,
  ResolvedField,
  ResolvedLongField,
  ResolvedPayload,
  ResolvedTimeField,
  ResolvedTransactionObject
} from './resolved.js';

/** What a row is called and when it was created, as the record's own source knows them. */
export type RowIdentity = { readonly id: string; readonly createdDate: string };

export function read(record: Readonly<Record<string, unknown>>, api: string): unknown {
  let value: unknown = record;
  for (const part of api.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
/** A string bound for a row or entry cell. Long text stays whole only in `entry` and the long values. */
const cell = (value: unknown): string | undefined => text(value)?.slice(0, CUSTOM_LOG_CELL_CHARS);
export const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const scalar = (value: unknown): CustomLogScalar =>
  typeof value === 'string'
    ? value.slice(0, CUSTOM_LOG_CELL_CHARS)
    : typeof value === 'number' || typeof value === 'boolean'
      ? value
      : null;

/** The display time as ISO: the mapped field, or the record's CreatedDate when it is empty. */
function displayTime(field: ResolvedTimeField, record: Readonly<Record<string, unknown>>, createdDate: string): string {
  const value = read(record, field.api);
  const mapped =
    field.encoding === 'epochMillis'
      ? typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15
        ? new Date(value).toISOString()
        : undefined
      : normalizeSoqlDateTimeLiteral(value);
  return mapped ?? createdDate;
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

function payloadView(
  payload: ResolvedPayload | undefined,
  record: Readonly<Record<string, unknown>>
): CustomLogPayloadView | undefined {
  return payload && readLong(payload, record, decodePayload);
}

function extras(
  columns: readonly ResolvedField[],
  record: Readonly<Record<string, unknown>>
): Record<string, CustomLogScalar> {
  return Object.fromEntries(columns.map(column => [column.key, scalar(read(record, column.api))]));
}

function valueOf(record: Readonly<Record<string, unknown>>, field: ResolvedField | undefined): unknown {
  return field ? read(record, field.api) : undefined;
}

export function entryRow(
  entry: DecodableEntryObject,
  levels: LevelTable,
  record: Readonly<Record<string, unknown>>,
  identity: RowIdentity
): CustomLogRow {
  const message = text(valueOf(record, entry.roles.message));
  return defined({
    id: identity.id,
    time: displayTime(entry.roles.time, record, identity.createdDate),
    title: cell(message),
    user: cell(valueOf(record, entry.roles.user)),
    level: normalizeLevel(levels, valueOf(record, entry.roles.level), valueOf(record, entry.roles.levelOrdinal)).level,
    transactionId: cell(valueOf(record, entry.roles.transactionId)),
    requestId: cell(valueOf(record, entry.roles.requestId)),
    extra: extras(entry.columns, record),
    payload: payloadView(entry.payload, record)
  });
}

export function transactionRow(
  transaction: ResolvedTransactionObject,
  levels: LevelTable,
  record: Readonly<Record<string, unknown>>,
  identity: RowIdentity
): CustomLogRow {
  const { roles } = transaction;
  const counts = defined({
    entries: count(valueOf(record, roles.entryCount)),
    errors: count(valueOf(record, roles.errorCount)),
    warnings: count(valueOf(record, roles.warningCount))
  });
  const ordinal = valueOf(record, roles.maxLevelOrdinal);
  return defined({
    id: identity.id,
    time: displayTime(roles.startTime, record, identity.createdDate),
    title: cell(valueOf(record, roles.name)),
    user: cell(valueOf(record, roles.user)),
    level: ordinal === undefined ? undefined : normalizeLevel(levels, undefined, ordinal).level,
    counts: Object.keys(counts).length > 0 ? counts : undefined,
    transactionId: cell(valueOf(record, roles.transactionId)),
    requestId: cell(valueOf(record, roles.requestId)),
    extra: extras(transaction.columns, record),
    payload: payloadView(transaction.payload, record)
  });
}

export function entryDto(
  entry: DecodableEntryObject,
  levels: LevelTable,
  record: Readonly<Record<string, unknown>>,
  identity: RowIdentity,
  position: number,
  clip: boolean
): CustomLogEntry {
  const { roles } = entry;
  const full = text(valueOf(record, roles.message)) ?? '';
  const clipped = clip && full.length > CUSTOM_LOG_MESSAGE_PREVIEW_CHARS;
  const { level, rawLevel } = normalizeLevel(levels, valueOf(record, roles.level), valueOf(record, roles.levelOrdinal));
  const truncated = valueOf(record, roles.messageTruncated);
  return defined({
    id: identity.id,
    sequence: count(valueOf(record, roles.order)) ?? position,
    time: displayTime(roles.time, record, identity.createdDate),
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

/** Every mapped detail with its state and its `truncated` flag, in definition order. */
export function detailsOf(entry: DecodableEntryObject, record: Readonly<Record<string, unknown>>): CustomLogDetail[] {
  return entry.details.map((detail): CustomLogDetail => {
    const label = detail.state === 'readable' ? detail.field.label : detail.label;
    const flag = valueOf(record, detail.truncated);
    const truncated = typeof flag === 'boolean' ? { truncated: flag } : {};
    return { key: detail.key, label, ...readLong(detail, record, raw => toLongValue(raw, truncated)) };
  });
}

/** The entry's full payload text; `unmapped` when the object maps none. */
export function rawPayloadOf(
  entry: DecodableEntryObject,
  record: Readonly<Record<string, unknown>>
): CustomLogLongValue {
  return entry.payload ? longValueOf(entry.payload, record) : { state: 'unmapped' };
}
