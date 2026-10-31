import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  cometdCursor,
  parseEventUuid,
  type CaptureSeq,
  type EventPosition,
  type EventUuid
} from '../src/customLogs/events/ids.ts';
import {
  LeaseLostError,
  openEventStore,
  type EventStore,
  type EventStoreWriter,
  type StoredEvent
} from '../src/customLogs/events/store.ts';
import type { BusEvent } from '../src/customLogs/events/transport.ts';
import { logEntryEventDescribe } from './support/describeFixtures.ts';

const fsp = fs.promises;

const USER = 'dev@example.com';
const OBJECT = 'App_Log__e';
const ORG_ID = '00D000000000001AAA';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-30T10:00:00.000Z');
const UNAVAILABLE = { code: 'CUSTOM_LOG_STORE_UNAVAILABLE' };

const openedWriters: EventStoreWriter[] = [];

async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alv-event-store-'));
  try {
    await run(root);
  } finally {
    await Promise.all(openedWriters.splice(0).map(writer => writer.release()));
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const openStore = (root: string, object = OBJECT): EventStore => openEventStore({ root, username: USER, object });
const orgDirOf = (root: string): string => path.join(root, 'apexlogs', 'orgs', USER);
const eventsDirOf = (root: string): string => path.join(orgDirOf(root), 'events');
const objectDirOf = (root: string): string => path.join(eventsDirOf(root), OBJECT);

const uuidOf = (n: number): EventUuid => {
  const uuid = parseEventUuid(`00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`);
  assert.ok(uuid);
  return uuid;
};

function busEvent(
  n: number,
  options: { createdMs?: number; cursor?: number; payload?: Record<string, unknown> } = {}
): BusEvent {
  const createdDate = new Date(options.createdMs ?? T0 + n).toISOString();
  return {
    uuid: uuidOf(n),
    cursor: cometdCursor(options.cursor ?? 1_000 + n),
    createdDate,
    payload: { CreatedDate: createdDate, Message__c: `message ${n}`, ...options.payload },
    bytes: 100
  };
}

const checkpointOf = (event: BusEvent) => ({
  orgId: ORG_ID,
  transport: 'cometd' as const,
  channel: `/event/${OBJECT}`,
  cursor: event.cursor,
  lastEvent: { createdDate: event.createdDate, uuid: event.uuid }
});

async function openWriter(store: EventStore, surface: 'vscode' | 'cli' = 'cli'): Promise<EventStoreWriter> {
  const opened = await store.openWriter(surface);
  assert.ok('writer' in opened, 'the lease was free');
  openedWriters.push(opened.writer);
  return opened.writer;
}

async function readAll(
  store: EventStore,
  options: Parameters<EventStore['newestFirst']>[0] = {}
): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  for await (const event of store.newestFirst(options)) events.push(event);
  return events;
}

/** Pages of `limit` rows, each continuing from the position of the last row of the page before. */
async function pageThrough(store: EventStore, limit: number): Promise<StoredEvent[][]> {
  const pages: StoredEvent[][] = [];
  let before: EventPosition | undefined;
  for (;;) {
    const fetched: StoredEvent[] = [];
    for await (const event of store.newestFirst({ before })) {
      fetched.push(event);
      if (fetched.length > limit) break;
    }
    pages.push(fetched.slice(0, limit));
    if (fetched.length <= limit) return pages;
    before = fetched[limit - 1]!.position;
  }
}

const uuidsOf = (events: readonly StoredEvent[]): string[] => events.map(event => event.position.uuid);

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, encoding: 'utf8' }).map(file => path.join(directory, file));
}

const dataFiles = (root: string): string[] =>
  filesUnder(objectDirOf(root))
    .filter(file => /[\\/]\d{4}-\d{2}-\d{2}[\\/]\d{2}\.[0-9a-f]{8}\.ndjson$/.test(file))
    .sort();

const gapFiles = (root: string): string[] =>
  filesUnder(objectDirOf(root))
    .filter(file => /[\\/]gaps\.[0-9a-f]{8}\.ndjson$/.test(file))
    .sort();

const linesOf = (file: string): unknown[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as unknown);

function age(file: string): void {
  const past = new Date(Date.now() - 10 * DAY);
  fs.utimesSync(file, past, past);
}

/** Every directory the code creates, every directory fsync, every append-mode open, and the order they happen in. */
function recordDisk(t: TestContext): string[] {
  const calls: string[] = [];
  const originalOpen = fsp.open;
  t.mock.method(fsp, 'open', async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
    const handle = await originalOpen.call(fsp, file, flags, mode);
    const name = String(file);
    calls.push(`open ${name} ${String(flags ?? 'r')}`);
    for (const op of ['datasync', 'sync'] as const) {
      const original = handle[op] as () => Promise<void>;
      Object.defineProperty(handle, op, {
        configurable: true,
        value: () => {
          calls.push(`${op} ${name}`);
          return original.call(handle);
        }
      });
    }
    return handle;
  });
  const originalMkdir = fsp.mkdir as (directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => Promise<unknown>;
  t.mock.method(fsp, 'mkdir', async (directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    const existed = fs.existsSync(String(directory));
    const result = await originalMkdir.call(fsp, directory, options);
    if (!existed) calls.push(`mkdir ${String(directory)}`);
    return result;
  });
  const originalRename = fsp.rename;
  t.mock.method(fsp, 'rename', (from: fs.PathLike, to: fs.PathLike) => {
    calls.push(`rename ${String(to)}`);
    return originalRename.call(fsp, from, to);
  });
  return calls;
}

