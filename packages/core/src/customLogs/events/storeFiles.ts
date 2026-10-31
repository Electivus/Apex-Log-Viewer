/**
 * What the event store keeps on disk and how it reads it back: the line, checkpoint and gap formats,
 * the hour partitions, the per-file line index, the newest-first scan with its dedupe (I3), and the
 * fold of the per-writer gap files (I5). Read side only: `store.ts` owns every write and every path
 * guard, so nothing here imports `localStore/workspaceFs.ts`.
 */

import { promises as fs, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { ObjectDescribe } from '../schema.js';
import {
  compareNewestFirst,
  eventRowId,
  isCaptureSeq,
  parseEventUuid,
  type EventPosition,
  type EventRowId,
  type EventUuid,
  type ReplayCursor
} from './ids.js';

/** One line of a data file. Readable on purpose: agents `rg` and `jq` these files. */
export type StoredEventLine = {
  v: 1;
  /** The public row id (EventRowId) of this copy, so an `rg` hit can go straight to `custom-log entry --entry-id`. */
  id: string;
  uuid: string;
  /** Store-local capture sequence (CaptureSeq). Tie-break inside one millisecond; never a replay id. */
  seq: number;
  /** The opaque ReplayCursor this copy arrived with. Kept for diagnostics and search only; never read back for ordering or identity. */
  replayId: string;
  createdDate: string;
  receivedAt: string;
  /** Every field the message carried, nulls omitted. Never filtered by FLS (I4). */
  payload: Record<string, unknown>;
};

export type EventCheckpoint = {
  version: 1;
  /** The org the cursor belongs to. A different org id at capture start means the username now names another org. */
  orgId: string;
  transport: 'cometd' | 'pubsub';
  channel: string;
  /** Resume after this. Written only after the event it names is durable (I2). */
  cursor: ReplayCursor;
  lastEvent: { createdDate: string; uuid: EventUuid };
  /** Next CaptureSeq the lease holder may allocate. */
  nextSeq: number;
  updatedAt: string;
  /** Writer id (file-name tag) of the writer that wrote it; diagnostics and seq recovery. */
  writer: string;
};

export type GapReason = 'cursorRejected' | 'retentionElapsed' | 'orgChanged';

export type GapLine =
  | { v: 1; op: 'open'; id: string; reason: GapReason; after?: string; detectedAt: string }
  | { v: 1; op: 'close'; id: string; before: string };

export type StoredEvent = Readonly<{
  position: EventPosition;
  id: EventRowId;
  createdDate: string;
  /** `payload` plus `CreatedDate`, the record the shared decoders read. */
  record: Readonly<Record<string, unknown>>;
}>;

export type OpenGap = { id: string; reason: GapReason; after?: string; detectedAt: string };

export const FORMAT_VERSION = 1;
const PARTITION_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PARTITION_FILE = /^(\d{2})\.([0-9a-f]{8})\.ndjson$/;
const GAP_FILE = /^gaps\.([0-9a-f]{8})\.ndjson$/;
const CURSOR_TEXT = /^[a-z][a-z0-9]*:[0-9A-Za-z]+$/;
const GAP_REASONS: ReadonlySet<string> = new Set<GapReason>(['cursorRejected', 'retentionElapsed', 'orgChanged']);

/** An event id holds the event time in 9 base36 digits (ids.ts). */
const EVENT_TIME_LIMIT_MS = 36 ** 9;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const READ_CHUNK_BYTES = 1 << 20;
/** Bounds the per-store line index: about 100 bytes a line, so tens of MB. Deeper scans re-index old hours. */
const INDEX_CACHE_MAX_LINES = 200_000;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

export const isNotFound = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

// ---------------------------------------------------------------------------------------------
// Parsing the files at the boundary

export function createdMsOf(createdDate: unknown): number | undefined {
  const createdMs = typeof createdDate === 'string' ? Date.parse(createdDate) : Number.NaN;
  return Number.isSafeInteger(createdMs) && createdMs >= 0 && createdMs < EVENT_TIME_LIMIT_MS ? createdMs : undefined;
}

export function parseCheckpoint(value: unknown): EventCheckpoint | undefined {
  if (!isRecord(value) || value.version !== FORMAT_VERSION) return undefined;
  const { orgId, transport, channel, cursor, lastEvent, nextSeq, updatedAt, writer } = value;
  const last = isRecord(lastEvent) ? lastEvent : undefined;
  const lastUuid = parseEventUuid(last?.uuid);
  if (
    typeof orgId !== 'string' ||
    (transport !== 'cometd' && transport !== 'pubsub') ||
    typeof channel !== 'string' ||
    typeof cursor !== 'string' ||
    !CURSOR_TEXT.test(cursor) ||
    typeof last?.createdDate !== 'string' ||
    lastUuid === undefined ||
    !isCaptureSeq(nextSeq) ||
    typeof updatedAt !== 'string' ||
    Number.isNaN(Date.parse(updatedAt)) ||
    typeof writer !== 'string'
  ) {
    return undefined;
  }
  return {
    version: FORMAT_VERSION,
    orgId,
    transport,
    channel,
    cursor: cursor as ReplayCursor,
    lastEvent: { createdDate: last.createdDate, uuid: lastUuid },
    nextSeq,
    updatedAt,
    writer
  };
}

function parseFieldDescribe(value: unknown): ObjectDescribe['fields'][number] | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.type !== 'string' ||
    !isStringArray(value.referenceTo) ||
    typeof value.sortable !== 'boolean' ||
    typeof value.filterable !== 'boolean' ||
    !Array.isArray(value.picklistValues)
  ) {
    return undefined;
  }
  const picklistValues: { value: string; active: boolean }[] = [];
  for (const entry of value.picklistValues) {
    if (!isRecord(entry) || typeof entry.value !== 'string' || typeof entry.active !== 'boolean') return undefined;
    picklistValues.push({ value: entry.value, active: entry.active });
  }
  return {
    name: value.name,
    label: value.label,
    type: value.type,
    ...(typeof value.relationshipName === 'string' ? { relationshipName: value.relationshipName } : {}),
    referenceTo: value.referenceTo,
    sortable: value.sortable,
    filterable: value.filterable,
    picklistValues
  };
}

