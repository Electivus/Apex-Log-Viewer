/**
 * `list`, `get` and `entry` for an `events` source, answered from the local store with no network
 * call. Same params, same results and same cursor rules as the record path; `api.ts` picks this
 * module or `queries.ts` once per call, by the source's kind.
 *
 * What an event source documents (docs/CUSTOM_LOGS.md, "Event sources"):
 *  - A row is an entry of an event (`entriesOf`): the event itself, or one element of each JSON
 *    array its `payload.entries` fields hold. Ordinal 0 keeps the event's plain id.
 *  - list: entries newest first in publish order: `CreatedDate`, then delivery order inside one
 *    publish (the capture sequence), then uuid, then the highest ordinal first. A Nebula
 *    transaction's entries share one `CreatedDate`, so the mapped time column can read
 *    non-monotonic; the order key is not the mapped time role. `since` and `until` bound
 *    `CreatedDate`. `minLevel` and `user` run in memory over the decoded rows, so
 *    `capabilities.levelFilter` and `userFilter` say only whether the role is mapped.
 *  - get by id: the entry as `log`, plus every stored entry with the same `transactionId` whose
 *    event `CreatedDate` is within `TRANSACTION_WINDOW_MS` of it, ordered by `order`, else by
 *    position. Without a `transactionId` value the entry stands alone. `get` by transaction id
 *    anchors the same window on the newest stored entry with that value (a scan of the store).
 *  - entry: the full message, every mapped detail and the payload of one stored entry.
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
import {
  detailsOf,
  entryDto,
  entryRow,
  levelOf,
  rawPayloadOf,
  read,
  roleNumber,
  roleText,
  type Subject
} from '../decode.js';
import { customLogError } from '../errors.js';
import { shortHash } from '../hash.js';
import {
  HIDDEN_DOC,
  docOfText,
  readEntrySlot,
  selectPayloadPaths,
  summarizePayloadFields,
  type PayloadDoc
} from '../payload.js';
import {
  assertNever,
  type ResolvedEventObject,
  type ResolvedEventPayload,
  type ResolvedEventSource
} from '../resolved.js';
import type { ObjectDescribe } from '../schema.js';
import { compareEntriesNewestFirst, entryRowId, parseEntryRowId, type EntryPosition } from './ids.js';
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

/** Throws CUSTOM_LOG_INVALID_CURSOR on a malformed token or on any binding mismatch. `at` is the parsed `id`. */
function decodeEventCursor<K extends PageKind>(
  token: string,
  kind: K,
  binding: Binding
): Extract<EventCursor, { k: K }> & { at: EntryPosition } {
  if (token.length > MAX_CURSOR_CHARS || !BASE64URL.test(token)) return invalidCursor('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return invalidCursor('malformed');
  }
  const cursor = parsed as Partial<EventCursor> | null;
  const window = cursor?.k === 'eventList' ? cursor.w : undefined;
  const at = parseEntryRowId(cursor?.id);
  const wellFormed =
    typeof cursor === 'object' &&
    cursor !== null &&
    cursor.v === 1 &&
    typeof cursor.o === 'string' &&
    typeof cursor.s === 'string' &&
    typeof cursor.m === 'string' &&
    typeof cursor.f === 'string' &&
    at !== undefined &&
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
  return { ...(found as Extract<EventCursor, { k: K }>), at };
}

// ---------------------------------------------------------------------------------------------
// Entries: what a call reads rows from

/** One row of an event source: the event, where the row sits in its payload, and what the decoders read. */
export type EventEntry = Readonly<{
  stored: StoredEvent;
  position: EntryPosition;
  subject: Subject;
}>;

type Docs = readonly [PayloadDoc | undefined, ...(PayloadDoc | undefined)[]];