test('a store nobody captured into reads as empty and reading creates nothing', async () => {
  await withProject(async root => {
    const store = openStore(root);

    assert.equal(await store.describe(), undefined);
    assert.equal(await store.checkpoint(), undefined);
    assert.deepEqual(await store.coverage(), { state: 'notCaptured', eventsRoot: objectDirOf(root) });
    assert.deepEqual(await readAll(store), []);
    assert.deepEqual(await store.window(0, T0), []);
    assert.equal(await store.find({ createdMs: T0, seq: 0 as CaptureSeq, uuid: uuidOf(1) }), undefined);
    assert.equal(store.eventsRoot, objectDirOf(root));
    assert.equal(fs.existsSync(path.join(root, 'apexlogs')), false, 'a read never creates the store');
  });
});

test('an object name that is not a platform event is refused before any path is built', () => {
  for (const object of ['Account', '../escape__e', 'App Log__e', '']) {
    assert.throws(() => openStore('/unused', object), { code: 'INVALID_ARGUMENT' }, object);
  }
  assert.doesNotThrow(() => openStore('/unused', 'ns__App_Log__e'));
});

test('opening a writer writes format.json and an events/.gitignore that ignores everything, and touches no Apex log file', async () => {
  await withProject(async root => {
    const alv = path.join(root, 'apexlogs', '.alv');
    const logs = path.join(orgDirOf(root), 'logs');
    fs.mkdirSync(alv, { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(alv, 'version.json'), '{"version":1}\n');
    fs.writeFileSync(path.join(alv, 'sync-state.json'), '{"orgs":{}}\n');
    fs.writeFileSync(path.join(logs, 'dev_07L000000000001.log'), 'log body\n');
    const before = filesUnder(path.join(root, 'apexlogs')).filter(file => !file.startsWith(eventsDirOf(root)));

    const store = openStore(root);
    const writer = await openWriter(store);

    assert.equal(fs.readFileSync(path.join(eventsDirOf(root), 'format.json'), 'utf8'), '{"version":1}\n');
    assert.equal(fs.readFileSync(path.join(eventsDirOf(root), '.gitignore'), 'utf8'), '*\n');

    await writer.writeDescribe(logEntryEventDescribe());
    const batch = [busEvent(1), busEvent(2)];
    await writer.append(batch);
    await writer.advance(checkpointOf(batch[1]!));
    await writer.purge(30, new Date(T0));
    await writer.release();

    const after = filesUnder(path.join(root, 'apexlogs')).filter(file => !file.startsWith(eventsDirOf(root)));
    assert.deepEqual(after, before, 'nothing appears beside the Apex log files');
    assert.equal(fs.readFileSync(path.join(alv, 'version.json'), 'utf8'), '{"version":1}\n');
    assert.equal(fs.readFileSync(path.join(alv, 'sync-state.json'), 'utf8'), '{"orgs":{}}\n');
    assert.equal(fs.readFileSync(path.join(logs, 'dev_07L000000000001.log'), 'utf8'), 'log body\n');
    assert.deepEqual(fs.readdirSync(orgDirOf(root)).sort(), ['events', 'logs']);
  });
});

test('every delivered field is stored with nulls dropped, one readable line per event, and read back with its payload', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const writer = await openWriter(store);
    const event = busEvent(7, {
      cursor: 15_253_040,
      payload: {
        Level__c: 'WARN',
        Hidden_By_Fls__c: 'secret value',
        Stack_Trace__c: null,
        Nested__c: { tags: ['a', 'b'], count: 2 },
        Count__c: 0,
        Flag__c: false,
        Empty__c: ''
      }
    });

    const { stored, duplicates } = await writer.append([event, event, busEvent(8)]);

    assert.equal(duplicates, 1, 'a copy inside the batch is not stored twice');
    assert.equal(stored.length, 2);
    const [file] = dataFiles(root);
    assert.ok(file);
    assert.match(path.relative(objectDirOf(root), file), /^2026-10-30[\\/]10\.[0-9a-f]{8}\.ndjson$/);
    const lines = linesOf(file) as Record<string, unknown>[];
    assert.equal(lines.length, 2);
    const line = lines[0]!;
    assert.deepEqual(Object.keys(line).sort(), [
      'createdDate',
      'id',
      'payload',
      'receivedAt',
      'replayId',
      'seq',
      'uuid',
      'v'
    ]);
    assert.equal(line.v, 1);
    assert.equal(line.uuid, event.uuid);
    assert.equal(line.id, stored[0]!.id);
    assert.equal(line.seq, 0);
    assert.equal(line.replayId, 'cometd:15253040');
    assert.equal(line.createdDate, event.createdDate);
    assert.equal(typeof line.receivedAt, 'string');
    assert.deepEqual(line.payload, {
      CreatedDate: event.createdDate,
      Message__c: 'message 7',
      Level__c: 'WARN',
      Hidden_By_Fls__c: 'secret value',
      Nested__c: { tags: ['a', 'b'], count: 2 },
      Count__c: 0,
      Flag__c: false,
      Empty__c: ''
    });

    const rows = await readAll(store);
    assert.deepEqual(uuidsOf(rows), [8, 7].map(uuidOf), 'the later event reads first');
    const read = rows.find(candidate => candidate.position.uuid === event.uuid);
    assert.deepEqual(read!.record, line.payload);
    assert.equal(read!.createdDate, event.createdDate);
    assert.equal(read!.id, stored[0]!.id);
  });
});

