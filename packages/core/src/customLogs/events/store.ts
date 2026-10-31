/**
 * The local event store: the only code that knows the `events/` layout. Keyed by event OBJECT, not
 * by source id: a source is a view (a mapping) over an object's raw events, so a remap, a renamed
 * source or two sources over one object all read one history and share one subscription.
 *
 *   <root>/apexlogs/orgs/<safeUsername>/events/
 *     format.json                        {"version":1}, create-if-absent; any other value is CUSTOM_LOG_STORE_UNAVAILABLE
 *     .gitignore                         "*", written with format.json: the store ignores itself and never depends on the root .gitignore
 *     <Object__e>/                       describe casing, a safe path segment
 *       describe.json                    the capturing user's ObjectDescribe; written before any event
 *       checkpoint.json                  EventCheckpoint
 *       gaps.<writer>.ndjson             GapLine per line (open, then close); one file per writer, folded together at read (I1)
 *       capture.lease                    LeaseOwner (workspaceFs.ts)
 *       <YYYY-MM-DD>/<HH>.<writer>.ndjson   StoredEventLine per line; day and hour of CreatedDate, UTC
 *
 * Sibling of `logs/`, so every Apex-log walker (lookup, count, purge, org discovery) ignores it,
 * `.alv/version.json` stays "1", and `sync-state.json` is untouched (no `log status` change).
 *
 * Invariants:
 *   I1  Each data file and each gap file has exactly one writer for its whole life (writer id in the
 *       name). No file is ever rewritten in place; purge deletes whole day directories and whole gap files.
 *   I2  A checkpoint is written only after the events before it are on disk (`datasync`), and only
 *       by the lease holder (fenced by `stillHeld()` immediately before the write), so
 *       `checkpoint.cursor` never points past stored data. A process crash re-delivers, never loses.
 *       Scope: a process crash. For an OS crash the appender and the checkpoint writer also fsync the
 *       parent directory when a file is created or renamed, and this store fsyncs the parent of every
 *       directory it creates before the first append in it (workspaceFs.ts `syncDirectory`: best effort
 *       on win32 only; a failure anywhere else retires the writer). macOS F_FULLFSYNC is not used, so a
 *       power loss on macOS can still lose the last flush. A writer runs one operation at a time, so an
 *       `advance` never overtakes the `append` before it. A writer whose append failed never writes again.
 *   I3  Readers dedupe by uuid: inside one hour partition the copy with the smallest seq is kept;
 *       across the partitions of one scan a uuid set keeps the first kept copy; a page cursor seeds
 *       that set with every kept uuid at or above it in its hour, and newer hours are not read. So
 *       same-hour copies merge on every page, and copies whose CreatedDate hours differ merge inside
 *       one scan but not across pages. Order is EventPosition. Two writers across a lease handover, a
 *       crash replay, a `-2` replay over stored events, or a publisher duplicate all read back as one event.
 *   I4  Stored payloads hold every delivered field except nulls (events ignore FLS, and raw history
 *       must survive remaps). Reads gate through `describe.json`: a mapped field it does not list is
 *       `hidden`. A missing key reads as null, which the decoders treat as empty.
 *   I5  At most one gap is open at a time, across every writer's gap file. Opening while one is open
 *       returns it with `created: false`, so a crash between "open" and "resubscribe" converges on
 *       the next start and an old open gap is never counted as new.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { AlvError } from '../../errors.js';
import {
  LeaseUnreadableError,
  ensureRealDirectoryPath,
  openDurableAppender,
  orgDirectory,
  regularFileExists,
  syncDirectory,
  tryAcquireLease,
  writeFileAtomic,
  writeJsonAtomic,
  type DurableAppender,
  type Lease
} from '../../localStore/workspaceFs.js';
import { customLogError } from '../errors.js';
import type { ObjectDescribe } from '../schema.js';
import { isCaptureSeq, type CaptureSeq, type EventPosition, type EventUuid, type ReplayCursor } from './ids.js';
import {
  DAY_MS,
  FORMAT_VERSION,
  HOUR_MS,
  LineIndex,
  allPartitions,
  closeAll,
  createdMsOf,
  foldGaps,
  isNotFound,
  isRecord,
  keptCopies,
  listDays,
  listDirectory,
  listHours,
  openGapOf,
  parseCheckpoint,
  parseObjectDescribe,
  partitionOf,
  readGapFiles,
  readStoredEvent,
  scanNewestFirst,
  toStoredEvent,
  type EventCheckpoint,
  type GapLine,
  type GapReason,
  type OpenGap,
  type Partition,
  type StoredEvent,
  type StoredEventLine
} from './storeFiles.js';
import type { BusEvent } from './transport.js';

export type { EventCheckpoint, GapLine, GapReason, OpenGap, StoredEvent, StoredEventLine } from './storeFiles.js';

export type EventStoreLocation = Readonly<{
  /** Directory of the project's `sfdx-project.json`, else the adapter's `projectDir`. Never os.tmpdir(). */
  root: string;
  /** Resolved username: the same org directory Apex logs use. */
  username: string;
  /** Describe casing. */
  object: string;
}>;