/**
 * The payload doc of each row of an event, in payload order. No payload: one row with none. A
 * document: one row with it. Entries: each readable field in mapping order contributes its slot
 * reading; when nothing results, one row with `HIDDEN_DOC` if any field is hidden, else the first
 * field's doc (so blank fields give `empty` and `[]` gives `parsed` with no values).
 */
function docsOf(payload: ResolvedEventPayload | undefined, record: StoredEvent['record']): Docs {
  switch (payload?.kind) {
    case undefined:
      return [undefined];
    case 'document':
      return [
        payload.field.state === 'readable'
          ? docOfText(read(record, payload.field.field.api), payload.rolePaths)
          : HIDDEN_DOC
      ];
    case 'entries': {
      const docs: PayloadDoc[] = [];
      let hidden = false;
      for (const field of payload.fields) {
        if (field.state === 'hidden') {
          hidden = true;
          continue;
        }
        const reading = readEntrySlot(read(record, field.field.api), payload.rolePaths);
        switch (reading.kind) {
          case 'blank':
            break;
          case 'elements':
            docs.push(...reading.docs);
            break;
          case 'whole':
            docs.push(reading.doc);
            break;
          default:
            assertNever(reading, 'slot reading');
        }
      }
      const [head, ...tail] = docs;
      if (head) return [head, ...tail];
      if (hidden) return [HIDDEN_DOC];
      const [first] = payload.fields;
      return [docOfText(first.state === 'readable' ? read(record, first.field.api) : undefined, payload.rolePaths)];
    }
    default:
      return assertNever(payload, 'event payload');
  }
}

/** The rows of one stored event, in payload order. Never empty; an entry's ordinal is its index. Pure. */
export function entriesOf(event: ResolvedEventObject, stored: StoredEvent): readonly [EventEntry, ...EventEntry[]] {
  const entryAt = (doc: PayloadDoc | undefined, ordinal: number): EventEntry => {
    const position = { event: stored.position, ordinal };
    return {
      stored,
      position,
      subject: {
        record: stored.record,
        identity: { id: entryRowId(position), createdDate: stored.createdDate },
        payload: doc
      }
    };
  };
  const [first, ...rest] = docsOf(event.payload, stored.record);
  return [entryAt(first, 0), ...rest.map((doc, index) => entryAt(doc, index + 1))];
}

/** An event's entries in list order: highest ordinal first. */
const newestFirst = (entries: readonly EventEntry[]): EventEntry[] => [...entries].reverse();

/**
 * Every entry newer-to-older, resuming after `after` when given: the rest of that event's entries
 * first, then older events. The resumed event needs no window check (page one listed it under the
 * same window, which the cursor carries), and one retention purged between pages is skipped.
 */
async function* entriesNewestFirst(
  store: EventStore,
  event: ResolvedEventObject,
  options: { after?: EntryPosition; sinceMs?: number; untilMs?: number }
): AsyncGenerator<EventEntry> {
  const { after, sinceMs, untilMs } = options;
  if (after && after.ordinal > 0) {
    const stored = await store.find(after.event);
    if (stored) {
      for (const entry of newestFirst(entriesOf(event, stored))) {
        if (entry.position.ordinal < after.ordinal) yield entry;
      }
    }
  }
  const scan = store.newestFirst({
    ...(after ? { before: after.event } : {}),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs })
  });
  for await (const stored of scan) yield* newestFirst(entriesOf(event, stored));
}

/** The entry at `position`, or undefined when the store lacks the event or the ordinal is past its end. */
async function findEntry(
  store: EventStore,
  event: ResolvedEventObject,
  position: EntryPosition
): Promise<EventEntry | undefined> {
  const stored = await store.find(position.event);
  return stored && entriesOf(event, stored)[position.ordinal];
}

// ---------------------------------------------------------------------------------------------
// Shared pieces

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

/** The in-memory filters of `list` and of a live capture: both run over decoded rows, so the mapped roles decide what they can do. */
export type EventRowFilter = { minLevel?: CustomLogLevel; user?: string };