test('events read newest first by CreatedDate then capture sequence, whatever order they arrive in, across hours and days', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const writer = await openWriter(store);
    const arrivals = [
      busEvent(1, { createdMs: T0 }),
      busEvent(2, { createdMs: T0 + 5 * HOUR }),
      busEvent(3, { createdMs: T0 - 2 * DAY }),
      busEvent(4, { createdMs: T0 }),
      busEvent(5, { createdMs: T0 + 5 * HOUR + 1 }),
      busEvent(6, { createdMs: T0 - 1 })
    ];

    const { stored } = await writer.append(arrivals.slice(0, 3));
    await writer.append(arrivals.slice(3));

    assert.deepEqual(
      stored.map(event => event.position.seq),
      [0, 1, 2]
    );
    assert.deepEqual(
      (await readAll(store)).map(event => event.position.uuid),
      [5, 2, 4, 1, 6, 3].map(uuidOf),
      'time first; inside one millisecond the later delivery is the newer row'
    );
    assert.deepEqual(
      dataFiles(root).map(file => path.relative(objectDirOf(root), file).replace(/\.[0-9a-f]{8}\.ndjson$/, '')),
      ['2026-10-28/10', '2026-10-30/09', '2026-10-30/10', '2026-10-30/15'].map(name => name.replace('/', path.sep))
    );
  });
});

test('crash mid-flush: the torn line is never read, the checkpoint stays, and the next writer drops the re-delivery', async () => {
  await withProject(async root => {
    const first = await openWriter(openStore(root));
    const batchOne = [busEvent(1), busEvent(2)];
    await first.append(batchOne);
    await first.advance(checkpointOf(batchOne[1]!));
    await first.append([busEvent(3), busEvent(4), busEvent(5)]);
    await first.release();
    const [file] = dataFiles(root);
    fs.truncateSync(file!, fs.statSync(file!).size - 40);

    const restarted = openStore(root);
    assert.equal((await restarted.checkpoint())?.cursor, cometdCursor(1_002), 'the checkpoint did not move');
    assert.deepEqual(
      (await readAll(restarted)).map(event => event.position.uuid),
      [4, 3, 2, 1].map(uuidOf),
      'the torn line of event 5 is not a row'
    );

    const second = await openWriter(restarted);
    const { stored, duplicates } = await second.append([busEvent(3), busEvent(4), busEvent(5)]);

    assert.equal(duplicates, 2, 'events 3 and 4 were complete lines of the crashed flush');
    assert.deepEqual(uuidsOf(stored), [uuidOf(5)], '`stored` excludes the re-deliveries');
    assert.equal(stored[0]!.position.seq, 4, 'above every sequence a complete line holds');
    assert.deepEqual(
      (await readAll(restarted)).map(event => event.position.uuid),
      [5, 4, 3, 2, 1].map(uuidOf)
    );
  });
});

test('lease handover: the old writer keeps its unflushed lines, the new one allocates above them, and one row per uuid reads back', async () => {
  await withProject(async root => {
    const old = await openWriter(openStore(root), 'vscode');
    const batchOne = [busEvent(1), busEvent(2)];
    await old.append(batchOne);
    await old.advance(checkpointOf(batchOne[1]!));
    await old.append([busEvent(3)]);

    const contender = await openStore(root).openWriter('cli');
    assert.ok('heldBy' in contender, 'a live holder keeps the lease');
    assert.deepEqual(
      { surface: contender.heldBy.surface, pid: contender.heldBy.pid, host: contender.heldBy.host },
      { surface: 'vscode', pid: process.pid, host: os.hostname() }
    );
    assert.equal(typeof contender.heldBy.since, 'string');

    await old.release();
    await old.release();
    await assert.rejects(old.append([busEvent(9)]), /released/);

    const successor = await openWriter(openStore(root), 'cli');
    const { stored, duplicates } = await successor.append([busEvent(3), busEvent(4)]);

    assert.equal(duplicates, 1);
    assert.deepEqual(uuidsOf(stored), [uuidOf(4)]);
    assert.equal(stored[0]!.position.seq, 3, 'above the seq of event 3, which the checkpoint did not cover');
    assert.deepEqual(
      (await readAll(openStore(root))).map(event => event.position.uuid),
      [4, 3, 2, 1].map(uuidOf)
    );
    assert.equal(dataFiles(root).length, 2, 'each writer has its own file');
  });
});

