/**
 * Capture: move a platform event's stream into the store, and tell watchers what was stored.
 * All policy lives here and in `captureRules.ts`; the transport only moves events and the store only
 * keeps them.
 *
 * One RUN per event object per process, shared by every WATCHER in the process (the Custom Logs view
 * and its editor tab, two sources over one object). A run starts with its first watcher and ends when
 * its last watcher leaves: capture happens only while a panel shows an event source or a CLI command
 * runs. Across processes the fenced store lease decides which run subscribes; the others stand by and
 * relay what it stores.
 *
 * The run reports one public `CustomLogCaptureState`; every change goes through `nextState`:
 *
 *   lease held elsewhere ─► standby ─ poll: relay stored rows; the holder's pid dies ─┐
 *   lease won ◄────────────────────────────────────────────────────────────────────────┘
 *     │ connecting: connect, org id, allowance and budget, describe → describe.json, purge, chooseStart
 *     │            a gap decided at start is written BEFORE any subscribe; `needsInitial` subscribes nothing
 *     ▼
 *   subscribe ─ subscribed ─► catchingUp ─ quiet ─► live{quiet}
 *     │  cursorRejected: gap written first, then `retained` (a second one fails the run)
 *     │  authRejected:   connect({ fresh }), backoff (fails after MAX_AUTH_REBUILDS without a `subscribed`)
 *     │  down / queue overflow ─► reconnecting{cause}
 *     │  deliveryLimit | clientLimit | forbidden | other ─► failed (own codes, CUSTOM_LOG_CAPTURE_FAILED)
 *   LeaseLostError on advance ─► release, stand by again
 *   last watcher leaves | budget spent | needsInitial ─► flush, clean end, release ─► stopped{outcome}
 *
 * Flush (I2 of store.ts): events queue; at FLUSH_MS after the first queued event, at FLUSH_MAX events,
 * or when the stream ends: `append` (durable) → `advance` with the cursor of the last delivered event →
 * close the open gap if a stored event is newer than its `after` → emit the rows. A screen never shows
 * an event that is not on disk. Flushes are single-flight: every trigger chains on one promise, so
 * `advance` calls land in the order `append` calls complete and a slow disk cannot put a cursor past
 * stored data. `last` (a `RunPosition`) is the run's one piece of position state: `last?.cursor` is what
 * the transport's `durableCursor()` answers, and `last` is what the clean end re-sends.
 *
 * Queue bound: Faye hands over one HTTP response synchronously (870 events, 5.7 MB measured), so the
 * bound holds one response. Past it the run aborts the transport, drains and commits the queue, then
 * reopens from `last` with backoff. Nothing is lost: what was dropped is after the committed cursor.
 *
 * "Live": CometD has no end-of-backlog marker, so catchingUp → live{quiet} after QUIET_MS without events
 * once one arrived, or when the first-event wait expires with none since the ack (`firstEventWait`,
 * `drainBoundOutcome`). That claims nothing about completeness: the cursor is exact. A clean end (quiet,
 * aborted, timeLimit) of a run that is `live` re-sends `last`, which refreshes `updatedAt`, so a quiet
 * stream captured daily never looks older than retention to `chooseStart`.
 */

import { AlvError } from '../../errors.js';
import type {
  CustomLogCaptureAllowance,
  CustomLogCaptureOutcome,
  CustomLogCaptureParams,
  CustomLogCaptureResult,
  CustomLogCaptureState,
  CustomLogCaptureUpdate,
  CustomLogErrorCode,
  CustomLogPayloadField,
  CustomLogRow,
  CustomLogStoreGap,
  CustomLogStoreInfo
} from '../contracts.js';
import { customLogError } from '../errors.js';
import type { CustomLogContext } from '../registry.js';
import { assertNever, type ResolvedEventSource } from '../resolved.js';
import type { ObjectDescribe } from '../schema.js';
import {
  DRAIN_DEFAULT_MS,
  DRAIN_MAX_MS,
  FLUSH_MAX,
  FLUSH_MS,
  MAX_AUTH_REBUILDS,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_EVENTS,
  QUIET_MS,
  RETAINED,
  STANDBY_POLL_MS,
  backoffMs,
  chooseStart,
  closesGap,
  deliveryBudget,
  drainBoundOutcome,
  firstEventWait,
  nextState,
  replayFrom,
  resumeAfter,
  storeGapOf,
  type Allowance,
  type FirstEventWait,
  type RunPosition,
  type StartDecision,
  type StateInput,
  type Start
} from './captureRules.js';
import { compareNewestFirst, type EventPosition } from './ids.js';
import {
  LeaseLostError,
  type EventStore,
  type EventStoreLocation,
  type EventStoreWriter,
  type StoreCoverage,
  type StoredEvent
} from './store.js';
import {
  TransportError,
  type BusEvent,
  type EventTransport,
  type TransportFailure,
  type TransportSignal
} from './transport.js';