/** CUSTOM_LOG_UNSUPPORTED_FILTER when the filter names a role the mapping leaves out. Checked once, where a call starts. */
export function requireFilterable(source: ResolvedEventSource, { minLevel, user }: EventRowFilter): void {
  const can = eventCapabilities(source.shape.event);
  if (minLevel && !can.levelFilter) unsupported(source, 'level mapping');
  if (user && !can.userFilter) unsupported(source, 'user mapping');
}

/** The row of one entry, or nothing when the filter drops it. `list` and a live capture decode through this alone, so a live row and a listed row cannot differ. */
function rowOf(source: ResolvedEventSource, entry: EventEntry, { minLevel, user }: EventRowFilter) {
  const row = entryRow(source.shape.event, source.levels, entry.subject);
  if (minLevel && (row.level === undefined || levelIndex(row.level) < levelIndex(minLevel))) return undefined;
  if (user && row.user?.toLowerCase() !== user.toLowerCase()) return undefined;
  return row;
}

/** What a capture update shows for `events`: the rows that pass the filter, events in the order given and each event's entries in payload order, and the payload paths they carry. */
export function decodeEventRows(
  source: ResolvedEventSource,
  events: readonly StoredEvent[],
  view: EventRowFilter & { keep?: ReadonlySet<string> }
): { rows: CustomLogRow[]; payloadFields: CustomLogPayloadField[] } {
  const { items, payloadFields } = withPayloadSummary(
    events.flatMap(stored => entriesOf(source.shape.event, stored)).flatMap(entry => rowOf(source, entry, view) ?? []),
    view.keep
  );
  return { rows: items, payloadFields };
}

/** The mapped transaction id, whole: a row's copy is cut to a cell, and ids are compared uncut. */
function transactionOf(event: ResolvedEventObject, entry: EventEntry): string | undefined {
  return roleText(entry.subject, event.roles.transactionId);
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
  let last: EventEntry | undefined;
  let more = false;
  const scan = entriesNewestFirst(store, event, {
    ...(after ? { after: after.at } : {}),
    ...(window.since ? { sinceMs: Date.parse(window.since) } : {}),
    ...(window.until ? { untilMs: Date.parse(window.until) } : {})
  });
  for await (const entry of scan) {
    const row = rowOf(source, entry, params.given);
    if (!row) continue;
    if (rows.length === params.limit) {
      more = true;
      break;
    }
    rows.push(row);
    last = entry;
  }

  const { items, payloadFields } = withPayloadSummary(rows, params.keep);
  const next: EventCursor | undefined =
    more && last
      ? {
          v: 1,
          k: 'eventList',
          ...binding,
          ...(Object.keys(window).length > 0 ? { w: window } : {}),
          id: entryRowId(last.position)
        }
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
  anchor: { logId: EntryPosition } | { transactionId: string };
};

/** Looks the link up from a request id. Only this lookup may need the org. */
export type ApexLogLookup = (requestId: string | undefined) => Promise<CustomLogApexLogLink>;

async function anchorOf(
  store: EventStore,
  source: ResolvedEventSource,
  anchor: EventGetParams['anchor']
): Promise<EventEntry> {
  const event = source.shape.event;
  if ('logId' in anchor) {
    return (await findEntry(store, event, anchor.logId)) ?? notFound(`Event ${entryRowId(anchor.logId)}`);
  }
  if (!event.roles.transactionId) unsupported(source, 'transaction id mapping');
  for await (const entry of entriesNewestFirst(store, event, {})) {
    if (transactionOf(event, entry) === anchor.transactionId) return entry;
  }
  return notFound(`Transaction ${anchor.transactionId}`);
}

/**
 * The anchor's transaction, in order: the mapped `order`, then publish order and payload order.
 * Entries with no `order` come last. An entry of the same event with another transaction id is
 * left out.
 */