test('a crashed first run leaves no checkpoint: every data file seeds the next writer and no sequence is reused', async () => {
  await withProject(async root => {
    const crashed = await openWriter(openStore(root));
    await crashed.append([
      busEvent(1, { createdMs: T0 - 2 * DAY }),
      busEvent(2, { createdMs: T0 - 1 * DAY }),
      busEvent(3, { createdMs: T0 })
    ]);
    await crashed.release();
    for (const file of dataFiles(root)) age(file);

    const store = openStore(root);
    assert.equal(await store.checkpoint(), undefined);
    const next = await openWriter(store);
    const { stored, duplicates } = await next.append([
      busEvent(1, { createdMs: T0 - 2 * DAY }),
      busEvent(3, { createdMs: T0 }),
      busEvent(4, { createdMs: T0 + 1 })
    ]);

    assert.equal(duplicates, 2, 'even the file from two days ago, which no checkpoint covers');
    assert.deepEqual(uuidsOf(stored), [uuidOf(4)]);
    assert.equal(stored[0]!.position.seq, 3);
  });
});

test('a file that predates the checkpoint is not reread: its re-delivery is stored and the readers merge the copies', async () => {
  await withProject(async root => {
    const first = await openWriter(openStore(root));
    const batch = [busEvent(1), busEvent(2), busEvent(3)];
    const written = await first.append(batch);
    await first.advance(checkpointOf(batch[2]!));
    await first.release();
    age(dataFiles(root)[0]!);

    const store = openStore(root);
    const second = await openWriter(store);
    const { stored, duplicates } = await second.append(batch);

    assert.equal(duplicates, 0, 'the checkpoint covers that file, so the writer does not look inside it');
    assert.deepEqual(
      stored.map(event => event.position.seq),
      [3, 4, 5],
      'the checkpoint carried the next sequence'
    );
    const rows = await readAll(store);
    assert.deepEqual(uuidsOf(rows), [3, 2, 1].map(uuidOf), 'one row per uuid');
    assert.deepEqual(
      rows.map(row => row.id),
      written.stored.map(event => event.id).reverse(),
      'the copy with the smallest seq is the one kept'
    );
  });
});

test('copies of one uuid in different hours read back as one event, in a scan and across pages whose cursor is in the newer copy hour', async () => {
  await withProject(async root => {
    const first = await openWriter(openStore(root));
    await first.append([busEvent(9, { createdMs: T0 }), busEvent(1, { createdMs: T0 - 10 })]);
    await first.advance(checkpointOf(busEvent(1)));
    await first.release();
    for (const file of dataFiles(root)) age(file);

    const store = openStore(root);
    const second = await openWriter(store);
    await second.append([busEvent(9, { createdMs: T0 + HOUR }), busEvent(2, { createdMs: T0 + HOUR + 1 })]);

    const rows = await readAll(store);
    assert.deepEqual(uuidsOf(rows), [2, 9, 1].map(uuidOf));
    assert.equal(rows[1]!.position.createdMs, T0 + HOUR, 'the first copy a newest-first scan meets wins');
    for (const limit of [1, 2]) {
      assert.deepEqual(
        uuidsOf((await pageThrough(store, limit)).flat()),
        [2, 9, 1].map(uuidOf),
        `pages of ${limit}: the older copy stays hidden once the newer one was shown from the cursor hour`
      );
    }
  });
});

test('a page boundary between two copies of one uuid in one hour never shows the uuid twice', async () => {
  await withProject(async root => {
    const batch = Array.from({ length: 80 }, (_, i) => busEvent(i + 1, { createdMs: T0, cursor: 5_000 + i }));
    const first = await openWriter(openStore(root));
    await first.append(batch);
    await first.advance(checkpointOf(batch[79]!));
    await first.release();
    age(dataFiles(root)[0]!);

    const store = openStore(root);
    const second = await openWriter(store);
    const replay = await second.append(batch);
    assert.equal(replay.stored.length, 80, 'every uuid now has two copies in one hour');

    for (const limit of [1, 7, 50, 80, 100]) {
      const pages = await pageThrough(store, limit);
      const rows = pages.flat();
      assert.equal(new Set(uuidsOf(rows)).size, 80, `no duplicate with pages of ${limit}`);
      assert.equal(rows.length, 80, `no row lost with pages of ${limit}`);
      assert.ok(
        rows.every(row => row.position.seq < 80),
        `the first writer's copy, the smaller seq, is the one kept (pages of ${limit})`
      );
      assert.deepEqual(
        rows.map(row => row.position.seq),
        Array.from({ length: 80 }, (_, i) => 79 - i),
        `order is stable across pages of ${limit}`
      );
    }
  });
});

