import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Connection } from '@salesforce/core';

import type { CustomLogCaptureUpdate, CustomLogRow, CustomLogStoreInfo } from '../../src/customLogs/contracts.ts';
import {
  type CaptureClock,
  type CaptureDeps,
  type CaptureRunEvent,
  type CaptureWatcher
} from '../../src/customLogs/events/capture.ts';
import type { Allowance } from '../../src/customLogs/events/captureRules.ts';
import { cometdCursor, parseEventUuid, type EventUuid, type ReplayCursor } from '../../src/customLogs/events/ids.ts';
import {
  openEventStore,
  type EventStore,
  type EventStoreLocation,
  type EventStoreWriter,
  type StoreCoverage,
  type StoredEvent
} from '../../src/customLogs/events/store.ts';
import {
  TransportError,
  type BusEvent,
  type EventTransport,
  type ReplayFrom,
  type TransportFailure,
  type TransportSignal
} from '../../src/customLogs/events/transport.ts';
import type { ResolvedEventSource } from '../../src/customLogs/resolved.ts';
import type { ObjectDescribe } from '../../src/customLogs/schema.ts';
import { logEntryEventDescribe } from './describeFixtures.ts';

export const USER = 'dev@example.com';
export const OBJECT = 'App_Log__e';
export const CHANNEL = `/event/${OBJECT}`;
export const ORG_ID = '00D000000000001AAA';

// ---------------------------------------------------------------------------------------------
// time

type Timer = { at: number; seq: number; run: () => void };

/** Timers fire only when a test advances time; `now()` starts at the real clock so stored timestamps stay comparable. */
export class ManualClock implements CaptureClock {
  private nowMs: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(startMs: number = Date.now()) {
    this.nowMs = startMs;
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  after(ms: number, run: () => void): () => void {
    const timer: Timer = { at: this.nowMs + ms, seq: this.seq++, run };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter(candidate => candidate !== timer);
    };
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Fires every timer due within `ms`, in order, then leaves `now()` `ms` later. A timer armed meanwhile fires too when it falls inside. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter(timer => timer !== due);
      this.nowMs = Math.max(this.nowMs, due.at);
      due.run();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    this.nowMs = target;
  }
}

/** Polls (real time) until `check` holds; the run's file I/O is real, so a test waits for its effect, never for a fixed time. */
export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
}

