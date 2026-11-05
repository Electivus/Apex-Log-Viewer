/**
 * Event identity and position, the one place that knows their encodings.
 *
 * - `EventUuid` is the identity (Salesforce: dedupe on EventUuid, never on ReplayId). It is parsed
 *   once at the wire boundary and at the store boundary, and carried as the brand everywhere inside.
 * - `ReplayCursor` is a transport position: opaque, transport-tagged, stored and compared for
 *   equality only. Nothing orders by it, nothing derives a number from it, and no public id or DTO
 *   contains it.
 * - `CaptureSeq` is a store-local counter the writer allocates under the lease, in delivery order.
 *   It exists only to break ties inside one millisecond, where delivery order equals publish order
 *   within one `EventBus.publish` call (a Nebula transaction's entries keep their order).
 * - `EventPosition = (createdMs, seq, uuid)` is the store's total order: event time first.
 * - `EventRowId` is the public row/entry id: the position, fixed-width, so ids compare in list order
 *   as plain strings. The webview merges live rows by comparing ids and never parses them.
 * - `EntryPosition` adds the ordinal of one entry inside the event's payload. Ordinal 0 is the plain
 *   event id, so a stored line's id, a non-expanding event and the first entry of an expanding one
 *   share one spelling; ordinals above 0 add `-<4 base36>`.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, lower-cased. */
export type EventUuid = Brand<string, 'EventUuid'>;

/**
 * `<transport>:<value>`, for example `cometd:15253040`. CometD sends a JSON number, Pub/Sub sends
 * bytes (stored as hex). The transport that produced it is the only one that may send it back
 * (a `pubsub:` cursor is never handed to CometD).
 */
export type ReplayCursor = Brand<string, 'ReplayCursor'>;

/** Non-negative safe integer below 36^10, allocated by the store's writer. */
export type CaptureSeq = Brand<number, 'CaptureSeq'>;

export type EventPosition = Readonly<{
  createdMs: number;
  seq: CaptureSeq;
  uuid: EventUuid;
}>;

/** `e-<createdMs, 9 base36>-<seq, 10 base36>-<uuid, 32 hex>`, plus `-<ordinal, 4 base36>` above ordinal 0. See `CUSTOM_LOG_EVENT_ID_PATTERN`. */
export type EventRowId = Brand<string, 'CustomLogEventRowId'>;

/** One entry of an event: the event plus the entry's index in payload order, 0-based. */
export type EntryPosition = Readonly<{ event: EventPosition; ordinal: number }>;

export const SEQ_LIMIT = 36 ** 10;
/** An event id holds the event time in 9 base36 digits. */
export const EVENT_TIME_LIMIT_MS = 36 ** 9;
/** Four base36 digits. An entry needs at least three characters of a 131 072-character field, so an index always fits. */
export const ENTRY_ORDINAL_LIMIT = 36 ** 4;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_ID_PATTERN = /^e-([0-9a-z]{9})-([0-9a-z]{10})-([0-9a-f]{32})(?:-(?!0000)([0-9a-z]{4}))?$/;
const CURSOR_TRANSPORTS = ['cometd', 'pubsub'] as const;

export function parseEventUuid(value: unknown): EventUuid | undefined {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? (value.toLowerCase() as EventUuid) : undefined;
}

export function isCaptureSeq(value: unknown): value is CaptureSeq {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < SEQ_LIMIT;
}

/** The adapter parses the wire value first: a CometD replay id is a non-negative safe integer. */
export function cometdCursor(replayId: number): ReplayCursor {
  if (!Number.isSafeInteger(replayId) || replayId < 0) {
    throw new RangeError(`A CometD replay id is a non-negative safe integer, got ${replayId}.`);
  }
  return `cometd:${replayId}` as ReplayCursor;
}

/** The transport tag and raw value, for the adapter that owns the tag. */
export function readCursor(cursor: ReplayCursor): { transport: (typeof CURSOR_TRANSPORTS)[number]; value: string } {
  const separator = cursor.indexOf(':');
  const transport = cursor.slice(0, separator);
  if (!(CURSOR_TRANSPORTS as readonly string[]).includes(transport)) {
    throw new RangeError(`Unknown replay cursor transport "${transport}".`);
  }
  return { transport: transport as (typeof CURSOR_TRANSPORTS)[number], value: cursor.slice(separator + 1) };
}

export function eventRowId(position: EventPosition): EventRowId {
  const { createdMs, seq, uuid } = position;
  if (!Number.isSafeInteger(createdMs) || createdMs < 0 || createdMs >= EVENT_TIME_LIMIT_MS) {
    throw new RangeError(`An event time of ${createdMs} ms does not fit an event id.`);
  }
  return `e-${createdMs.toString(36).padStart(9, '0')}-${seq.toString(36).padStart(10, '0')}-${uuid.replaceAll('-', '')}` as EventRowId;
}

/** Ordinal 0 is the plain event id; above it the id gains `-<ordinal, 4 base36>`, so `-0000` is never issued. */
export function entryRowId({ event, ordinal }: EntryPosition): EventRowId {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= ENTRY_ORDINAL_LIMIT) {
    throw new RangeError(`An entry ordinal of ${ordinal} does not fit an entry id.`);
  }
  const id = eventRowId(event);
  return ordinal === 0 ? id : (`${id}-${ordinal.toString(36).padStart(4, '0')}` as EventRowId);
}

/** Returns undefined for anything that is not exactly an event or entry id. A plain event id is ordinal 0. */
export function parseEntryRowId(value: unknown): EntryPosition | undefined {
  const match = typeof value === 'string' ? ROW_ID_PATTERN.exec(value) : null;
  if (!match) return undefined;
  const [, time, seq, hex, ordinal] = match;
  const uuid = `${hex!.slice(0, 8)}-${hex!.slice(8, 12)}-${hex!.slice(12, 16)}-${hex!.slice(16, 20)}-${hex!.slice(20)}`;
  return {
    event: { createdMs: parseInt(time!, 36), seq: parseInt(seq!, 36) as CaptureSeq, uuid: uuid as EventUuid },
    ordinal: ordinal === undefined ? 0 : parseInt(ordinal, 36)
  };
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Store order, newest first: createdMs desc, then seq desc, then uuid desc. Equals `eventRowId` string order, reversed. */
export function compareNewestFirst(a: EventPosition, b: EventPosition): number {
  return b.createdMs - a.createdMs || b.seq - a.seq || compareText(b.uuid, a.uuid);
}

/** List order: the event newest first, then the ordinal descending. Equals `entryRowId` string order, reversed. */
export function compareEntriesNewestFirst(a: EntryPosition, b: EntryPosition): number {
  return compareNewestFirst(a.event, b.event) || b.ordinal - a.ordinal;
}