test('find resolves the id of any stored copy to the kept copy', async () => {
  await withProject(async root => {
    const first = await openWriter(openStore(root));
    const original = await first.append([busEvent(1), busEvent(2)]);
    await first.advance(checkpointOf(busEvent(2)));
    await first.release();
    age(dataFiles(root)[0]!);
    const store = openStore(root);
    const second = await openWriter(store);
    const duplicate = await second.append([busEvent(2)]);

    const kept = original.stored[1]!;
    const other = duplicate.stored[0]!;
    assert.notEqual(kept.id, other.id);
    assert.equal((await store.find(kept.position))?.id, kept.id);
    assert.equal((await store.find(other.position))?.id, kept.id);
    assert.equal(await store.find({ ...kept.position, uuid: uuidOf(99) }), undefined);
    assert.equal(await store.find({ ...kept.position, createdMs: kept.position.createdMs + DAY }), undefined);
    assert.equal((await store.find(kept.position))?.record.Message__c, 'message 2');
  });
});

test('a duplicate-only batch still advances the resume point', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const writer = await openWriter(store);
    const batch = [busEvent(1), busEvent(2)];
    await writer.append(batch);
    await writer.advance(checkpointOf(batch[1]!));
    const nextSeq = (await store.checkpoint())?.nextSeq;

    const overlap = [busEvent(1, { cursor: 9_998 }), busEvent(2, { cursor: 9_999 })];
    const { stored, duplicates } = await writer.append(overlap);
    assert.deepEqual([stored.length, duplicates], [0, 2]);
    await writer.advance(checkpointOf(overlap[1]!));

    const checkpoint = await store.checkpoint();
    assert.equal(checkpoint?.cursor, cometdCursor(9_999));
    assert.equal(checkpoint?.nextSeq, nextSeq, 'no sequence was spent on a duplicate');
    assert.equal(checkpoint?.orgId, ORG_ID);
    assert.equal(checkpoint?.transport, 'cometd');
    assert.equal(checkpoint?.channel, `/event/${OBJECT}`);
    assert.deepEqual(checkpoint?.lastEvent, { createdDate: overlap[1]!.createdDate, uuid: uuidOf(2) });
    assert.equal(checkpoint?.writer, writer.writerId);
  });
});

test('advance after the lease file is replaced throws LeaseLostError and writes nothing', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const writer = await openWriter(store);
    const batch = [busEvent(1), busEvent(2)];
    await writer.append(batch);
    const leaseFile = path.join(objectDirOf(root), 'capture.lease');
    const thief = {
      version: 1,
      pid: process.pid,
      token: 'ffffffffffffffff',
      host: os.hostname(),
      surface: 'cli',
      startedAt: '2026-10-30T00:00:00.000Z'
    };

    fs.writeFileSync(leaseFile, JSON.stringify(thief));
    await assert.rejects(writer.advance(checkpointOf(batch[1]!)), LeaseLostError);
    assert.equal(fs.existsSync(path.join(objectDirOf(root), 'checkpoint.json')), false, 'no first checkpoint');

    fs.rmSync(leaseFile);
    await assert.rejects(writer.advance(checkpointOf(batch[1]!)), LeaseLostError, 'a missing lease is lost too');

    fs.writeFileSync(leaseFile, JSON.stringify(thief));
    await writer.release();
    assert.deepEqual(
      JSON.parse(fs.readFileSync(leaseFile, 'utf8')),
      thief,
      'release leaves another holder lease alone'
    );
    assert.equal(await store.checkpoint(), undefined);
    assert.equal((await readAll(store)).length, 2, 'the appended events stay readable');
  });
});

test('advance never overtakes the append before it', async t => {
  await withProject(async root => {
    const calls = recordDisk(t);
    const writer = await openWriter(openStore(root));
    const batch = [busEvent(1)];

    const appended = writer.append(batch);
    const advanced = writer.advance(checkpointOf(batch[0]!));
    await Promise.all([appended, advanced]);

    const dataSync = calls.indexOf(`datasync ${dataFiles(root)[0]!}`);
    const checkpointWrite = calls.indexOf(`rename ${path.join(objectDirOf(root), 'checkpoint.json')}`);
    assert.ok(dataSync >= 0, 'the data file is flushed');
    assert.ok(checkpointWrite > dataSync, 'the checkpoint is written after the data is on disk');
  });
});