/** Rejects when `promise` has not settled after `timeoutMs` of real time, so a run that never stops fails instead of hanging the suite. */
export async function within<T>(promise: Promise<T>, what: string, timeoutMs = 8_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// events

export const uuidOf = (n: number): EventUuid => {
  const uuid = parseEventUuid(`00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`);
  assert.ok(uuid);
  return uuid;
};

export const T0 = Date.parse('2026-10-30T10:00:00.000Z');

/** Event `n`: created `n` ms after T0, delivered with replay id 1000 + n unless told otherwise. */
export function busEvent(
  n: number,
  options: { createdMs?: number; cursor?: number; bytes?: number; payload?: Record<string, unknown> } = {}
): BusEvent {
  const createdDate = new Date(options.createdMs ?? T0 + n).toISOString();
  return {
    uuid: uuidOf(n),
    cursor: cometdCursor(options.cursor ?? 1_000 + n),
    createdDate,
    payload: { CreatedDate: createdDate, Message__c: `message ${n}`, ...options.payload },
    bytes: options.bytes ?? 100
  };
}

export const cursorOf = (n: number): ReplayCursor => cometdCursor(1_000 + n);

// ---------------------------------------------------------------------------------------------
// the transport

export type FakeAttempt = {
  readonly from: ReplayFrom;
  /** What the run answers when the adapter asks where to resume. */
  durableCursor(): ReplayCursor | undefined;
  readonly aborted: boolean;
  /** Runs after `open` was called; what a hook read from the store is what the store held at that moment. */
  readonly ready: Promise<void>;
  emit(signal: TransportSignal): void;
  subscribed(): void;
  events(...events: BusEvent[]): void;
  /** Ends the attempt the way the adapter does: `open` rejects with the failure. */
  fail(failure: TransportFailure): void;
};

export type FakeTransport = {
  transport: EventTransport;
  attempts: FakeAttempt[];
  opened(index: number): Promise<FakeAttempt>;
};

/** A scripted stand-in for the CometD adapter. Signals after an abort or a failure are dropped, as the real adapter drops late callbacks. */
export function fakeTransport(
  options: { onOpen?: (attempt: FakeAttempt) => void | Promise<void> } = {}
): FakeTransport {
  const attempts: FakeAttempt[] = [];
  const transport: EventTransport = {
    name: 'cometd',
    open: ({ from, durableCursor, signal, onSignal }) =>
      new Promise<void>((resolve, reject) => {
        let closed = false;
        const emit = (next: TransportSignal): void => {
          if (!closed) onSignal(next);
        };
        const attempt: FakeAttempt = {
          from,
          durableCursor,
          get aborted() {
            return signal.aborted;
          },
          ready: Promise.resolve(),
          emit,
          subscribed: () => emit({ type: 'subscribed' }),
          events: (...events) => emit({ type: 'events', events }),
          fail: failure => {
            if (closed) return;
            closed = true;
            reject(new TransportError(failure));
          }
        };
        (attempt as { ready: Promise<void> }).ready = Promise.resolve(options.onOpen?.(attempt));
        attempts.push(attempt);
        const onAbort = (): void => {
          closed = true;
          setImmediate(resolve);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
  };
  return {
    transport,
    attempts,
    opened: async index => {
      await until(() => attempts.length > index, `transport open #${index + 1}`);
      const attempt = attempts[index]!;
      await attempt.ready;
      return attempt;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// the store

export async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alv-capture-'));
  try {
    await run(root);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

export const openStore = (root: string): EventStore => openEventStore({ root, username: USER, object: OBJECT });

export const objectDirOf = (root: string): string => path.join(root, 'apexlogs', 'orgs', USER, 'events', OBJECT);

export async function readStored(store: EventStore): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  for await (const event of store.newestFirst({})) events.push(event);
  return events;
}

export async function openWriter(store: EventStore, surface: 'vscode' | 'cli' = 'cli'): Promise<EventStoreWriter> {
  const opened = await store.openWriter(surface);
  assert.ok('writer' in opened, 'the lease was free');
  return opened.writer;
}

/** Seeds a checkpoint the way an earlier run left it: events stored, then the position after the last one. */
export async function seedCheckpoint(
  store: EventStore,
  events: readonly BusEvent[],
  options: { orgId?: string } = {}
): Promise<void> {
  const writer = await openWriter(store);
  try {
    await writer.append(events);
    const tail = events[events.length - 1]!;
    await writer.advance({
      orgId: options.orgId ?? ORG_ID,
      transport: 'cometd',
      channel: CHANNEL,
      cursor: tail.cursor,
      lastEvent: { createdDate: tail.createdDate, uuid: tail.uuid }
    });
  } finally {
    await writer.release();
  }
}

export type WriterHooks = {
  append?: (events: readonly BusEvent[]) => void | Promise<void>;
  appended?: (events: readonly BusEvent[]) => void;
  advance?: (cursor: ReplayCursor) => void | Promise<void>;
  advanced?: (cursor: ReplayCursor) => void;
};

/** The same store, whose writers report to `hooks` around `append` and `advance`. */
export function instrumentStore(store: EventStore, hooks: WriterHooks): EventStore {
  return {
    ...store,
    openWriter: async surface => {
      const opened = await store.openWriter(surface);
      if (!('writer' in opened)) return opened;
      const { writer } = opened;
      const wrapped: EventStoreWriter = {
        ...writer,
        append: async events => {
          await hooks.append?.(events);
          const result = await writer.append(events);
          hooks.appended?.(events);
          return result;
        },
        advance: async checkpoint => {
          await hooks.advance?.(checkpoint.cursor);
          await writer.advance(checkpoint);
          hooks.advanced?.(checkpoint.cursor);
        }
      };
      return { writer: wrapped };
    }
  };
}

// ---------------------------------------------------------------------------------------------
// the run's dependencies

/** Capture reads the id, label, kind, object and channel of a source; decoding is the injected decoder's. */
export function eventSource(id = 'app-events', object = OBJECT): ResolvedEventSource {
  return {
    id,
    label: 'App events',
    shape: { kind: 'events', event: { object, channel: CHANNEL } }
  } as unknown as ResolvedEventSource;
}

export const appDescribe = (): ObjectDescribe => ({ ...logEntryEventDescribe(), name: OBJECT });

const connection = {} as Connection;

/** The facade maps coverage once for `list`, `get` and `capture`; this stands in for it. */
export function storeInfoOf(coverage: StoreCoverage, retentionDays: number): CustomLogStoreInfo {
  if (coverage.state === 'notCaptured') return { state: 'notCaptured', eventsRoot: coverage.eventsRoot, retentionDays };
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

export type DepsOptions = {
  /** What the injected opener answers; a test passes its instrumented store here. */
  store: EventStore;
  transport: FakeTransport;
  clock: ManualClock;
  allowance?: Allowance | undefined;
  surface?: 'vscode' | 'cli';
  retentionDays?: number;
  orgId?: string;
  connect?: CaptureDeps['connect'];
};

export type TestDeps = CaptureDeps & {
  calls: {
    connects: { fresh: boolean }[];
    allowances: number;
    describes: number;
    /** The object name each describe was asked for. */
    described: string[];
    opened: EventStoreLocation[];
    decoded: string[];
    runEvents: CaptureRunEvent[];
    callbackErrors: unknown[];
    /** What the run handed `createTransport`; the CometD adapter reports malformed messages through it. */
    hooks: { onDropped(count: number): void } | undefined;
  };
};

export function captureDeps(options: DepsOptions): TestDeps {
  const calls: TestDeps['calls'] = {
    connects: [],
    allowances: 0,
    describes: 0,
    described: [],
    opened: [],
    decoded: [],
    runEvents: [],
    callbackErrors: [],
    hooks: undefined
  };
  const session = { ctx: { connection, username: USER }, orgId: options.orgId ?? ORG_ID };
  return {
    calls,
    createTransport: hooks => {
      calls.hooks = hooks;
      return options.transport.transport;
    },
    connect:
      options.connect ??
      (async ({ fresh }) => {
        calls.connects.push({ fresh });
        return session;
      }),
    describe: async (_ctx, object) => {
      calls.describes += 1;
      calls.described.push(object);
      return appDescribe();
    },
    openStore: location => {
      calls.opened.push(location);
      return options.store;
    },
    storeInfo: coverage => storeInfoOf(coverage, options.retentionDays ?? 30),
    readAllowance: async () => {
      calls.allowances += 1;
      return 'allowance' in options ? options.allowance : { remaining: 10_000, max: 25_000 };
    },
    decodeRows: (source, events) => {
      calls.decoded.push(source.id);
      return {
        rows: events.map(
          event =>
            ({
              id: event.id,
              time: event.createdDate,
              title: String(event.record.Message__c),
              extra: {}
            }) satisfies CustomLogRow
        ),
        payloadFields: []
      };
    },
    retentionDays: options.retentionDays ?? 30,
    surface: options.surface ?? 'cli',
    clock: options.clock,
    onRunEvent: event => calls.runEvents.push(event),
    onCallbackError: error => calls.callbackErrors.push(error)
  };
}

export type Watch = {
  watcher: CaptureWatcher;
  abort(): void;
  updates: CustomLogCaptureUpdate[];
  /** Public states in the order they were reported, consecutive repeats dropped. */
  states(): string[];
  rows(): string[];
};

export function watcher(
  params: Partial<CaptureWatcher['params']> & { follow: boolean },
  options: { source?: ResolvedEventSource } = {}
): Watch {
  const controller = new AbortController();
  const updates: CustomLogCaptureUpdate[] = [];
  return {
    watcher: {
      source: options.source ?? eventSource(),
      params,
      signal: controller.signal,
      onUpdate: update => updates.push(update)
    },
    abort: () => controller.abort(),
    updates,
    states: () => {
      const names = updates.map(update => update.capture.state);
      return names.filter((name, index) => name !== names[index - 1]);
    },
    rows: () => updates.flatMap(update => update.rows.map(row => row.title ?? ''))
  };
}