export function parseObjectDescribe(value: unknown): ObjectDescribe | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.keyPrefix !== 'string' ||
    typeof value.queryable !== 'boolean' ||
    !Array.isArray(value.fields)
  ) {
    return undefined;
  }
  const fields: ObjectDescribe['fields'][number][] = [];
  for (const field of value.fields) {
    const parsed = parseFieldDescribe(field);
    if (!parsed) return undefined;
    fields.push(parsed);
  }
  return { name: value.name, keyPrefix: value.keyPrefix, queryable: value.queryable, fields };
}

/** The position of a data line, or undefined for a line a reader must skip. */
function parseDataLine(text: string): EventPosition | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.v !== 1) return undefined;
  const uuid = parseEventUuid(value.uuid);
  const createdMs = createdMsOf(value.createdDate);
  if (uuid === undefined || createdMs === undefined || !isCaptureSeq(value.seq)) return undefined;
  return { createdMs, seq: value.seq, uuid };
}

function parseGapLine(text: string): GapLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.v !== 1 || typeof value.id !== 'string') return undefined;
  if (value.op === 'close')
    return typeof value.before === 'string' ? { v: 1, op: 'close', id: value.id, before: value.before } : undefined;
  if (
    value.op !== 'open' ||
    typeof value.reason !== 'string' ||
    !GAP_REASONS.has(value.reason) ||
    typeof value.detectedAt !== 'string' ||
    (value.after !== undefined && typeof value.after !== 'string')
  ) {
    return undefined;
  }
  return {
    v: 1,
    op: 'open',
    id: value.id,
    reason: value.reason as GapReason,
    ...(value.after !== undefined ? { after: value.after } : {}),
    detectedAt: value.detectedAt
  };
}

const hourStartOf = (createdMs: number): number => Math.floor(createdMs / HOUR_MS) * HOUR_MS;

export function partitionOf(createdMs: number): { day: string; hour: string } {
  const iso = new Date(createdMs).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
}

export async function listDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/** The complete lines of a file: bytes after the last newline are a torn write and belong to no line. */
async function completeLines(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const end = text.lastIndexOf('\n');
  return end < 0 ? [] : text.slice(0, end).split('\n');
}

// ---------------------------------------------------------------------------------------------
// Partitions and the line index

export type Partition = Readonly<{
  day: string;
  hour: string;
  startMs: number;
  /** Every writer's file of this hour, in writer-id order. */
  files: readonly string[];
}>;