test('gap files are per writer and fold together: a gap opened by one writer is closed by the next', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const first = await openWriter(store);
    const opened = await first.openGap({ reason: 'cursorRejected', after: '2026-10-21T18:02:11.000Z' });
    assert.equal(opened.created, true);
    assert.deepEqual(
      { reason: opened.gap.reason, after: opened.gap.after, hasId: opened.gap.id.length > 0 },
      { reason: 'cursorRejected', after: '2026-10-21T18:02:11.000Z', hasId: true }
    );
    const again = await first.openGap({ reason: 'retentionElapsed' });
    assert.deepEqual([again.created, again.gap.id], [false, opened.gap.id], 'at most one gap is open');
    assert.deepEqual(await first.openGapNow(), opened.gap);
    await first.release();

    const successor = await openWriter(openStore(root));
    assert.deepEqual(await successor.openGapNow(), opened.gap, 'a gap an earlier run left open is still open');
    const reopened = await successor.openGap({ reason: 'orgChanged' });
    assert.deepEqual([reopened.created, reopened.gap.id], [false, opened.gap.id], 'never reported as new again');
    await successor.closeOpenGap('2026-10-25T09:40:02.554Z');
    assert.equal(await successor.openGapNow(), undefined);
    await successor.closeOpenGap('2026-10-26T00:00:00.000Z');

    const [firstFile, successorFile] = [first, successor].map(writer =>
      path.join(objectDirOf(root), `gaps.${writer.writerId}.ndjson`)
    );
    assert.deepEqual(
      linesOf(firstFile!).map(line => (line as { op: string }).op),
      ['open']
    );
    assert.deepEqual(
      linesOf(successorFile!).map(line => (line as { op: string }).op),
      ['close']
    );

    const batch = [busEvent(1)];
    await successor.append(batch);
    await successor.advance(checkpointOf(batch[0]!));
    const coverage = await store.coverage();
    assert.equal(coverage.state, 'captured');
    assert.deepEqual(coverage.state === 'captured' ? coverage.gaps : [], [
      {
        reason: 'cursorRejected',
        after: '2026-10-21T18:02:11.000Z',
        before: '2026-10-25T09:40:02.554Z',
        detectedAt: opened.gap.detectedAt
      }
    ]);

    const next = await successor.openGap({ reason: 'retentionElapsed' });
    assert.equal(next.created, true, 'a closed gap does not block the next one');
    assert.equal(next.gap.after, undefined);
  });
});

test('purge deletes day directories by name, a gap file only when all its gaps closed before the oldest kept day, and stale temp files', async () => {
  await withProject(async root => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    const store = openStore(root);

    const oldGaps = await openWriter(store);
    await oldGaps.openGap({ reason: 'cursorRejected', after: '2026-10-01T00:00:00.000Z' });
    await oldGaps.closeOpenGap('2026-10-02T00:00:00.000Z');
    await oldGaps.release();

    const recentGaps = await openWriter(store);
    await recentGaps.openGap({ reason: 'retentionElapsed', after: '2026-10-27T00:00:00.000Z' });
    await recentGaps.closeOpenGap('2026-10-28T09:00:00.000Z');
    await recentGaps.release();

    const openGapWriter = await openWriter(store);
    await openGapWriter.openGap({ reason: 'orgChanged' });
    await openGapWriter.release();

    const writer = await openWriter(store);
    const kept = [busEvent(3, { createdMs: Date.parse('2026-10-27T00:00:00.000Z') }), busEvent(4, { createdMs: T0 })];
    await writer.append([
      busEvent(1, { createdMs: Date.parse('2026-10-25T23:59:59.999Z') }),
      busEvent(2, { createdMs: Date.parse('2026-10-26T12:00:00.000Z') }),
      ...kept
    ]);
    await writer.advance(checkpointOf(kept[1]!));
    const oldTemp = path.join(objectDirOf(root), 'checkpoint.json.1.2.3.tmp');
    const freshTemp = path.join(objectDirOf(root), 'capture.lease.4.5.6.tmp');
    fs.writeFileSync(oldTemp, 'half a checkpoint');
    fs.writeFileSync(freshTemp, 'being written');
    const stale = new Date(now.getTime() - 2 * HOUR);
    fs.utimesSync(oldTemp, stale, stale);
    fs.utimesSync(freshTemp, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
    const filesBefore = new Map(gapFiles(root).map(file => [file, fs.readFileSync(file, 'utf8')]));

    assert.equal(await writer.purge(3, now), 2, 'the days before 2026-10-27 go');

    assert.deepEqual(
      fs.readdirSync(objectDirOf(root)).filter(name => /^\d{4}-/.test(name)),
      ['2026-10-27', '2026-10-30']
    );
    assert.deepEqual(uuidsOf(await readAll(openStore(root))), [4, 3].map(uuidOf));
    assert.equal(fs.existsSync(oldTemp), false);
    assert.equal(fs.existsSync(freshTemp), true);
    const remaining = gapFiles(root);
    assert.deepEqual(
      remaining,
      [recentGaps, openGapWriter].map(w => path.join(objectDirOf(root), `gaps.${w.writerId}.ndjson`)).sort(),
      'the file of the gap closed long before is gone; a recent gap and an open gap are kept'
    );
    for (const file of remaining) assert.equal(fs.readFileSync(file, 'utf8'), filesBefore.get(file), 'never rewritten');
    assert.equal((await writer.openGapNow())?.reason, 'orgChanged');

    const batch = [busEvent(5, { createdMs: T0 + 2 })];
    await writer.append(batch);
    assert.equal(uuidsOf(await readAll(openStore(root)))[0], uuidOf(5), 'the writer appends on after a purge');
  });
});

