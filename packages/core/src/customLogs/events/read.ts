/**
 * `list`, `get` and `entry` for an `events` source, answered from the local store with no network
 * call. Same params, same results and same cursor rules as the record path; `api.ts` picks this
 * module or `queries.ts` once per call, by the source's kind.
 *
 * What an event source documents (docs/CUSTOM_LOGS.md, "Event sources"):
 *  - list: one row per event, newest first in publish order: `CreatedDate`, then delivery order
 *    inside one publish (the capture sequence), then uuid. A Nebula transaction's entries share one
 *    `CreatedDate`, so the mapped time column can read non-monotonic; the order key is not the mapped
 *    time role. `since` and `until` bound `CreatedDate`. `minLevel` and `user` run in memory over the
 *    decoded rows, so `capabilities.levelFilter` and `userFilter` say only whether the role is mapped.
 *  - get by event id: the event as `log`, plus every stored event with the same `transactionId`
 *    whose `CreatedDate` is within `TRANSACTION_WINDOW_MS` of it, ordered by `order`, else by
 *    position. Without a `transactionId` value the event stands alone. `get` by transaction id
 *    anchors the same window on the newest stored event with that value (a scan of the store).
 *  - entry: the full message, every mapped detail and the mapped payload of one stored event.
 *    A mapped field the stored describe does not list resolves as `hidden`, as on a record source;
 *    its raw value stays on the stored line and is never decoded.
 *  - A store with no checkpoint answers `list` with an empty page and `store.state = 'notCaptured'`,
 *    which is how the panel knows to offer the first-use choice. `get` and `entry` answer
 *    CUSTOM_LOG_RECORD_NOT_FOUND.
 *
 * Nothing here opens a connection. The ApexLog link, the only part of `get` that needs the org, comes
 * in as `apexLog`.
 */

import { normalizeSoqlDateTimeLiteral } from '../../soql.js';
import { eventCapabilities, toColumns } from '../catalog.js';
import {
  CUSTOM_LOG_LEVELS,
  type CustomLogApexLogLink,
  type CustomLogEntryResult,
  type CustomLogGetResult,
  type CustomLogLevel,
  type CustomLogListResult,
  type CustomLogPayloadField,
  type CustomLogPayloadView,
  type CustomLogRow,
  type CustomLogSourceRef,
  type CustomLogStoreInfo
} from '../contracts.js';
import { count, detailsOf, entryDto, entryRow, rawPayloadOf, read, text, type RowIdentity } from '../decode.js';
import { customLogError } from '../errors.js';
import { shortHash } from '../hash.js';
import { normalizeLevel } from '../levels.js';
import { selectPayloadPaths, summarizePayloadFields } from '../payload.js';
import type { ResolvedEventObject, ResolvedEventSource } from '../resolved.js';
import type { ObjectDescribe } from '../schema.js';
import { compareNewestFirst, eventRowId, parseEventRowId, type EventPosition } from './ids.js';
import type { EventStore, StoreCoverage, StoredEvent } from './store.js';

/** Nebula transactions publish in one call; an hour each way covers long async chains without scanning the whole store. */
export const TRANSACTION_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// What a call reads

/**
 * One event source as a call finds it. A store with no checkpoint has nothing to resolve against, so
 * only the `captured` arm carries a source, its store and the org the history belongs to.
 */
export type EventSnapshot = Readonly<{ ref: CustomLogSourceRef; info: CustomLogStoreInfo }> &
  (
    | Readonly<{ state: 'notCaptured' }>
    | Readonly<{
        state: 'captured';
        store: EventStore;
        source: ResolvedEventSource;
        /** The checkpoint's org id. Cursors bind to it, so a refreshed sandbox under the same username rejects them. */
        orgId: string;
      }>
  );

export function storeInfoOf(coverage: StoreCoverage, retentionDays: number): CustomLogStoreInfo {
  if (coverage.state === 'notCaptured') {
    return { state: 'notCaptured', eventsRoot: coverage.eventsRoot, retentionDays };
  }
  const { state, eventsRoot, oldest, newest, lastCaptureAt, sizeBytes, gaps } = coverage;
  return {
    state,
    eventsRoot,
    ...(oldest !== undefined ? { oldest } : {}),
    ...(newest !== undefined ? { newest } : {}),
    lastCaptureAt,
    sizeBytes,
    retentionDays,
    gaps
  };
}

/**
 * Read the store once for a call. `resolve` turns the stored describe into the source, offline, so
 * a mapping the stored describe cannot satisfy fails here with the resolver's own reason.
 */