export async function listDays(objectDir: string): Promise<string[]> {
  return (await listDirectory(objectDir))
    .filter(entry => entry.isDirectory() && PARTITION_DAY.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .reverse();
}

export async function listHours(objectDir: string, day: string): Promise<Partition[]> {
  const byHour = new Map<string, string[]>();
  for (const entry of await listDirectory(path.join(objectDir, day))) {
    const match = entry.isFile() ? PARTITION_FILE.exec(entry.name) : null;
    if (!match) continue;
    const files = byHour.get(match[1]!) ?? [];
    files.push(path.join(objectDir, day, entry.name));
    byHour.set(match[1]!, files);
  }
  return [...byHour]
    .map(([hour, files]) => ({ day, hour, startMs: Date.parse(`${day}T${hour}:00:00.000Z`), files: files.sort() }))
    .filter(partition => Number.isFinite(partition.startMs))
    .sort((a, b) => b.startMs - a.startMs);
}

/** Hour partitions, newest first, one day directory listed at a time. A partition outside the range is not listed. */
async function* partitionsNewestFirst(
  objectDir: string,
  range: { latestStartMs?: number; earliestEndMs?: number } = {}
): AsyncGenerator<Partition> {
  for (const day of await listDays(objectDir)) {
    const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isNaN(dayStartMs)) continue;
    if (range.latestStartMs !== undefined && dayStartMs > range.latestStartMs) continue;
    if (range.earliestEndMs !== undefined && dayStartMs + DAY_MS <= range.earliestEndMs) return;
    for (const partition of await listHours(objectDir, day)) {
      if (range.latestStartMs !== undefined && partition.startMs > range.latestStartMs) continue;
      if (range.earliestEndMs !== undefined && partition.startMs + HOUR_MS <= range.earliestEndMs) return;
      yield partition;
    }
  }
}

export async function allPartitions(objectDir: string): Promise<Partition[]> {
  const partitions: Partition[] = [];
  for await (const partition of partitionsNewestFirst(objectDir)) partitions.push(partition);
  return partitions;
}

type IndexedLine = Readonly<{ position: EventPosition; offset: number; length: number }>;
/** The complete lines of a file up to `bytesIndexed`. Immutable, so a refresh never changes a snapshot a scan holds. */
type FileIndex = Readonly<{ bytesIndexed: number; lines: readonly IndexedLine[] }>;

const EMPTY_INDEX: FileIndex = { bytesIndexed: 0, lines: [] };

/**
 * Reads only the bytes past `base.bytesIndexed`, up to the last newline: a torn tail from a crashed
 * writer is never indexed (that writer never appends again, I1). A line that does not parse is skipped.
 */
async function extendIndex(file: string, base: FileIndex): Promise<FileIndex> {
  let handle: FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch (error) {
    if (isNotFound(error)) return EMPTY_INDEX;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const from = size < base.bytesIndexed ? EMPTY_INDEX : base;
    if (size === from.bytesIndexed) return from;
    const added: IndexedLine[] = [];
    let offset = from.bytesIndexed;
    let carry: Buffer = Buffer.alloc(0);
    while (offset + carry.length < size) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - offset - carry.length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset + carry.length);
      if (bytesRead === 0) break;
      const buffer = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let newline = buffer.indexOf(0x0a); newline !== -1; newline = buffer.indexOf(0x0a, start)) {
        const position = parseDataLine(buffer.toString('utf8', start, newline));
        if (position) added.push({ position, offset: offset + start, length: newline - start });
        start = newline + 1;
      }
      carry = Buffer.from(buffer.subarray(start));
      offset += start;
    }
    return { bytesIndexed: offset, lines: added.length ? [...from.lines, ...added] : from.lines };
  } finally {
    await handle.close();
  }
}

export class LineIndex {
  private readonly files = new Map<string, FileIndex>();
  private lineCount = 0;

  async of(file: string): Promise<FileIndex> {
    const next = await extendIndex(file, this.files.get(file) ?? EMPTY_INDEX);
    this.remember(file, next);
    return next;
  }

  forgetUnder(directory: string): void {
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(directory + path.sep)) this.remember(file, undefined);
    }
  }

  private remember(file: string, index: FileIndex | undefined): void {
    this.lineCount -= this.files.get(file)?.lines.length ?? 0;
    this.files.delete(file);
    if (index === undefined) return;
    this.files.set(file, index);
    this.lineCount += index.lines.length;
    for (const oldest of this.files.keys()) {
      if (this.lineCount <= INDEX_CACHE_MAX_LINES || this.files.size <= 1) break;
      this.lineCount -= this.files.get(oldest)?.lines.length ?? 0;
      this.files.delete(oldest);
    }
  }
}

type Copy = Readonly<{ position: EventPosition; file: string; offset: number; length: number }>;

/** I3 inside one hour: one copy per uuid, the smallest seq, newest first. */
export async function keptCopies(index: LineIndex, partition: Partition): Promise<Copy[]> {
  const byUuid = new Map<EventUuid, Copy>();
  for (const file of partition.files) {
    for (const line of (await index.of(file)).lines) {
      const kept = byUuid.get(line.position.uuid);
      if (!kept || line.position.seq < kept.position.seq) byUuid.set(line.position.uuid, { ...line, file });
    }
  }
  return [...byUuid.values()].sort((a, b) => compareNewestFirst(a.position, b.position));
}