test('a failed append retires the writer: it names the file, the batch is not checkpointed, and the next run stores it', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const writer = await openWriter(store);
    const blocked = path.join(objectDirOf(root), '2026-10-30', `10.${writer.writerId}.ndjson`);
    fs.mkdirSync(blocked, { recursive: true });
    const batch = [busEvent(1)];

    const failure = await writer.append(batch).catch((error: unknown) => error);
    assert.ok(failure instanceof Error);
    assert.equal((failure as { code?: string }).code, 'CUSTOM_LOG_STORE_UNAVAILABLE');
    assert.ok(failure.message.includes(blocked), failure.message);

    await assert.rejects(writer.append([busEvent(2, { createdMs: T0 + HOUR })]), UNAVAILABLE);
    await assert.rejects(writer.advance(checkpointOf(batch[0]!)), UNAVAILABLE);
    await assert.rejects(writer.openGap({ reason: 'cursorRejected' }), UNAVAILABLE);
    await writer.release();
    assert.equal(await store.checkpoint(), undefined);

    const next = await openWriter(store);
    const { stored } = await next.append(batch);
    assert.equal(stored.length, 1, 'the new writer stores what the failed one never wrote');
    assert.equal(uuidsOf(await readAll(store)).length, 1);
  });
});

test('an event without a usable CreatedDate is refused before anything is written', async () => {
  await withProject(async root => {
    const writer = await openWriter(openStore(root));

    await assert.rejects(writer.append([busEvent(1), { ...busEvent(2), createdDate: 'yesterday' }]), RangeError);

    assert.deepEqual(dataFiles(root), []);
    const { stored } = await writer.append([busEvent(1)]);
    assert.equal(stored[0]!.position.seq, 0, 'the refused batch spent no sequence');
  });
});

test('a symlinked events directory is refused for reads and writes, and nothing is written through it', async t => {
  await withProject(async root => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(orgDirOf(root), { recursive: true });
    try {
      fs.symlinkSync(elsewhere, eventsDirOf(root), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('creating a symlink needs elevation here');
      throw error;
    }
    const store = openStore(root);

    await assert.rejects(store.openWriter('cli'), UNAVAILABLE);
    await assert.rejects(store.coverage(), UNAVAILABLE);
    await assert.rejects(store.checkpoint(), UNAVAILABLE);
    await assert.rejects(readAll(store), UNAVAILABLE);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });
});

test('a store format newer than this version is refused everywhere and left untouched', async () => {
  await withProject(async root => {
    const writer = await openWriter(openStore(root));
    await writer.release();
    const format = path.join(eventsDirOf(root), 'format.json');
    fs.writeFileSync(format, '{"version":2}\n');
    const store = openStore(root);

    const attempts: (() => Promise<unknown>)[] = [
      () => store.openWriter('cli'),
      () => store.coverage(),
      () => store.checkpoint(),
      () => store.describe(),
      () => readAll(store),
      () => store.find({ createdMs: T0, seq: 0 as CaptureSeq, uuid: uuidOf(1) })
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), { ...UNAVAILABLE, message: /newer version/ });
    }
    assert.equal(fs.readFileSync(format, 'utf8'), '{"version":2}\n');
    assert.equal(fs.existsSync(path.join(objectDirOf(root), 'capture.lease')), false, 'no lease was taken');
  });
});

test('an unreadable lease or checkpoint is STORE_UNAVAILABLE and names the file', async () => {
  await withProject(async root => {
    fs.mkdirSync(objectDirOf(root), { recursive: true });
    const lease = path.join(objectDirOf(root), 'capture.lease');
    fs.writeFileSync(lease, 'not a lease');

    await assert.rejects(openStore(root).openWriter('cli'), { ...UNAVAILABLE, message: new RegExp('capture\\.lease') });

    fs.rmSync(lease);
    const checkpoint = path.join(objectDirOf(root), 'checkpoint.json');
    fs.writeFileSync(checkpoint, '{"version":1,"cursor":42}');
    await assert.rejects(openStore(root).checkpoint(), { ...UNAVAILABLE, message: new RegExp('checkpoint\\.json') });
    await assert.rejects(openStore(root).openWriter('cli'), UNAVAILABLE);
    assert.equal(fs.existsSync(lease), false, 'the lease is given back when opening fails');

    fs.writeFileSync(checkpoint, '{"version":1');
    await assert.rejects(openStore(root).coverage(), { ...UNAVAILABLE, message: /not valid JSON/ });
  });
});

test('describe.json round-trips the capturing user describe and is rewritten only when it changes', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const writer = await openWriter(store);
    const describe = logEntryEventDescribe();
    const file = path.join(objectDirOf(root), 'describe.json');

    await writer.writeDescribe(describe);
    assert.deepEqual(await store.describe(), describe);
    const written = fs.statSync(file).ino;

    await writer.writeDescribe(describe);
    assert.equal(fs.statSync(file).ino, written, 'an identical describe writes nothing');

    const changed = { ...describe, fields: describe.fields.slice(1) };
    await writer.writeDescribe(changed);
    assert.deepEqual(await store.describe(), changed);

    fs.writeFileSync(file, '{"name":"App_Log__e"}');
    await assert.rejects(store.describe(), { ...UNAVAILABLE, message: /describe\.json/ });
    await writer.writeDescribe(describe);
    assert.deepEqual(await store.describe(), describe, 'the next capture repairs it');
  });
});