export async function openSnapshot(input: {
  store: EventStore;
  retentionDays: number;
  ref: CustomLogSourceRef;
  resolve: (describe: ObjectDescribe) => ResolvedEventSource;
}): Promise<EventSnapshot> {
  const { store, retentionDays, ref, resolve } = input;
  const checkpoint = await store.checkpoint();
  if (!checkpoint) {
    const info = storeInfoOf({ state: 'notCaptured', eventsRoot: store.eventsRoot }, retentionDays);
    return { ref, info, state: 'notCaptured' };
  }
  const [describe, coverage] = await Promise.all([store.describe(), store.coverage()]);
  if (!describe) {
    throw customLogError(
      'CUSTOM_LOG_STORE_UNAVAILABLE',
      `The stored describe of ${store.eventsRoot} is missing, so its events cannot be read. Run a capture to write it again.`
    );
  }
  return {
    ref,
    info: storeInfoOf(coverage, retentionDays),
    state: 'captured',
    store,
    source: resolve(describe),
    orgId: checkpoint.orgId
  };
}

// ---------------------------------------------------------------------------------------------
// Cursors

type Window = { since?: string; until?: string };
type Binding = { o: string; s: string; m: string; f: string };

/**
 * Same binding as a record cursor (org, source, mapping digest, filter hash), under kinds of their
 * own: `decodeCursor` refuses an event cursor and `decodeEventCursor` a record one, so neither can be
 * replayed against the other kind of source. `id` is the row id of the last row returned (`eventList`)
 * or of the anchor event (`eventEntries`); `n` counts the entries already returned.
 */
type EventCursor =
  | (Binding & { v: 1; k: 'eventList'; id: string; w?: Window })
  | (Binding & { v: 1; k: 'eventEntries'; id: string; n: number });

type PageKind = EventCursor['k'];