export function toStoredEvent(
  position: EventPosition,
  createdDate: string,
  payload: Readonly<Record<string, unknown>>
): StoredEvent {
  return { position, id: eventRowId(position), createdDate, record: { ...payload, CreatedDate: createdDate } };
}

/** Reads one indexed line back. A line that vanished or no longer parses (purge, a foreign edit) is skipped. */
export async function readStoredEvent(handles: Map<string, FileHandle>, copy: Copy): Promise<StoredEvent | undefined> {
  try {
    let handle = handles.get(copy.file);
    if (!handle) {
      handle = await fs.open(copy.file, 'r');
      handles.set(copy.file, handle);
    }
    const buffer = Buffer.allocUnsafe(copy.length);
    const { bytesRead } = await handle.read(buffer, 0, copy.length, copy.offset);
    if (bytesRead !== copy.length) return undefined;
    const line = JSON.parse(buffer.toString('utf8')) as unknown;
    if (!isRecord(line) || typeof line.createdDate !== 'string') return undefined;
    return toStoredEvent(copy.position, line.createdDate, isRecord(line.payload) ? line.payload : {});
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function closeAll(handles: Map<string, FileHandle>): Promise<void> {
  const open = [...handles.values()];
  handles.clear();
  await Promise.all(open.map(handle => handle.close()));
}

export async function* scanNewestFirst(
  objectDir: string,
  index: LineIndex,
  options: { before?: EventPosition; sinceMs?: number; untilMs?: number }
): AsyncGenerator<StoredEvent> {
  const { before, sinceMs, untilMs } = options;
  const cursorHourStart = before === undefined ? undefined : hourStartOf(before.createdMs);
  const latestStartMs = Math.min(cursorHourStart ?? Infinity, untilMs === undefined ? Infinity : untilMs - 1);
  const seen = new Set<EventUuid>();
  const range = {
    ...(latestStartMs === Infinity ? {} : { latestStartMs }),
    ...(sinceMs === undefined ? {} : { earliestEndMs: sinceMs })
  };
  for await (const partition of partitionsNewestFirst(objectDir, range)) {
    const handles = new Map<string, FileHandle>();
    try {
      for (const copy of await keptCopies(index, partition)) {
        const { position } = copy;
        if (
          before !== undefined &&
          partition.startMs === cursorHourStart &&
          compareNewestFirst(position, before) <= 0
        ) {
          seen.add(position.uuid);
          continue;
        }
        if (sinceMs !== undefined && position.createdMs < sinceMs) return;
        if (seen.has(position.uuid) || (untilMs !== undefined && position.createdMs >= untilMs)) continue;
        const event = await readStoredEvent(handles, copy);
        if (!event) continue;
        seen.add(position.uuid);
        yield event;
      }
    } finally {
      await closeAll(handles);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Gaps

type GapFile = Readonly<{ file: string; lines: readonly GapLine[] }>;
type FoldedGap = OpenGap & { before?: string };

export async function readGapFiles(objectDir: string): Promise<GapFile[]> {
  const entries = (await listDirectory(objectDir)).filter(entry => entry.isFile() && GAP_FILE.test(entry.name));
  return Promise.all(
    entries.map(async entry => {
      const file = path.join(objectDir, entry.name);
      const lines = (await completeLines(file)).flatMap(text => parseGapLine(text) ?? []);
      return { file, lines };
    })
  );
}

/** Opens first, then closes by id, so the result does not depend on which writer's file is read first. Newest first. */
export function foldGaps(files: readonly GapFile[]): FoldedGap[] {
  const gaps = new Map<string, FoldedGap>();
  for (const { lines } of files) {
    for (const line of lines) {
      if (line.op === 'open' && !gaps.has(line.id)) {
        gaps.set(line.id, {
          id: line.id,
          reason: line.reason,
          ...(line.after !== undefined ? { after: line.after } : {}),
          detectedAt: line.detectedAt
        });
      }
    }
  }
  for (const { lines } of files) {
    for (const line of lines) {
      if (line.op !== 'close') continue;
      const gap = gaps.get(line.id);
      if (gap && gap.before === undefined) gap.before = line.before;
    }
  }
  return [...gaps.values()].sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0));
}

export const openGapOf = ({ id, reason, after, detectedAt }: FoldedGap): OpenGap => ({
  id,
  reason,
  ...(after !== undefined ? { after } : {}),
  detectedAt
});