test('coverage is notCaptured without a checkpoint, then reports the span, size, last capture and gaps', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const writer = await openWriter(store);
    const batch = [
      busEvent(2, { createdMs: T0 + 250 }),
      busEvent(3, { createdMs: T0 + 20 * 60_000 }),
      busEvent(1, { createdMs: Date.parse('2026-10-29T08:30:00.000Z') })
    ];
    await writer.append(batch);
    assert.deepEqual(await store.coverage(), { state: 'notCaptured', eventsRoot: objectDirOf(root) });

    await writer.advance(checkpointOf(batch[2]!));

    const checkpoint = await store.checkpoint();
    assert.deepEqual(await store.coverage(), {
      state: 'captured',
      eventsRoot: objectDirOf(root),
      oldest: '2026-10-29T08:30:00.000Z',
      newest: new Date(T0 + 20 * 60_000).toISOString(),
      lastCaptureAt: checkpoint!.updatedAt,
      sizeBytes: dataFiles(root).reduce((sum, file) => sum + fs.statSync(file).size, 0),
      gaps: []
    });
  });
});

test('window and since/until bound CreatedDate: since inclusive, until exclusive, window inclusive both ends', async () => {
  await withProject(async root => {
    const store = openStore(root);
    const writer = await openWriter(store);
    const base = Date.parse('2026-10-30T09:59:58.000Z');
    await writer.append([5, 3, 0, 4, 1, 2].map(i => busEvent(i + 1, { createdMs: base + i * 1_000 })));

    const at = (i: number): number => base + i * 1_000;
    assert.deepEqual(
      (await store.window(at(1), at(3))).map(event => event.position.createdMs),
      [at(1), at(2), at(3)],
      'ascending, both ends included, across the hour boundary'
    );
    assert.deepEqual(
      (await readAll(store, { sinceMs: at(1), untilMs: at(3) })).map(event => event.position.createdMs),
      [at(2), at(1)]
    );
    assert.equal((await readAll(store, { sinceMs: at(6) })).length, 0);
    assert.equal((await readAll(store, { untilMs: at(0) })).length, 0, 'until is exclusive');
    assert.deepEqual(
      (await readAll(store, { before: (await readAll(store))[2]!.position })).map(event => event.position.createdMs),
      [at(2), at(1), at(0)]
    );
  });
});

test('a line that does not parse is skipped and a reader sees what a writer appends later', async () => {
  await withProject(async root => {
    const reader = openStore(root);
    const writer = await openWriter(openStore(root));
    await writer.append([busEvent(1), busEvent(2)]);
    assert.deepEqual(uuidsOf(await readAll(reader)), [2, 1].map(uuidOf));

    const [file] = dataFiles(root);
    fs.appendFileSync(file!, 'this is not json\n{"v":1,"uuid":"nope"}\n');
    await writer.append([busEvent(3)]);
    fs.appendFileSync(file!, '{"v":1,"uuid":"torn');

    assert.deepEqual(uuidsOf(await readAll(reader)), [3, 2, 1].map(uuidOf), 'the cached index follows the file');
    assert.deepEqual(uuidsOf(await readAll(openStore(root))), [3, 2, 1].map(uuidOf));
  });
});

test('the parent of every directory the store creates is fsynced once, before the first append in it', async t => {
  await withProject(async root => {
    const calls = recordDisk(t);
    const writer = await openWriter(openStore(root));
    await writer.append([busEvent(1, { createdMs: T0 }), busEvent(2, { createdMs: T0 + HOUR })]);
    await writer.append([busEvent(3, { createdMs: T0 - 3 * HOUR }), busEvent(4, { createdMs: T0 - DAY })]);
    await writer.append([busEvent(5, { createdMs: T0 + 1 })]);

    const created = calls.filter(call => call.startsWith('mkdir ')).map(call => call.slice('mkdir '.length));
    const days = ['2026-10-29', '2026-10-30'].map(day => path.join(objectDirOf(root), day));
    for (const directory of [path.join(root, 'apexlogs'), eventsDirOf(root), objectDirOf(root), ...days]) {
      assert.ok(created.includes(directory), `${directory} was created by the store`);
    }
    for (const directory of created) {
      const made = calls.indexOf(`mkdir ${directory}`);
      const parentSynced = calls.indexOf(`sync ${path.dirname(directory)}`, made + 1);
      assert.ok(parentSynced > made, `${directory}: the parent is fsynced after the directory exists`);
      const firstAppend = calls.findIndex(
        call => call.startsWith(`open ${directory}${path.sep}`) && call.endsWith(' a')
      );
      if (firstAppend >= 0)
        assert.ok(parentSynced < firstAppend, `${directory}: the parent is fsynced before the first append`);
    }
    assert.equal(
      calls.filter(call => call === `sync ${objectDirOf(root)}`).length,
      2,
      'once per new day directory, not once per file or per batch'
    );
  });
});