/** Rows one standby relay sends at most; older ones show on the next list reload. */
const RELAY_MAX = FLUSH_MAX;

/** Time, injected: tests drive timers by hand. */
export type CaptureClock = {
  now(): Date;
  /** Runs `run` once after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
};

export const systemClock: CaptureClock = {
  now: () => new Date(),
  after: (ms, run) => {
    const handle = setTimeout(run, ms);
    return () => clearTimeout(handle);
  }
};

export type CaptureSession = { ctx: CustomLogContext; orgId: string };

export type RowView = { rows: CustomLogRow[]; payloadFields: CustomLogPayloadField[] };

/**
 * Decodes stored events into the rows one watcher shows: its mapping, its filter, its payload paths.
 * The facade passes the same decoder `list` uses, so a live row and a listed row cannot differ.
 */
export type RowDecoder = (
  source: ResolvedEventSource,
  events: readonly StoredEvent[],
  view: Pick<CustomLogCaptureParams, 'filter' | 'payloadFields'>
) => RowView;

/** What a run needs from the outside. The facade builds it; tests pass fakes. */
export type CaptureDeps = {
  /** Called once per run. `onDropped` receives the running count of malformed messages the transport discarded. */
  createTransport(hooks: { onDropped(count: number): void }): EventTransport;
  /** Opens or reuses the org connection; `fresh` evicts the cached one first (auth failure mid-stream). */
  connect(options: { fresh: boolean; signal: AbortSignal }): Promise<CaptureSession>;
  /** Live describe of the event object, through the registry's memo. `object` is the name the store is keyed by, as the caller wrote it. */
  describe(ctx: CustomLogContext, object: string, signal: AbortSignal): Promise<ObjectDescribe>;
  /** The store handle for a location. The facade memoizes it, so the same location answers the same store. */
  openStore(location: EventStoreLocation): EventStore;
  /** The store's coverage as every event result reports it: the one mapping `list`, `get` and `capture` share. */
  storeInfo(coverage: StoreCoverage): CustomLogStoreInfo;
  /** `DailyDeliveredPlatformEvents` from `/limits`; undefined when the org will not say. */
  readAllowance(ctx: CustomLogContext, signal: AbortSignal): Promise<Allowance | undefined>;
  decodeRows: RowDecoder;
  /** Days of history `purge` keeps at the start of a run. */
  retentionDays: number;
  surface: 'vscode' | 'cli';
  clock: CaptureClock;
  /** Telemetry: one start and one end per run (not per watcher), never per event. */
  onRunEvent?(event: CaptureRunEvent): void;
  /** A watcher callback, the row decoder or `onRunEvent` threw. A watcher that threw is detached; the run goes on. */
  onCallbackError?(error: unknown): void;
};

/** Bounded fields only: no payload, id, cursor or org value. `gaps` counts gaps this run created. `from: 'none'` is a run that never chose a start point. */
export type CaptureRunEvent =
  | { type: 'start'; from: 'position' | 'retained' | 'new' | 'standby' | 'none' }
  | {
      type: 'end';
      outcome: CustomLogCaptureOutcome | 'failed';
      code?: string;
      durationMs: number;
      delivered: number;
      stored: number;
      gaps: number;
      reconnects: number;
      dropped: number;
    };

/** A watcher: one caller of `customLog.capture`, with its own mapping, filter and drain/follow mode. */
export type CaptureWatcher = {
  source: ResolvedEventSource;
  params: Pick<CustomLogCaptureParams, 'follow' | 'initial' | 'filter' | 'payloadFields' | 'maxDurationMs'>;
  signal: AbortSignal;
  onUpdate?(update: CustomLogCaptureUpdate): void;
};

export type CaptureHub = {
  /**
   * Joins the run for this store (starting it when absent) and resolves when this watcher is done:
   * drain → at live (`quiet`), at `maxDurationMs` (`timeLimit`), at the budget (`budget`), or at once
   * with `capturedElsewhere` when another process holds the lease; follow → when its signal aborts, or at
   * once with `needsInitial`. Rejects with the run's terminal error (an AlvError with a CUSTOM_LOG_* code
   * for everything capture raises). `initial` of the FIRST watcher of a run wins; it only matters for a
   * store without a usable position. A watcher that arrives while the run is closing waits for it and
   * starts the next one.
   */
  watch(location: EventStoreLocation, watcher: CaptureWatcher, deps: CaptureDeps): Promise<CustomLogCaptureResult>;
  /** Facade dispose: ends every run now (no linger), releases leases, and resolves when all are closed. */
  dispose(): Promise<void>;
};

type Run = {
  readonly closed: Promise<void>;
  accepting(): boolean;
  join(watcher: CaptureWatcher): Promise<CustomLogCaptureResult>;
  abort(): void;
};

export function createCaptureHub(): CaptureHub {
  const runs = new Map<string, Run>();
  let disposed = false;

  return {
    async watch(location, watcher, deps) {
      const store = deps.openStore(location);
      if (disposed || watcher.signal.aborted) return resultWithoutRun(store, watcher, deps);
      const key = store.eventsRoot;
      for (;;) {
        const existing = runs.get(key);
        if (!existing) {
          const { run, result } = createRun(store, deps, watcher);
          runs.set(key, run);
          void run.closed.then(() => {
            if (runs.get(key) === run) runs.delete(key);
          });
          return result;
        }
        if (existing.accepting()) return existing.join(watcher);
        await existing.closed;
        if (runs.get(key) === existing) runs.delete(key);
      }
    },

    async dispose() {
      disposed = true;
      const open = [...runs.values()];
      for (const run of open) run.abort();
      await Promise.all(open.map(run => run.closed));
    }
  };
}

const sourceRef = (source: ResolvedEventSource) => ({ id: source.id, label: source.label, shape: source.shape.kind });

async function resultWithoutRun(
  store: EventStore,
  watcher: CaptureWatcher,
  deps: CaptureDeps
): Promise<CustomLogCaptureResult> {
  return {
    source: sourceRef(watcher.source),
    outcome: 'aborted',
    delivered: 0,
    stored: 0,
    newGaps: [],
    store: deps.storeInfo(await store.coverage())
  };
}

// ---------------------------------------------------------------------------------------------
// The run

/** Why the stream has to stop, and what follows. Requests rank: a later one replaces an earlier one only if it ranks higher. */
type StopRequest =
  | { kind: 'failed'; error: unknown }
  | { kind: 'finish'; outcome: CustomLogCaptureOutcome }
  | { kind: 'leaseLost' }
  | { kind: 'overflow' };

const STOP_RANK = { failed: 3, finish: 2, leaseLost: 1, overflow: 0 } as const satisfies Record<
  StopRequest['kind'],
  number
>;

const isTerminal = (request: StopRequest | undefined): boolean =>
  request?.kind === 'failed' || request?.kind === 'finish';

/** How a run ends. */
type RunEnd = { kind: 'outcome'; outcome: CustomLogCaptureOutcome } | { kind: 'failed'; error: unknown };

type EpochExit = { kind: 'end'; end: RunEnd } | { kind: 'standby' };

/** Outcomes whose end of a live run re-sends the last position to refresh `updatedAt`. */
const CLEAN_ENDS: ReadonlySet<CustomLogCaptureOutcome> = new Set(['quiet', 'aborted', 'timeLimit']);

/** Transport failures with a code of their own; `cursorRejected` and `authRejected` are recoverable. */
const FAILURE_CODES = {
  forbidden: 'CUSTOM_LOG_SUBSCRIBE_FORBIDDEN',
  clientLimit: 'CUSTOM_LOG_CLIENT_LIMIT',
  deliveryLimit: 'CUSTOM_LOG_DELIVERY_LIMIT',
  other: 'CUSTOM_LOG_CAPTURE_FAILED'
} as const satisfies Record<Exclude<TransportFailure['kind'], 'cursorRejected' | 'authRejected'>, CustomLogErrorCode>;

type WatcherState = {
  readonly watcher: CaptureWatcher;
  /** Run totals when the watcher joined, so its result counts only its own time. */
  readonly base: { delivered: number; stored: number; gaps: number };
  readonly settle: { resolve(result: CustomLogCaptureResult): void; reject(error: unknown): void };
  detached: boolean;
  cancelBound: () => void;
  cancelAbort: () => void;
};

/** Everything `prepare` decides before a subscription, kept for the stream. */
type Prepared = {
  session: CaptureSession;
  decision: StartDecision;
  budget: number;
  confirmedAt: string | undefined;
};

const noop = (): void => {};
const NO_ROWS: RowView = { rows: [], payloadFields: [] };
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isAbort = (error: unknown): boolean => error instanceof AlvError && error.code === 'ABORTED';
const captureFailed = (message: string): AlvError => customLogError('CUSTOM_LOG_CAPTURE_FAILED', message);

/** A code of the Custom Logs contract for the public `failed` state; anything else reads as the generic failure. */
const customCodeOf = (error: unknown): CustomLogErrorCode =>
  error instanceof AlvError && error.code.startsWith('CUSTOM_LOG_')
    ? (error.code as CustomLogErrorCode)
    : 'CUSTOM_LOG_CAPTURE_FAILED';

const boundMs = (maxDurationMs: number | undefined): number =>
  maxDurationMs === undefined ? DRAIN_DEFAULT_MS : Math.min(Math.max(maxDurationMs, 1), DRAIN_MAX_MS);

function createRun(
  store: EventStore,
  deps: CaptureDeps,
  first: CaptureWatcher
): { run: Run; result: Promise<CustomLogCaptureResult> } {
  const { clock } = deps;
  const event = first.source.shape.event;
  const initial = first.params.initial ?? 'retained';
  const startedAtMs = clock.now().getTime();
  const runAbort = new AbortController();
  const watchers = new Set<WatcherState>();
  /** Watchers that left as the last one: they settle when the run has flushed, ended its stream and released the lease. */
  const awaiting: { w: WatcherState; outcome: CustomLogCaptureOutcome }[] = [];

  let delivered = 0;
  let stored = 0;
  let reconnects = 0;
  let dropped = 0;
  let rejections = 0;
  const newGaps: CustomLogStoreGap[] = [];
  const transport = deps.createTransport({
    onDropped: count => {
      dropped = count;
    }
  });

  let state: CustomLogCaptureState = { state: 'connecting' };
  let storeInfo: CustomLogStoreInfo | undefined;
  let allowance: CustomLogCaptureAllowance | undefined;
  let concluded = false;
  let stopRequest: StopRequest | undefined;
  let attemptAbort: AbortController | undefined;
  let startReported = false;
  /** The wait for the first server response and what arrived since the ack: the inputs of `drainBoundOutcome`. */
  const waiting: { wait: FirstEventWait; deliveredSinceAck: number } = {
    wait: { kind: 'drainBound' },
    deliveredSinceAck: 0
  };
  let cancelLiveTimer: () => void = noop;
  let resolveClosed: () => void = noop;
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });

  // -------------------------------------------------------------------------------------------
  // state and watchers

  const anyFollow = (): boolean => [...watchers].some(w => w.watcher.params.follow);

  const deliver = (w: WatcherState, view: () => RowView): void => {
    if (w.detached || !w.watcher.onUpdate || !storeInfo) return;
    try {
      w.watcher.onUpdate({ capture: state, store: storeInfo, ...view(), ...(allowance ? { allowance } : {}) });
    } catch (error) {
      w.detached = true;
      deps.onCallbackError?.(error);
    }
  };

  const broadcast = (): void => {
    for (const w of [...watchers]) deliver(w, () => NO_ROWS);
  };

  const fanOut = (events: readonly StoredEvent[]): void => {
    for (const w of [...watchers]) {
      deliver(w, () => deps.decodeRows(w.watcher.source, events, w.watcher.params));
    }
  };

  const transition = (input: StateInput): void => {
    const next = nextState(state, input);
    if (next === state) return;
    state = next;
    broadcast();
  };

  const refreshStoreInfo = async (): Promise<void> => {
    storeInfo = deps.storeInfo(await store.coverage());
  };

  const report = (runEvent: CaptureRunEvent): void => {
    try {
      deps.onRunEvent?.(runEvent);
    } catch (error) {
      deps.onCallbackError?.(error);
    }
  };

  const reportStart = (from: Extract<CaptureRunEvent, { type: 'start' }>['from']): void => {
    if (startReported) return;
    startReported = true;
    report({ type: 'start', from });
  };

  const resultFor = async (w: WatcherState, outcome: CustomLogCaptureOutcome): Promise<CustomLogCaptureResult> => ({
    source: sourceRef(w.watcher.source),
    outcome,
    delivered: delivered - w.base.delivered,
    stored: stored - w.base.stored,
    newGaps: newGaps.slice(w.base.gaps),
    store: deps.storeInfo(await store.coverage())
  });

  const settle = async (w: WatcherState, outcome: CustomLogCaptureOutcome): Promise<void> => {
    try {
      w.settle.resolve(await resultFor(w, outcome));
    } catch (error) {
      w.settle.reject(error);
    }
  };

  const stop = (request: StopRequest): void => {
    if (stopRequest && STOP_RANK[stopRequest.kind] >= STOP_RANK[request.kind]) return;
    stopRequest = request;
    if (isTerminal(request)) runAbort.abort();
    attemptAbort?.abort();
  };

  const fail = (error: unknown): void => {
    // Aborting the connect or the sleep is how an orderly finish interrupts them; it is not a failure.
    if (stopRequest?.kind === 'finish' && isAbort(error)) return;
    stop({ kind: 'failed', error });
  };

  const leave = (w: WatcherState, outcome: CustomLogCaptureOutcome): void => {
    if (!watchers.delete(w)) return;
    w.cancelBound();
    w.cancelAbort();
    if (watchers.size > 0) {
      void settle(w, outcome);
      return;
    }
    awaiting.push({ w, outcome });
    stop({ kind: 'finish', outcome });
  };

  /** A drain has nothing to wait for when the run is already live or another process captures. */
  const endEarly = (w: WatcherState): void => {
    if (w.watcher.params.follow) return;
    if (state.state === 'live') leave(w, 'quiet');
    else if (state.state === 'standby') leave(w, 'capturedElsewhere');
  };

  const becomeLive = (): void => {
    transition({ type: 'quiet' });
    if (state.state !== 'live') return;
    for (const w of [...watchers]) if (!w.watcher.params.follow) leave(w, 'quiet');
  };

  const armLiveTimer = (ms: number): void => {
    cancelLiveTimer();
    cancelLiveTimer = clock.after(ms, becomeLive);
  };

  const onBound = (w: WatcherState): void => {
    const { enterLive, outcome } = drainBoundOutcome({
      wait: waiting.wait,
      transportUp: state.state === 'catchingUp',
      deliveredSinceAck: waiting.deliveredSinceAck
    });
    if (enterLive) becomeLive();
    leave(w, outcome);
  };

  const join = (watcher: CaptureWatcher): Promise<CustomLogCaptureResult> =>
    new Promise((resolve, reject) => {
      const w: WatcherState = {
        watcher,
        base: { delivered, stored, gaps: newGaps.length },
        settle: { resolve, reject },
        detached: false,
        cancelBound: noop,
        cancelAbort: noop
      };
      watchers.add(w);
      const onAbort = (): void => leave(w, 'aborted');
      watcher.signal.addEventListener('abort', onAbort, { once: true });
      w.cancelAbort = () => watcher.signal.removeEventListener('abort', onAbort);
      if (!watcher.params.follow) w.cancelBound = clock.after(boundMs(watcher.params.maxDurationMs), () => onBound(w));
      deliver(w, () => NO_ROWS);
      endEarly(w);
    });

  // -------------------------------------------------------------------------------------------
  // time

  const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => {
      const { signal } = runAbort;
      if (signal.aborted) return resolve();
      const cancel = clock.after(ms, () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
      const onAbort = (): void => {
        cancel();
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

  // -------------------------------------------------------------------------------------------
  // lease: win it, or stand by and relay what the holder stores

  const newestPosition = async (): Promise<EventPosition | undefined> => {
    for await (const newest of store.newestFirst({})) return newest.position;
    return undefined;
  };

  /** Rows the holder stored since `sentUpTo`, oldest first. Late events older than it show on the next list reload. */
  const relay = async (sentUpTo: EventPosition | undefined): Promise<EventPosition | undefined> => {
    const fresh: StoredEvent[] = [];
    for await (const candidate of store.newestFirst({})) {
      if (sentUpTo && compareNewestFirst(candidate.position, sentUpTo) >= 0) break;
      fresh.push(candidate);
      if (fresh.length >= RELAY_MAX) break;
    }
    if (fresh.length === 0) return sentUpTo;
    fresh.reverse();
    await refreshStoreInfo();
    fanOut(fresh);
    return fresh[fresh.length - 1]!.position;
  };

  const acquire = async (): Promise<EventStoreWriter | undefined> => {
    let sentUpTo: EventPosition | undefined;
    let standingBy = false;
    for (;;) {
      if (isTerminal(stopRequest)) return undefined;
      const attempt = await store.openWriter(deps.surface);
      if ('writer' in attempt) return attempt.writer;
      if (!standingBy) {
        standingBy = true;
        sentUpTo = await newestPosition();
        reportStart('standby');
      }
      transition({ type: 'standby', holder: attempt.heldBy });
      for (const w of [...watchers]) endEarly(w);
      if (isTerminal(stopRequest)) return undefined;
      await sleep(STANDBY_POLL_MS);
      if (isTerminal(stopRequest)) return undefined;
      sentUpTo = await relay(sentUpTo);
    }
  };

  // -------------------------------------------------------------------------------------------
  // prepare: everything decided before the first subscribe

  const prepare = async (writer: EventStoreWriter): Promise<Prepared> => {
    const { signal } = runAbort;
    transition({ type: 'connecting' });
    const session = await deps.connect({ fresh: false, signal });
    const remaining = await deps.readAllowance(session.ctx, signal);
    const budget = deliveryBudget(remaining);
    allowance = { ...(remaining ? { remaining: remaining.remaining, max: remaining.max } : {}), budget };
    await writer.writeDescribe(await deps.describe(session.ctx, store.location.object, signal));
    await writer.purge(deps.retentionDays, clock.now());
    const checkpoint = await store.checkpoint();
    const decision = chooseStart({
      checkpoint,
      orgId: session.orgId,
      transport: transport.name,
      initial,
      now: clock.now()
    });
    if (decision.gap) {
      const opened = await writer.openGap(decision.gap);
      if (opened.created) newGaps.push(storeGapOf(opened.gap));
    }
    reportStart(
      decision.kind === 'needsInitial' ? 'none' : decision.start.kind === 'after' ? 'position' : decision.start.kind
    );
    return { session, decision, budget, confirmedAt: checkpoint?.updatedAt };
  };

  // -------------------------------------------------------------------------------------------
  // stream: one lease, from the first subscribe until the run has to stop

  const stream = async (writer: EventStoreWriter, prepared: Prepared, initialStart: Start): Promise<void> => {
    let { session } = prepared;
    let { confirmedAt } = prepared;
    let activeStart = initialStart;
    let last: RunPosition | undefined = initialStart.kind === 'after' ? initialStart.position : undefined;
    if (initialStart.kind === 'retained') await writer.rememberStored();
    const deliveredAtStart = delivered;
    const retry = { attempt: 0, auth: 0 };
    let queue: BusEvent[] = [];
    let queueBytes = 0;
    let flushing: Promise<void> = Promise.resolve();
    let cancelFlushTimer: (() => void) | undefined;

    /** After a failure or a lost lease nothing more may be written; what the transport still delivered is dropped. */
    const writable = (): boolean => stopRequest?.kind !== 'failed' && stopRequest?.kind !== 'leaseLost';

    const flushOnce = async (): Promise<void> => {
      const batch = queue;
      queue = [];
      queueBytes = 0;
      const tail = batch[batch.length - 1];
      if (!tail || !writable()) return;
      let newlyStored: readonly StoredEvent[];
      try {
        newlyStored = (await writer.append(batch)).stored;
        const newest = newlyStored[newlyStored.length - 1];
        const next: RunPosition = {
          cursor: tail.cursor,
          lastEvent: newest
            ? { createdDate: newest.createdDate, uuid: newest.position.uuid }
            : (last?.lastEvent ?? { createdDate: tail.createdDate, uuid: tail.uuid })
        };
        await writer.advance({ orgId: session.orgId, transport: transport.name, channel: event.channel, ...next });
        last = next;
        confirmedAt = clock.now().toISOString();
        stored += newlyStored.length;
        const gap = await writer.openGapNow();
        if (gap) {
          const closing = newlyStored
            .filter(candidate => closesGap(gap, { createdDate: candidate.createdDate, uuid: candidate.position.uuid }))
            .map(candidate => candidate.createdDate)
            .reduce<string | undefined>((min, date) => (min === undefined || date < min ? date : min), undefined);
          if (closing !== undefined) await writer.closeOpenGap(closing);
        }
        if (newlyStored.length > 0) await refreshStoreInfo();
      } catch (error) {
        if (error instanceof LeaseLostError) stop({ kind: 'leaseLost' });
        else fail(error);
        return;
      }
      if (newlyStored.length > 0) fanOut(newlyStored);
    };

    const flush = (): Promise<void> => {
      cancelFlushTimer?.();
      cancelFlushTimer = undefined;
      flushing = flushing.then(flushOnce);
      return flushing;
    };

    const onEvents = (events: readonly BusEvent[]): void => {
      if (events.length === 0) return;
      delivered += events.length;
      waiting.deliveredSinceAck += events.length;
      for (const received of events) {
        queue.push(received);
        queueBytes += received.bytes;
      }
      if (state.state === 'catchingUp') armLiveTimer(QUIET_MS);
      if (queue.length > QUEUE_MAX_EVENTS || queueBytes > QUEUE_MAX_BYTES) stop({ kind: 'overflow' });
      else if (queue.length >= FLUSH_MAX) void flush();
      else if (!cancelFlushTimer) {
        cancelFlushTimer = clock.after(FLUSH_MS, () => {
          cancelFlushTimer = undefined;
          void flush();
        });
      }
      if (delivered - deliveredAtStart >= prepared.budget) stop({ kind: 'finish', outcome: 'budget' });
    };

    const onSignal = (signal: TransportSignal): void => {
      switch (signal.type) {
        case 'subscribed': {
          retry.attempt = 0;
          retry.auth = 0;
          waiting.deliveredSinceAck = 0;
          const from = last ? 'after' : activeStart.kind;
          transition({ type: 'subscribed', from });
          // Decided from the watchers present at the acknowledgement; a follower that joins a drain later waits for events.
          waiting.wait = firstEventWait({
            from,
            checkpointUpdatedAt: confirmedAt,
            follow: anyFollow(),
            now: clock.now()
          });
          if (waiting.wait.kind === 'timer') armLiveTimer(waiting.wait.ms);
          else cancelLiveTimer();
          break;
        }
        case 'events':
          onEvents(signal.events);
          break;
        case 'down':
          reconnects += 1;
          cancelLiveTimer();
          transition({ type: 'down' });
          break;
        case 'up':
          transition({ type: 'up' });
          if (state.state === 'catchingUp') armLiveTimer(QUIET_MS);
          break;
        default:
          assertNever(signal, 'transport signal');
      }
    };

    type AttemptEnd =
      { kind: 'stopped' } | { kind: 'failure'; failure: TransportFailure } | { kind: 'crashed'; error: unknown };

    const openOnce = async (): Promise<AttemptEnd> => {
      attemptAbort = new AbortController();
      try {
        await transport.open({
          connection: session.ctx.connection,
          channel: event.channel,
          from: replayFrom(activeStart),
          durableCursor: () => last?.cursor,
          signal: attemptAbort.signal,
          onSignal
        });
        return { kind: 'stopped' };
      } catch (error) {
        return error instanceof TransportError
          ? { kind: 'failure', failure: error.failure }
          : { kind: 'crashed', error };
      } finally {
        attemptAbort = undefined;
        cancelLiveTimer();
      }
    };

    /** The state of a reconnect, then its backoff. A rejected cursor resubscribes at once. */
    const reconnect = async (cause: 'transport' | 'auth' | 'overflow', backoff: boolean): Promise<void> => {
      retry.attempt += 1;
      reconnects += 1;
      transition({ type: 'reconnecting', attempt: retry.attempt, cause });
      if (backoff) await sleep(backoffMs(retry.attempt));
    };

    const resume = (): Start => (last ? resumeAfter(last) : activeStart);

    /** Sets the start point of the next attempt after a transport failure, or ends the run with a failure. */
    const recover = async (failure: TransportFailure): Promise<void> => {
      switch (failure.kind) {
        case 'cursorRejected': {
          rejections += 1;
          if (rejections > 1) {
            fail(captureFailed('Salesforce rejected the retained replay too, so capture cannot resume.'));
            return;
          }
          const after = last?.lastEvent.createdDate;
          const opened = await writer.openGap({ reason: 'cursorRejected', ...(after !== undefined ? { after } : {}) });
          if (opened.created) newGaps.push(storeGapOf(opened.gap));
          last = undefined;
          activeStart = RETAINED;
          await writer.rememberStored();
          await reconnect('transport', false);
          return;
        }
        case 'authRejected':
          if (retry.auth >= MAX_AUTH_REBUILDS) {
            fail(
              captureFailed(
                `Salesforce kept rejecting the org credentials after ${MAX_AUTH_REBUILDS} reconnects. Log in again and restart capture.`
              )
            );
            return;
          }
          retry.auth += 1;
          await reconnect('auth', true);
          if (isTerminal(stopRequest)) return;
          session = await deps.connect({ fresh: true, signal: runAbort.signal });
          activeStart = resume();
          return;
        case 'forbidden':
        case 'clientLimit':
        case 'deliveryLimit':
        case 'other':
          fail(customLogError(FAILURE_CODES[failure.kind], failure.message));
          return;
        default:
          return assertNever(failure, 'transport failure');
      }
    };

    /** The clean end of a live run re-sends the last position, so a quiet stream never looks older than retention. */
    const cleanEnd = async (): Promise<void> => {
      const request = stopRequest;
      if (request?.kind !== 'finish' || !CLEAN_ENDS.has(request.outcome)) return;
      if (state.state !== 'live' || !last) return;
      try {
        await writer.advance({ orgId: session.orgId, transport: transport.name, channel: event.channel, ...last });
      } catch (error) {
        if (!(error instanceof LeaseLostError)) fail(error);
      }
    };

    waiting.wait = { kind: 'drainBound' };
    waiting.deliveredSinceAck = 0;
    while (!isTerminal(stopRequest)) {
      const ended = await openOnce();
      // Whatever the transport delivered goes to disk before anything else happens.
      await flush();
      if (isTerminal(stopRequest) || stopRequest?.kind === 'leaseLost') break;
      if (stopRequest?.kind === 'overflow') {
        stopRequest = undefined;
        activeStart = resume();
        await reconnect('overflow', true);
        continue;
      }
      if (ended.kind === 'crashed') fail(ended.error);
      else if (ended.kind === 'stopped') fail(captureFailed('The event transport stopped without being asked to.'));
      else await recover(ended.failure);
    }
    await cleanEnd();
  };

  // -------------------------------------------------------------------------------------------
  // one lease from start to release

  const epoch = async (writer: EventStoreWriter): Promise<EpochExit> => {
    try {
      const prepared = await prepare(writer);
      if (prepared.decision.kind === 'needsInitial') stop({ kind: 'finish', outcome: 'needsInitial' });
      else await stream(writer, prepared, prepared.decision.start);
    } catch (error) {
      fail(error);
    }
    const request = stopRequest;
    let releaseError: unknown;
    try {
      await writer.release();
    } catch (error) {
      releaseError = error;
    }
    if (request?.kind === 'leaseLost') {
      stopRequest = undefined;
      return { kind: 'standby' };
    }
    if (releaseError !== undefined && request?.kind !== 'failed') {
      return { kind: 'end', end: { kind: 'failed', error: releaseError } };
    }
    return { kind: 'end', end: endOf(request) };
  };

  const endOf = (request: StopRequest | undefined): RunEnd =>
    request?.kind === 'failed'
      ? { kind: 'failed', error: request.error }
      : { kind: 'outcome', outcome: request?.kind === 'finish' ? request.outcome : 'aborted' };

  const lifecycle = async (): Promise<RunEnd> => {
    for (;;) {
      const writer = await acquire();
      if (!writer) return endOf(stopRequest);
      const exit = await epoch(writer);
      if (exit.kind === 'end') return exit.end;
      // The lease was taken from this process: look at it again, which stands by when someone else holds it.
    }
  };

  const conclude = async (end: RunEnd): Promise<void> => {
    concluded = true;
    cancelLiveTimer();
    for (const w of watchers) {
      w.cancelBound();
      w.cancelAbort();
    }
    try {
      await refreshStoreInfo();
    } catch {
      // The store failure that ended the run is already the error to report.
    }
    transition(
      end.kind === 'failed'
        ? { type: 'failed', code: customCodeOf(end.error), message: messageOf(end.error) }
        : { type: 'stopped', outcome: end.outcome }
    );
    reportStart('none');
    report({
      type: 'end',
      outcome: end.kind === 'failed' ? 'failed' : end.outcome,
      ...(end.kind === 'failed' ? { code: end.error instanceof AlvError ? end.error.code : 'UNKNOWN' } : {}),
      durationMs: clock.now().getTime() - startedAtMs,
      delivered,
      stored,
      gaps: newGaps.length,
      reconnects,
      dropped
    });
    const outcome = end.kind === 'outcome' ? end.outcome : 'aborted';
    const everyone = [...awaiting, ...[...watchers].map(w => ({ w, outcome }))];
    watchers.clear();
    await Promise.all(
      everyone.map(entry => (end.kind === 'failed' ? entry.w.settle.reject(end.error) : settle(entry.w, entry.outcome)))
    );
  };

  const drive = async (): Promise<void> => {
    let end: RunEnd;
    try {
      await refreshStoreInfo();
      broadcast();
      end = await lifecycle();
    } catch (error) {
      end = stopRequest?.kind === 'finish' && isAbort(error) ? endOf(stopRequest) : { kind: 'failed', error };
    }
    try {
      await conclude(end);
    } finally {
      resolveClosed();
    }
  };

  const run: Run = {
    closed,
    accepting: () => !concluded && !isTerminal(stopRequest),
    join,
    abort: () => {
      for (const w of [...watchers]) leave(w, 'aborted');
    }
  };
  const result = join(first);
  void drive();
  return { run, result };
}