export type StoreScan = {
  /**
   * Newest first, deduped over the whole scan, strictly older than `before` when given, with
   * `sinceMs <= CreatedDate < untilMs` (the record path's `>=` and `<`). Lazy: reads one hour partition at a time.
   */
  newestFirst(options: { before?: EventPosition; sinceMs?: number; untilMs?: number }): AsyncIterable<StoredEvent>;
  /** Events whose CreatedDate falls in [fromMs, toMs], ascending, deduped. `get` uses it for a transaction's neighborhood. */
  window(fromMs: number, toMs: number): Promise<StoredEvent[]>;
  /** By uuid, in the hour of `position.createdMs`, so the id of any stored copy resolves to the kept copy. */
  find(position: EventPosition): Promise<StoredEvent | undefined>;
};

export type StoreCoverage =
  | { state: 'notCaptured'; eventsRoot: string }
  | {
      state: 'captured';
      eventsRoot: string;
      oldest?: string;
      newest?: string;
      lastCaptureAt: string;
      sizeBytes: number;
      gaps: { reason: GapReason; after?: string; before?: string; detectedAt: string }[];
    };

export type LeaseHolder = { surface: 'vscode' | 'cli'; pid: number; host: string; since: string };

export type EventStore = StoreScan & {
  readonly location: EventStoreLocation;
  readonly eventsRoot: string;
  describe(): Promise<ObjectDescribe | undefined>;
  checkpoint(): Promise<EventCheckpoint | undefined>;
  /** `notCaptured` until a checkpoint exists. */
  coverage(): Promise<StoreCoverage>;
  /**
   * Lease, then a writer. `heldBy` means another live process captures this object. Throws
   * CUSTOM_LOG_STORE_UNAVAILABLE for an unreadable lease or a newer format. The writer starts with its
   * uuid memory and `nextSeq` seeded from every writer's data files whose mtime is at or after
   * `checkpoint.updatedAt` (every data file when there is no checkpoint), so a crash or takeover
   * re-delivery is dropped before it is written and no seq is reused.
   */
  openWriter(surface: 'vscode' | 'cli'): Promise<{ writer: EventStoreWriter } | { heldBy: LeaseHolder }>;
};

export type AppendResult = {
  /** Events this call wrote (in-batch duplicates, in-session duplicates and re-deliveries the seeded memory already holds excluded), in delivery order, each with its allocated seq. */
  stored: readonly StoredEvent[];
  duplicates: number;
};

/** Thrown by `advance` when the lease no longer carries this writer's token. The run goes standby. */
export class LeaseLostError extends Error {
  constructor() {
    super('capture lease lost');
  }
}