async function transactionOfAnchor(
  store: EventStore,
  event: ResolvedEventObject,
  anchor: EventEntry
): Promise<EventEntry[]> {
  const key = transactionOf(event, anchor);
  if (key === undefined) return [anchor];
  const { createdMs } = anchor.stored.position;
  const around = await store.window(createdMs - TRANSACTION_WINDOW_MS, createdMs + TRANSACTION_WINDOW_MS);
  const orderOf = (entry: EventEntry): number => roleNumber(entry.subject, event.roles.order) ?? Infinity;
  return around
    .flatMap(stored => entriesOf(event, stored))
    .filter(entry => transactionOf(event, entry) === key)
    .map(entry => ({ entry, order: orderOf(entry) }))
    .sort((a, b) => a.order - b.order || compareEntriesNewestFirst(b.entry.position, a.entry.position))
    .map(({ entry }) => entry);
}

export async function getEvent(
  snapshot: EventSnapshot,
  params: EventGetParams,
  apexLog: ApexLogLookup
): Promise<CustomLogGetResult> {
  if (snapshot.state === 'notCaptured') {
    return notFound(
      'logId' in params.anchor
        ? `Event ${entryRowId(params.anchor.logId)}`
        : `Transaction ${params.anchor.transactionId}`
    );
  }
  const { store, source, orgId, info, ref } = snapshot;
  const event = source.shape.event;
  const { minLevel } = params;
  if (minLevel && !eventCapabilities(event).levelFilter) unsupported(source, 'level mapping');

  const scope = 'logId' in params.anchor ? { logId: entryRowId(params.anchor.logId) } : params.anchor;
  const binding: Binding = { o: orgId, s: source.id, m: source.digest, f: shortHash({ scope, minLevel }) };
  const after = params.cursor ? decodeEventCursor(params.cursor, 'eventEntries', binding) : undefined;

  // A later page continues the window of the first: a newer occurrence of the transaction id must not move it.
  const anchor = await anchorOf(store, source, after ? { logId: after.at } : params.anchor);
  const transaction = await transactionOfAnchor(store, event, anchor);
  const members = transaction.filter(entry => {
    if (!minLevel) return true;
    const level = levelOf(event, source.levels, entry.subject);
    return level !== undefined && levelIndex(level) >= levelIndex(minLevel);
  });

  const offset = after?.n ?? 0;
  const page = members.slice(offset, offset + params.limit);
  const entries = page.map((entry, index) => entryDto(event, source.levels, entry.subject, offset + index + 1, true));
  const log = entryRow(event, source.levels, anchor.subject);
  const { items, payloadFields } = withPayloadSummary(entries, params.keep);
  const next: EventCursor | undefined =
    offset + page.length < members.length
      ? { v: 1, k: 'eventEntries', ...binding, id: entryRowId(anchor.position), n: offset + page.length }
      : undefined;
  const requestId = [anchor, ...transaction]
    .map(entry => roleText(entry.subject, event.roles.requestId))
    .find(value => value !== undefined);
  return {
    source: ref,
    log,
    entryColumns: toColumns(event.columns),
    entries: items,
    payloadFields,
    nextCursor: next ? encodeEventCursor(next) : null,
    apexLog: await apexLog(requestId),
    store: info
  };
}

// ---------------------------------------------------------------------------------------------
// entry

export async function entryEvent(snapshot: EventSnapshot, entryId: EntryPosition): Promise<CustomLogEntryResult> {
  const missing = `Entry ${entryRowId(entryId)}`;
  if (snapshot.state === 'notCaptured') return notFound(missing);
  const { store, source, ref } = snapshot;
  const event = source.shape.event;
  const found = (await findEntry(store, event, entryId)) ?? notFound(missing);
  const { subject } = found;
  return {
    source: ref,
    logId: subject.identity.id,
    entry: entryDto(event, source.levels, subject, 1, false),
    details: detailsOf(event, subject),
    rawPayload: rawPayloadOf(subject)
  };
}