const MAX_CURSOR_CHARS = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const encodeEventCursor = (cursor: EventCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

function invalidCursor(reason: string): never {
  throw customLogError(
    'CUSTOM_LOG_INVALID_CURSOR',
    `The cursor does not belong to this request (${reason}). Run the command again without --cursor.`
  );
}

const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && normalizeSoqlDateTimeLiteral(value) === value;

/** Throws CUSTOM_LOG_INVALID_CURSOR on a malformed token or on any binding mismatch. */
function decodeEventCursor<K extends PageKind>(
  token: string,
  kind: K,
  binding: Binding
): Extract<EventCursor, { k: K }> {
  if (token.length > MAX_CURSOR_CHARS || !BASE64URL.test(token)) return invalidCursor('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return invalidCursor('malformed');
  }
  const cursor = parsed as Partial<EventCursor> | null;
  const window = cursor?.k === 'eventList' ? cursor.w : undefined;
  const wellFormed =
    typeof cursor === 'object' &&
    cursor !== null &&
    cursor.v === 1 &&
    typeof cursor.o === 'string' &&
    typeof cursor.s === 'string' &&
    typeof cursor.m === 'string' &&
    typeof cursor.f === 'string' &&
    parseEventRowId(cursor.id) !== undefined &&
    (cursor.k === 'eventList'
      ? window === undefined ||
        (typeof window === 'object' &&
          window !== null &&
          (window.since === undefined || isInstant(window.since)) &&
          (window.until === undefined || isInstant(window.until)))
      : cursor.k === 'eventEntries' && Number.isSafeInteger(cursor.n) && (cursor.n ?? -1) >= 0);
  if (!wellFormed) return invalidCursor('malformed');

  const found = cursor as EventCursor;
  if (found.k !== kind) return invalidCursor('another kind of page');
  const mismatches: [keyof Binding, string][] = [
    ['o', 'another org'],
    ['s', 'another source'],
    ['m', 'the mapping changed'],
    ['f', 'other filters']
  ];
  for (const [key, reason] of mismatches) if (found[key] !== binding[key]) return invalidCursor(reason);
  return found as Extract<EventCursor, { k: K }>;
}

// ---------------------------------------------------------------------------------------------
// Shared pieces

const identityOf = (event: StoredEvent): RowIdentity => ({ id: event.id, createdDate: event.createdDate });

function notFound(what: string): never {
  throw customLogError(
    'CUSTOM_LOG_RECORD_NOT_FOUND',
    `${what} was not found in the captured events. Run "sf electivus custom-log capture" to bring the store up to date.`
  );
}

function unsupported(source: ResolvedEventSource, what: string): never {
  throw customLogError(
    'CUSTOM_LOG_UNSUPPORTED_FILTER',
    `Log source "${source.id}" has no ${what}, so it cannot be filtered that way.`
  );
}

/** The summary covers whole payloads; `keep` then trims each row to the paths the caller asked for. */
function withPayloadSummary<T extends { payload?: CustomLogPayloadView }>(
  items: T[],
  keep: ReadonlySet<string> | undefined
) {
  return {
    items: keep
      ? items.map(item => (item.payload ? { ...item, payload: selectPayloadPaths(item.payload, keep) } : item))
      : items,
    payloadFields: summarizePayloadFields(items.flatMap(item => item.payload ?? []))
  };
}

const levelIndex = (level: CustomLogLevel): number => CUSTOM_LOG_LEVELS.indexOf(level);

function levelOf(event: ResolvedEventObject, source: ResolvedEventSource, record: StoredEvent['record']) {
  const { roles } = event;
  return normalizeLevel(
    source.levels,
    roles.level && read(record, roles.level.api),
    roles.levelOrdinal && read(record, roles.levelOrdinal.api)
  ).level;
}

/** The in-memory filters of `list` and of a live capture: both run over decoded rows, so the mapped roles decide what they can do. */
export type EventRowFilter = { minLevel?: CustomLogLevel; user?: string };

/** CUSTOM_LOG_UNSUPPORTED_FILTER when the filter names a role the mapping leaves out. Checked once, where a call starts. */
export function requireFilterable(source: ResolvedEventSource, { minLevel, user }: EventRowFilter): void {
  const can = eventCapabilities(source.shape.event);
  if (minLevel && !can.levelFilter) unsupported(source, 'level mapping');
  if (user && !can.userFilter) unsupported(source, 'user mapping');
}

/** The row of one stored event, or nothing when the filter drops it. `list` and a live capture decode through this alone, so a live row and a listed row cannot differ. */
function rowOf(source: ResolvedEventSource, stored: StoredEvent, { minLevel, user }: EventRowFilter) {
  const row = entryRow(source.shape.event, source.levels, stored.record, identityOf(stored));
  if (minLevel && (row.level === undefined || levelIndex(row.level) < levelIndex(minLevel))) return undefined;
  if (user && row.user?.toLowerCase() !== user.toLowerCase()) return undefined;
  return row;
}

/** What a capture update shows for `events`: the rows that pass the filter and the payload paths they carry. */
export function decodeEventRows(
  source: ResolvedEventSource,
  events: readonly StoredEvent[],
  view: EventRowFilter & { keep?: ReadonlySet<string> }
): { rows: CustomLogRow[]; payloadFields: CustomLogPayloadField[] } {
  const { items, payloadFields } = withPayloadSummary(
    events.flatMap(stored => rowOf(source, stored, view) ?? []),
    view.keep
  );
  return { rows: items, payloadFields };
}

/** The mapped transaction id, whole: a row's copy is cut to a cell, and ids are compared uncut. */
function transactionOf(event: ResolvedEventObject, record: StoredEvent['record']): string | undefined {
  return event.roles.transactionId && text(read(record, event.roles.transactionId.api));
}

// ---------------------------------------------------------------------------------------------
// list

export type EventListParams = {
  limit: number;
  /** The filter as the caller gave it. The cursor binds to it, and `minLevel` and `user` are applied from it. */
  given: { minLevel?: CustomLogLevel; user?: string; since?: string; until?: string };
  /** `since` and `until` as instants, durations resolved. Later pages take them from the cursor. */
  window: Window;
  cursor?: string;
  keep?: ReadonlySet<string>;
};

export async function listEvents(snapshot: EventSnapshot, params: EventListParams): Promise<CustomLogListResult> {
  const { ref, info } = snapshot;
  if (snapshot.state === 'notCaptured') {
    if (params.cursor) invalidCursor('nothing is captured for this source');
    return { source: ref, columns: [], rows: [], payloadFields: [], nextCursor: null, store: info };
  }
  const { store, source, orgId } = snapshot;
  const event = source.shape.event;
  requireFilterable(source, params.given);

  const binding: Binding = { o: orgId, s: source.id, m: source.digest, f: shortHash(params.given) };
  const after = params.cursor ? decodeEventCursor(params.cursor, 'eventList', binding) : undefined;
  const window = after ? (after.w ?? {}) : params.window;

  const rows: CustomLogRow[] = [];
  let last: StoredEvent | undefined;
  let more = false;
  const scan = store.newestFirst({
    ...(after ? { before: parseEventRowId(after.id) } : {}),
    ...(window.since ? { sinceMs: Date.parse(window.since) } : {}),
    ...(window.until ? { untilMs: Date.parse(window.until) } : {})
  });
  for await (const stored of scan) {
    const row = rowOf(source, stored, params.given);
    if (!row) continue;
    if (rows.length === params.limit) {
      more = true;
      break;
    }
    rows.push(row);
    last = stored;
  }

  const { items, payloadFields } = withPayloadSummary(rows, params.keep);
  const next: EventCursor | undefined =
    more && last
      ? { v: 1, k: 'eventList', ...binding, ...(Object.keys(window).length > 0 ? { w: window } : {}), id: last.id }
      : undefined;
  return {
    source: ref,
    columns: toColumns(event.columns),
    rows: items,
    payloadFields,
    nextCursor: next ? encodeEventCursor(next) : null,
    store: info
  };
}

// ---------------------------------------------------------------------------------------------
// get

export type EventGetParams = {
  limit: number;
  minLevel?: CustomLogLevel;
  cursor?: string;
  keep?: ReadonlySet<string>;
  anchor: { logId: EventPosition } | { transactionId: string };
};

/** Looks the link up from the anchor row's request id. Only this lookup may need the org. */
export type ApexLogLookup = (requestId: string | undefined) => Promise<CustomLogApexLogLink>;

async function anchorOf(
  store: EventStore,
  source: ResolvedEventSource,
  anchor: EventGetParams['anchor']
): Promise<StoredEvent> {
  if ('logId' in anchor) {
    return (await store.find(anchor.logId)) ?? notFound(`Event ${eventRowId(anchor.logId)}`);
  }
  const event = source.shape.event;
  if (!event.roles.transactionId) unsupported(source, 'transaction id mapping');
  for await (const stored of store.newestFirst({})) {
    if (transactionOf(event, stored.record) === anchor.transactionId) return stored;
  }
  return notFound(`Transaction ${anchor.transactionId}`);
}

/** The anchor's transaction, in order: the mapped `order`, then position. Events with no `order` come last. */
async function transactionOfAnchor(
  store: EventStore,
  event: ResolvedEventObject,
  anchor: StoredEvent
): Promise<StoredEvent[]> {
  const key = transactionOf(event, anchor.record);
  if (key === undefined) return [anchor];
  const { createdMs } = anchor.position;
  const around = await store.window(createdMs - TRANSACTION_WINDOW_MS, createdMs + TRANSACTION_WINDOW_MS);
  const orderOf = (stored: StoredEvent): number =>
    (event.roles.order && count(read(stored.record, event.roles.order.api))) ?? Infinity;
  return around
    .filter(stored => transactionOf(event, stored.record) === key)
    .map(stored => ({ stored, order: orderOf(stored) }))
    .sort((a, b) => a.order - b.order || compareNewestFirst(b.stored.position, a.stored.position))
    .map(({ stored }) => stored);
}

export async function getEvent(
  snapshot: EventSnapshot,
  params: EventGetParams,
  apexLog: ApexLogLookup
): Promise<CustomLogGetResult> {
  if (snapshot.state === 'notCaptured') {
    return notFound(
      'logId' in params.anchor
        ? `Event ${eventRowId(params.anchor.logId)}`
        : `Transaction ${params.anchor.transactionId}`
    );
  }
  const { store, source, orgId, info, ref } = snapshot;
  const event = source.shape.event;
  const { minLevel } = params;
  if (minLevel && !eventCapabilities(event).levelFilter) unsupported(source, 'level mapping');

  const scope = 'logId' in params.anchor ? { logId: eventRowId(params.anchor.logId) } : params.anchor;
  const binding: Binding = { o: orgId, s: source.id, m: source.digest, f: shortHash({ scope, minLevel }) };
  const after = params.cursor ? decodeEventCursor(params.cursor, 'eventEntries', binding) : undefined;

  const anchor = await anchorOf(store, source, params.anchor);
  const members = (await transactionOfAnchor(store, event, anchor)).filter(stored => {
    if (!minLevel) return true;
    const level = levelOf(event, source, stored.record);
    return level !== undefined && levelIndex(level) >= levelIndex(minLevel);
  });

  const offset = after?.n ?? 0;
  const page = members.slice(offset, offset + params.limit);
  const entries = page.map((stored, index) =>
    entryDto(event, source.levels, stored.record, identityOf(stored), offset + index + 1, true)
  );
  const log = entryRow(event, source.levels, anchor.record, identityOf(anchor));
  const { items, payloadFields } = withPayloadSummary(entries, params.keep);
  const next: EventCursor | undefined =
    offset + page.length < members.length
      ? { v: 1, k: 'eventEntries', ...binding, id: anchor.id, n: offset + page.length }
      : undefined;
  return {
    source: ref,
    log,
    entryColumns: toColumns(event.columns),
    entries: items,
    payloadFields,
    nextCursor: next ? encodeEventCursor(next) : null,
    apexLog: await apexLog(log.requestId),
    store: info
  };
}

// ---------------------------------------------------------------------------------------------
// entry

export async function entryEvent(snapshot: EventSnapshot, entryId: EventPosition): Promise<CustomLogEntryResult> {
  const missing = `Entry ${eventRowId(entryId)}`;
  if (snapshot.state === 'notCaptured') return notFound(missing);
  const { store, source, ref } = snapshot;
  const event = source.shape.event;
  const found = (await store.find(entryId)) ?? notFound(missing);
  return {
    source: ref,
    logId: found.id,
    entry: entryDto(event, source.levels, found.record, identityOf(found), 1, false),
    details: detailsOf(event, found.record),
    rawPayload: rawPayloadOf(event, found.record)
  };
}