export type EventStoreWriter = {
  readonly writerId: string;
  /** Writes `describe.json` when it differs from the stored one. Called in prepare, before any append, so `list` can resolve columns and gate fields through it from the first event. */
  writeDescribe(describe: ObjectDescribe): Promise<void>;
  /**
   * Drops null payload keys and keeps every other key (I4), allocates seqs, appends to
   * `<day>/<HH>.<writer>.ndjson` per event, `datasync`s every touched file. Rejects with
   * CUSTOM_LOG_STORE_UNAVAILABLE (naming the file) when an append fails; the writer is then retired:
   * every later call rejects, the batch was not checkpointed, and the next run (new writer id, new
   * files) re-delivers it. A partial write is never followed by a retry in the same file.
   */
  append(events: readonly BusEvent[]): Promise<AppendResult>;
  /**
   * Only after `append` resolved for the events up to `cursor` (I2). `cursor` is the last DELIVERED
   * event's cursor, duplicates included, so a duplicate-only batch still advances the resume point.
   * Re-reads the lease immediately before the atomic write; throws LeaseLostError when it is not held.
   */
  advance(checkpoint: {
    orgId: string;
    transport: 'cometd' | 'pubsub';
    channel: string;
    cursor: ReplayCursor;
    lastEvent: { createdDate: string; uuid: EventUuid };
  }): Promise<void>;
  /** Appends an `open` line to this writer's gap file and `datasync`s it BEFORE the caller resubscribes. `created: false` with the already open gap when one exists, in any writer's file (I5). */
  openGap(gap: { reason: GapReason; after?: string }): Promise<{ gap: OpenGap; created: boolean }>;
  /** The open gap, if any (also one left by an earlier run). */
  openGapNow(): Promise<OpenGap | undefined>;
  /** Appends a `close` line for the open gap to this writer's gap file, whichever writer opened it. No-op when none is open. */
  closeOpenGap(before: string): Promise<void>;
  /**
   * Deletes day directories whose date is older than `now - days` (by name, not mtime), a gap file only
   * when every gap it mentions closed before the oldest kept day, and `*.tmp` files left by a crash.
   * Never rewrites a file (I1). Returns how many day directories it deleted.
   */
  purge(days: number, now: Date): Promise<number>;
  /** Closes the writer's files and gives the lease back. Idempotent. */
  release(): Promise<void>;
};

const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*__e$/;
/** In-session dedupe window: re-deliveries after an in-session reconnect are skipped before writing. */
const SESSION_UUID_MEMORY = 50_000;
/** A file system may round mtime down by seconds; files modified this close before a checkpoint are seeded too. */
const MTIME_SLACK_MS = 2_000;
/** A temporary file this old belongs to no live write: the longest write is a few milliseconds. */
const STALE_TMP_MS = HOUR_MS;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

const storeUnavailable = (message: string): AlvError => customLogError('CUSTOM_LOG_STORE_UNAVAILABLE', message);

/** Runs a file system step; a failure that is not already a Custom Logs error becomes STORE_UNAVAILABLE naming the file. */
async function orUnavailable<T>(what: string, file: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AlvError) throw error;
    throw storeUnavailable(`${what} ${file}: ${messageOf(error)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Layout

type Layout = Readonly<{
  root: string;
  eventsDir: string;
  objectDir: string;
  formatFile: string;
  ignoreFile: string;
  describeFile: string;
  checkpointFile: string;
  leaseFile: string;
}>;

function layoutOf(location: EventStoreLocation): Layout {
  const eventsDir = path.join(orgDirectory(location.root, location.username), 'events');
  const objectDir = path.join(eventsDir, location.object);
  return {
    root: location.root,
    eventsDir,
    objectDir,
    formatFile: path.join(eventsDir, 'format.json'),
    ignoreFile: path.join(eventsDir, '.gitignore'),
    describeFile: path.join(objectDir, 'describe.json'),
    checkpointFile: path.join(objectDir, 'checkpoint.json'),
    leaseFile: path.join(objectDir, 'capture.lease')
  };
}

const dataFileOf = (layout: Layout, createdMs: number, writerId: string): string => {
  const { day, hour } = partitionOf(createdMs);
  return path.join(layout.objectDir, day, `${hour}.${writerId}.ndjson`);
};

/**
 * Creates `target` and every missing directory above it below `root`, and fsyncs the parent of each
 * directory it created, so no file is appended into a directory whose own name could vanish in an OS crash.
 */
async function ensureDirectory(root: string, target: string): Promise<void> {
  const missing: string[] = [];
  for (
    let directory = target;
    !(await ensureRealDirectoryPath(root, directory, false));
    directory = path.dirname(directory)
  ) {
    missing.unshift(directory);
  }
  for (const directory of missing) {
    await ensureRealDirectoryPath(root, directory, true);
    await syncDirectory(path.dirname(directory));
  }
}

async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    if (!(await regularFileExists(file))) return undefined;
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw storeUnavailable(`Cannot read ${file}: ${messageOf(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw storeUnavailable(
      `${file} is not valid JSON. Delete it if no capture is running; the next capture writes it again.`
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The writer

/** Insertion-ordered set that forgets its oldest uuid past `limit`. */
class RecentUuids {
  private readonly uuids = new Set<EventUuid>();

  constructor(private readonly limit: number) {}

  has(uuid: EventUuid): boolean {
    return this.uuids.has(uuid);
  }

  add(uuid: EventUuid): void {
    this.uuids.delete(uuid);
    this.uuids.add(uuid);
    if (this.uuids.size > this.limit) {
      const oldest = this.uuids.values().next();
      if (!oldest.done) this.uuids.delete(oldest.value);
    }
  }
}

type WriterStart = Readonly<{
  recent: RecentUuids;
  nextSeq: number;
  openGaps: readonly OpenGap[];
}>;

const withoutNulls = (payload: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== null && value !== undefined));

function createWriter(layout: Layout, index: LineIndex, lease: Lease, start: WriterStart): EventStoreWriter {
  const writerId = randomBytes(4).toString('hex');
  const gapFile = path.join(layout.objectDir, `gaps.${writerId}.ndjson`);
  const appenders = new Map<string, DurableAppender>();
  const openGaps = new Map(start.openGaps.map(gap => [gap.id, gap]));
  const { recent } = start;
  let nextSeq = start.nextSeq;
  let retired: AlvError | undefined;
  let released = false;
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(step: () => Promise<T>): Promise<T> => {
    const result = queue.then(step);
    queue = result.catch(() => undefined);
    return result;
  };

  const usable = (): void => {
    if (retired) throw retired;
    if (released) throw new Error('This event store writer was released.');
  };

  const takeSeq = (): CaptureSeq => {
    const seq = nextSeq;
    if (!isCaptureSeq(seq)) throw storeUnavailable('The capture sequence of this store is exhausted.');
    nextSeq += 1;
    return seq;
  };

  const appenderFor = async (file: string): Promise<DurableAppender> => {
    const known = appenders.get(file);
    if (known) return known;
    await ensureDirectory(layout.root, path.dirname(file));
    const appender = await openDurableAppender(layout.root, file);
    appenders.set(file, appender);
    return appender;
  };

  const appendOrRetire = async (file: string, text: string): Promise<void> => {
    try {
      await (await appenderFor(file)).append(text);
    } catch (error) {
      retired = storeUnavailable(
        `Appending to ${file} failed (${messageOf(error)}). Capture stopped and did not checkpoint the batch; the next run stores it again.`
      );
      throw retired;
    }
  };

  const newestOpenGap = (): OpenGap | undefined =>
    [...openGaps.values()].sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : -1))[0];

  const gapLine = (line: GapLine): Promise<void> => appendOrRetire(gapFile, `${JSON.stringify(line)}\n`);

  const purgeableGapFiles = async (cutoffMs: number): Promise<string[]> => {
    const files = await readGapFiles(layout.objectDir);
    const closedBefore = new Map<string, number>();
    for (const { lines } of files) {
      for (const line of lines) if (line.op === 'close') closedBefore.set(line.id, Date.parse(line.before));
    }
    const purgeable = (id: string): boolean => (closedBefore.get(id) ?? Infinity) < cutoffMs;
    return files
      .filter(({ file, lines }) => file !== gapFile && lines.every(line => purgeable(line.id)))
      .map(({ file }) => file);
  };

  const removeStaleTemporaryFiles = async (now: Date): Promise<void> => {
    for (const entry of await listDirectory(layout.objectDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
      const file = path.join(layout.objectDir, entry.name);
      const stat = await fs.lstat(file).catch(() => undefined);
      if (stat && now.getTime() - stat.mtimeMs > STALE_TMP_MS) await fs.rm(file, { force: true });
    }
  };

  const closeAppendersUnder = async (directory: string): Promise<void> => {
    for (const [file, appender] of [...appenders]) {
      if (!file.startsWith(directory + path.sep)) continue;
      appenders.delete(file);
      await appender.close();
    }
  };

  return {
    writerId,

    writeDescribe: describe =>
      enqueue(async () => {
        usable();
        const text = `${JSON.stringify(describe, null, 2)}\n`;
        await orUnavailable('Cannot write', layout.describeFile, async () => {
          const stored = await fs.readFile(layout.describeFile, 'utf8').catch(error => {
            if (isNotFound(error)) return undefined;
            throw error;
          });
          if (stored !== text) await writeJsonAtomic(layout.describeFile, describe, { syncDirectory: true });
        });
      }),

    append: events =>
      enqueue(async () => {
        usable();
        const fresh: { event: BusEvent; createdMs: number }[] = [];
        const inBatch = new Set<EventUuid>();
        for (const event of events) {
          if (inBatch.has(event.uuid) || recent.has(event.uuid)) continue;
          inBatch.add(event.uuid);
          const createdMs = createdMsOf(event.createdDate);
          if (createdMs === undefined) {
            throw new RangeError(`Event ${event.uuid} carries no usable CreatedDate: ${event.createdDate}`);
          }
          fresh.push({ event, createdMs });
        }

        const receivedAt = new Date().toISOString();
        const stored: StoredEvent[] = [];
        const texts = new Map<string, string[]>();
        for (const { event, createdMs } of fresh) {
          const position: EventPosition = { createdMs, seq: takeSeq(), uuid: event.uuid };
          const payload = withoutNulls(event.payload);
          const storedEvent = toStoredEvent(position, event.createdDate, payload);
          const line: StoredEventLine = {
            v: 1,
            id: storedEvent.id,
            uuid: event.uuid,
            seq: position.seq,
            replayId: event.cursor,
            createdDate: event.createdDate,
            receivedAt,
            payload
          };
          const file = dataFileOf(layout, createdMs, writerId);
          const fileLines = texts.get(file) ?? [];
          fileLines.push(JSON.stringify(line));
          texts.set(file, fileLines);
          stored.push(storedEvent);
        }
        for (const [file, fileLines] of texts) await appendOrRetire(file, `${fileLines.join('\n')}\n`);
        for (const event of stored) recent.add(event.position.uuid);
        return { stored, duplicates: events.length - fresh.length };
      }),

    advance: checkpoint =>
      enqueue(async () => {
        usable();
        if (!(await lease.stillHeld())) throw new LeaseLostError();
        const written: EventCheckpoint = {
          version: FORMAT_VERSION,
          orgId: checkpoint.orgId,
          transport: checkpoint.transport,
          channel: checkpoint.channel,
          cursor: checkpoint.cursor,
          lastEvent: checkpoint.lastEvent,
          nextSeq,
          updatedAt: new Date().toISOString(),
          writer: writerId
        };
        await orUnavailable('Cannot write', layout.checkpointFile, () =>
          writeJsonAtomic(layout.checkpointFile, written, { syncDirectory: true })
        );
      }),

    openGap: gap =>
      enqueue(async () => {
        usable();
        const existing = newestOpenGap();
        if (existing) return { gap: existing, created: false };
        const opened: OpenGap = {
          id: randomBytes(8).toString('hex'),
          reason: gap.reason,
          ...(gap.after !== undefined ? { after: gap.after } : {}),
          detectedAt: new Date().toISOString()
        };
        await gapLine({ v: 1, op: 'open', ...opened });
        openGaps.set(opened.id, opened);
        return { gap: opened, created: true };
      }),

    openGapNow: () =>
      enqueue(async () => {
        usable();
        return newestOpenGap();
      }),

    closeOpenGap: before =>
      enqueue(async () => {
        usable();
        for (const { id } of [...openGaps.values()]) {
          await gapLine({ v: 1, op: 'close', id, before });
          openGaps.delete(id);
        }
      }),

    purge: (days, now) =>
      enqueue(async () => {
        usable();
        const cutoffDay = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
        let removed = 0;
        for (const day of await listDays(layout.objectDir)) {
          if (day >= cutoffDay) continue;
          const directory = path.join(layout.objectDir, day);
          await closeAppendersUnder(directory);
          await fs.rm(directory, { recursive: true, force: true });
          index.forgetUnder(directory);
          removed += 1;
        }
        for (const file of await purgeableGapFiles(Date.parse(`${cutoffDay}T00:00:00.000Z`))) {
          await fs.rm(file, { force: true });
        }
        await removeStaleTemporaryFiles(now);
        return removed;
      }),

    release: () =>
      enqueue(async () => {
        if (released) return;
        released = true;
        const open = [...appenders.values()];
        appenders.clear();
        const closed = await Promise.allSettled(open.map(appender => appender.close()));
        await lease.release();
        for (const result of closed) if (result.status === 'rejected') throw result.reason;
      })
  };
}

// ---------------------------------------------------------------------------------------------
// The store

export function openEventStore(location: EventStoreLocation): EventStore {
  if (!OBJECT_NAME.test(location.object)) {
    throw customLogError(
      'INVALID_ARGUMENT',
      `"${location.object}" is not a platform event API name such as App_Log__e.`
    );
  }
  const layout = layoutOf(location);
  const index = new LineIndex();

  /** False when the object has no directory yet. Refuses symlinks along the way and a format this version cannot read. */
  const readable = async (): Promise<boolean> => {
    const exists = await orUnavailable('Cannot use', layout.objectDir, () =>
      ensureRealDirectoryPath(layout.root, layout.objectDir, false)
    );
    const format = await readJsonFile(layout.formatFile);
    if (format !== undefined && (!isRecord(format) || format.version !== FORMAT_VERSION)) {
      throw storeUnavailable(
        `${layout.formatFile} was written by a newer version of Apex Log Viewer than this one reads. Update it, or move ${layout.eventsDir} away to start a new store.`
      );
    }
    return exists;
  };

  const readCheckpoint = async (): Promise<EventCheckpoint | undefined> => {
    const value = await readJsonFile(layout.checkpointFile);
    if (value === undefined) return undefined;
    const checkpoint = parseCheckpoint(value);
    if (!checkpoint) {
      throw storeUnavailable(
        `${layout.checkpointFile} is not a capture checkpoint. Delete it if no capture is running; the next capture starts from the first-use choice.`
      );
    }
    return checkpoint;
  };

  /** Uuids and sequences of every file that may hold events the checkpoint does not cover. */
  const seedWriter = async (checkpoint: EventCheckpoint | undefined): Promise<WriterStart> => {
    const recent = new RecentUuids(SESSION_UUID_MEMORY);
    let nextSeq = checkpoint?.nextSeq ?? 0;
    const sinceMs = checkpoint === undefined ? undefined : Date.parse(checkpoint.updatedAt) - MTIME_SLACK_MS;
    for (const partition of (await allPartitions(layout.objectDir)).reverse()) {
      for (const file of partition.files) {
        if (sinceMs !== undefined && (await fs.stat(file)).mtimeMs < sinceMs) continue;
        for (const { position } of (await index.of(file)).lines) {
          recent.add(position.uuid);
          nextSeq = Math.max(nextSeq, position.seq + 1);
        }
      }
    }
    const openGaps = foldGaps(await readGapFiles(layout.objectDir))
      .filter(gap => gap.before === undefined)
      .map(openGapOf);
    return { recent, nextSeq, openGaps };
  };

  const extremes = async (partition: Partition): Promise<{ min: number; max: number } | undefined> => {
    let min = Infinity;
    let max = -Infinity;
    for (const file of partition.files) {
      for (const { position } of (await index.of(file)).lines) {
        min = Math.min(min, position.createdMs);
        max = Math.max(max, position.createdMs);
      }
    }
    return min === Infinity ? undefined : { min, max };
  };

  const sizeOf = async (file: string): Promise<number> => (await fs.stat(file).catch(() => undefined))?.size ?? 0;

  async function* newestFirst(options: Parameters<StoreScan['newestFirst']>[0]): AsyncGenerator<StoredEvent> {
    if (!(await readable())) return;
    yield* scanNewestFirst(layout.objectDir, index, options);
  }

  return {
    location,
    eventsRoot: layout.objectDir,

    async describe() {
      if (!(await readable())) return undefined;
      const value = await readJsonFile(layout.describeFile);
      if (value === undefined) return undefined;
      const describe = parseObjectDescribe(value);
      if (!describe) {
        throw storeUnavailable(
          `${layout.describeFile} is not a stored object describe. Delete it; the next capture writes it again.`
        );
      }
      return describe;
    },

    async checkpoint() {
      return (await readable()) ? readCheckpoint() : undefined;
    },

    async coverage() {
      if (!(await readable())) return { state: 'notCaptured', eventsRoot: layout.objectDir };
      const checkpoint = await readCheckpoint();
      if (!checkpoint) return { state: 'notCaptured', eventsRoot: layout.objectDir };
      const partitions = await allPartitions(layout.objectDir);
      let sizeBytes = 0;
      for (const partition of partitions) {
        for (const file of partition.files) sizeBytes += await sizeOf(file);
      }
      let newest: number | undefined;
      for (const partition of partitions) {
        newest = (await extremes(partition))?.max;
        if (newest !== undefined) break;
      }
      let oldest: number | undefined;
      for (const partition of [...partitions].reverse()) {
        oldest = (await extremes(partition))?.min;
        if (oldest !== undefined) break;
      }
      return {
        state: 'captured',
        eventsRoot: layout.objectDir,
        ...(oldest !== undefined ? { oldest: new Date(oldest).toISOString() } : {}),
        ...(newest !== undefined ? { newest: new Date(newest).toISOString() } : {}),
        lastCaptureAt: checkpoint.updatedAt,
        sizeBytes,
        gaps: foldGaps(await readGapFiles(layout.objectDir)).map(gap => ({
          reason: gap.reason,
          ...(gap.after !== undefined ? { after: gap.after } : {}),
          ...(gap.before !== undefined ? { before: gap.before } : {}),
          detectedAt: gap.detectedAt
        }))
      };
    },

    newestFirst,

    async window(fromMs, toMs) {
      const events: StoredEvent[] = [];
      for await (const event of newestFirst({ sinceMs: fromMs, untilMs: toMs + 1 })) events.push(event);
      return events.reverse();
    },

    async find(position) {
      if (!(await readable())) return undefined;
      const { day, hour } = partitionOf(position.createdMs);
      const partition = (await listHours(layout.objectDir, day)).find(candidate => candidate.hour === hour);
      if (!partition) return undefined;
      const copy = (await keptCopies(index, partition)).find(candidate => candidate.position.uuid === position.uuid);
      if (!copy) return undefined;
      const handles = new Map<string, FileHandle>();
      try {
        return await readStoredEvent(handles, copy);
      } finally {
        await closeAll(handles);
      }
    },

    async openWriter(surface) {
      await readable();
      await orUnavailable('Cannot create', layout.objectDir, () => ensureDirectory(layout.root, layout.objectDir));
      let attempt: Awaited<ReturnType<typeof tryAcquireLease>>;
      try {
        attempt = await tryAcquireLease(layout.root, layout.leaseFile, surface);
      } catch (error) {
        throw error instanceof LeaseUnreadableError ? storeUnavailable(error.message) : error;
      }
      if ('heldBy' in attempt) {
        const { surface: heldSurface, pid, host, startedAt } = attempt.heldBy;
        return { heldBy: { surface: heldSurface, pid, host, since: startedAt } };
      }
      const { acquired: lease } = attempt;
      try {
        await orUnavailable('Cannot write', layout.eventsDir, async () => {
          await writeFileAtomic(layout.formatFile, `${JSON.stringify({ version: FORMAT_VERSION })}\n`, true, {
            syncDirectory: true
          });
          await writeFileAtomic(layout.ignoreFile, '*\n', true, { syncDirectory: true });
        });
        const start = await seedWriter(await readCheckpoint());
        return { writer: createWriter(layout, index, lease, start) };
      } catch (error) {
        // The failure that stopped the open is the one to report, not a failure to give the lease back.
        await lease.release().catch(() => undefined);
        throw error;
      }
    }
  };
}
