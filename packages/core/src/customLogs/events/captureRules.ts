/**
 * The pure policy of event capture, apart from the run that applies it: where a run starts, how much
 * it may spend, how long it waits for the first event, how a drain ends, and which public state each
 * transport signal leads to. `capture.ts` holds the run (I/O, timers, watchers); everything here is a
 * function of its input, so the tables in `customLogsCaptureRules.test.ts` cover it without a store.
 */

import type {
  CustomLogCaptureOutcome,
  CustomLogCaptureState,
  CustomLogErrorCode,
  CustomLogStoreGap
} from '../contracts.js';
import { assertNever } from '../resolved.js';
import type { EventUuid, ReplayCursor } from './ids.js';
import type { EventCheckpoint, GapReason, OpenGap } from './store.js';
import type { ReplayFrom } from './transport.js';

export const FLUSH_MS = 250;
export const FLUSH_MAX = 1_000;
export const QUIET_MS = 10_000;
/** First-event wait for `new` and for a cursor younger than FRESH_CURSOR_MS; see `firstEventWait`. */
export const FIRST_EVENT_WAIT_MS = 15_000;
export const FRESH_CURSOR_MS = 60 * 60 * 1000;
export const STANDBY_POLL_MS = 2_000;
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;
/** After this many consecutive auth rebuilds without a `subscribed`, the run fails (credentials are gone, not stale). */
export const MAX_AUTH_REBUILDS = 3;
export const DRAIN_DEFAULT_MS = 120_000;
/** The longest drain a caller may ask for (`CustomLogCaptureParams.maxDurationMs`). */
export const DRAIN_MAX_MS = 3_600_000;
/** Queue bound: one measured response (870 events, 5.7 MB) fits; a 1 MB event fits. */
export const QUEUE_MAX_EVENTS = 2_000;
export const QUEUE_MAX_BYTES = 32 * 1024 * 1024;
/** High-volume platform events are retained 72 h. A stored position older than this may be accepted and still skip expired events. */
export const PLATFORM_RETENTION_MS = 72 * 60 * 60 * 1000;
export const BUDGET_SHARE = 0.5;
export const BUDGET_FALLBACK = 5_000;

/** `DailyDeliveredPlatformEvents` from `/limits`. */
export type Allowance = { remaining: number; max: number };

/**
 * What a run last advanced: the resume point and the newest event stored with it. Seeded from the
 * checkpoint when the run resumes `after` its cursor, replaced by every flush's `advance` (after it
 * resolved), cleared by a rejected cursor, and re-sent unchanged by the clean-end `advance`.
 */
export type RunPosition = { readonly cursor: ReplayCursor; readonly lastEvent: EventCheckpoint['lastEvent'] };

/** Where a subscription begins. An `after` start always carries the position it resumes from. */
export type Start =
  { readonly kind: 'new' } | { readonly kind: 'retained' } | { readonly kind: 'after'; readonly position: RunPosition };

export const RETAINED: Start = { kind: 'retained' };

export const replayFrom = (start: Start): ReplayFrom =>
  start.kind === 'after' ? { kind: 'after', cursor: start.position.cursor } : { kind: start.kind };

export const resumeAfter = (position: RunPosition): Start => ({ kind: 'after', position });

export type StartDecision =
  | { kind: 'subscribe'; start: Start; gap?: { reason: GapReason; after?: string } }
  | { kind: 'needsInitial'; gap?: { reason: 'orgChanged'; after: string } };

/**
 * Pure: the start point. The single source of truth is the checkpoint.
 *
 *   no checkpoint                                  → initial: retained | new → subscribe; none → needsInitial
 *   checkpoint.orgId !== orgId                     → gap orgChanged (after = lastEvent.createdDate), then as "no checkpoint"
 *   checkpoint.transport !== transport             → subscribe retained, no gap (cursors are not portable; dedupe absorbs overlap)
 *   now - checkpoint.updatedAt > PLATFORM_RETENTION_MS → subscribe after(cursor) with gap retentionElapsed (after = lastEvent.createdDate):
 *                                                    Salesforce may accept the id and still start at the oldest retained event (measured:
 *                                                    ids far below the oldest retained were accepted), so acceptance proves nothing.
 *                                                    `updatedAt`, not `lastEvent.createdDate`: every flush and every clean end of a live
 *                                                    run refresh it, so a stream that publishes every four days and is captured daily
 *                                                    raises no gap. An unreadable `updatedAt` counts as elapsed.
 *   otherwise                                      → subscribe after(cursor)
 */
export function chooseStart(input: {
  checkpoint: Pick<EventCheckpoint, 'orgId' | 'transport' | 'cursor' | 'lastEvent' | 'updatedAt'> | undefined;
  orgId: string;
  transport: 'cometd' | 'pubsub';
  initial: 'retained' | 'new' | 'none';
  now: Date;
}): StartDecision {
  const { checkpoint, orgId, transport, initial, now } = input;
  if (!checkpoint) return withoutPosition(initial);
  if (checkpoint.orgId !== orgId) {
    const gap = { reason: 'orgChanged', after: checkpoint.lastEvent.createdDate } as const;
    return initial === 'none' ? { kind: 'needsInitial', gap } : { kind: 'subscribe', start: { kind: initial }, gap };
  }
  if (checkpoint.transport !== transport) return { kind: 'subscribe', start: RETAINED };
  const start = resumeAfter({ cursor: checkpoint.cursor, lastEvent: checkpoint.lastEvent });
  const age = now.getTime() - Date.parse(checkpoint.updatedAt);
  return age <= PLATFORM_RETENTION_MS
    ? { kind: 'subscribe', start }
    : { kind: 'subscribe', start, gap: { reason: 'retentionElapsed', after: checkpoint.lastEvent.createdDate } };
}

function withoutPosition(initial: 'retained' | 'new' | 'none'): StartDecision {
  return initial === 'none' ? { kind: 'needsInitial' } : { kind: 'subscribe', start: { kind: initial } };
}

/** Pure: deliveries a run may spend, about: `floor(remaining * BUDGET_SHARE)`, or BUDGET_FALLBACK when /limits could not be read. Checked as events arrive, so one response can overshoot it. */
export function deliveryBudget(allowance: Allowance | undefined): number {
  return allowance === undefined ? BUDGET_FALLBACK : Math.max(0, Math.floor(allowance.remaining * BUDGET_SHARE));
}

/** What ends the wait for the first server response: a timer armed at the subscribe ack, or the drain's own bound. */
export type FirstEventWait = { kind: 'timer'; ms: number } | { kind: 'drainBound' };

/**
 * Pure: how a run waits for the first server response after the subscribe acknowledgement before it
 * treats the stream as live. `new`, or a cursor whose checkpoint is younger than FRESH_CURSOR_MS: a
 * FIRST_EVENT_WAIT_MS timer. `retained`, or an older cursor: a DRAIN_DEFAULT_MS timer when following,
 * and for a drain the drain bound itself (`maxDurationMs`), because first-byte latency grows with the
 * backlog (0.4 s for 1 event, 4.8 s for 870, measured) and a drain that gave up at 15 s would store
 * nothing and repeat on every run. A drain arms no second timer for it: see `drainBoundOutcome`.
 */
export function firstEventWait(input: {
  from: ReplayFrom['kind'];
  checkpointUpdatedAt: string | undefined;
  follow: boolean;
  now: Date;
}): FirstEventWait {
  const updatedAtMs = input.checkpointUpdatedAt === undefined ? Number.NaN : Date.parse(input.checkpointUpdatedAt);
  const youngCursor = input.from === 'after' && input.now.getTime() - updatedAtMs < FRESH_CURSOR_MS;
  if (input.from === 'new' || youngCursor) return { kind: 'timer', ms: FIRST_EVENT_WAIT_MS };
  return input.follow ? { kind: 'timer', ms: DRAIN_DEFAULT_MS } : { kind: 'drainBound' };
}

/**
 * Pure: how a drain ends when its bound (`maxDurationMs`, measured from the watcher's start) fires.
 * The bound and a wait timer start at different instants (the wait at the ack), so a drain over
 * `retained` or an old cursor never arms the timer: its wait IS the bound. When the bound fires with
 * the transport up and no event since the ack, the first-event wait has expired too, so the run enters
 * live{quiet} first and the drain ends `quiet` (the clean end then refreshes `updatedAt`). With an
 * event since the ack the run is still catching up, and before the ack or while reconnecting it never
 * reached live: both end `timeLimit`. A `timer` wait that the bound outran (a young cursor with
 * `--max-time` under 15 s) is `timeLimit` too.
 */
export function drainBoundOutcome(input: { wait: FirstEventWait; transportUp: boolean; deliveredSinceAck: number }): {
  enterLive: boolean;
  outcome: Extract<CustomLogCaptureOutcome, 'quiet' | 'timeLimit'>;
} {
  const waitExpired = input.wait.kind === 'drainBound' && input.transportUp && input.deliveredSinceAck === 0;
  return waitExpired ? { enterLive: true, outcome: 'quiet' } : { enterLive: false, outcome: 'timeLimit' };
}

/** Milliseconds a reconnect waits, by consecutive attempt (1-based). The last step repeats. */
export const backoffMs = (attempt: number): number =>
  RECONNECT_BACKOFF_MS[Math.min(Math.max(attempt, 1), RECONNECT_BACKOFF_MS.length) - 1]!;

type Holder = Extract<CustomLogCaptureState, { state: 'standby' }>['holder'];

/** Everything that moves the public state. A transport signal, a timer, or the run's own decision. */
export type StateInput =
  | { type: 'connecting' }
  | { type: 'standby'; holder: Holder }
  | { type: 'subscribed'; from: ReplayFrom['kind'] }
  | { type: 'quiet' }
  | { type: 'down' }
  | { type: 'up' }
  | { type: 'reconnecting'; attempt: number; cause: 'transport' | 'auth' | 'overflow' }
  | { type: 'stopped'; outcome: CustomLogCaptureOutcome }
  | { type: 'failed'; code: CustomLogErrorCode; message: string };

const sameHolder = (a: Holder, b: Holder): boolean =>
  a.surface === b.surface && a.pid === b.pid && a.host === b.host && a.since === b.since;

/**
 * Pure: the next public state. `stopped` and `failed` absorb every input. A transition that changes
 * nothing returns `current` itself, so the caller can tell by identity.
 *
 *   connecting ─ subscribed ─► catchingUp ─ quiet ─► live{quiet}
 *   catchingUp | live ─ down ─► reconnecting{transport} ─ up ─► catchingUp{position}
 *   any ─ subscribed ─► catchingUp (a re-handshake resubscribes)
 *   any ─ reconnecting | standby | connecting ─► that state
 */
export function nextState(current: CustomLogCaptureState, input: StateInput): CustomLogCaptureState {
  if (current.state === 'stopped' || current.state === 'failed') return current;
  switch (input.type) {
    case 'connecting':
      return current.state === 'connecting' ? current : { state: 'connecting' };
    case 'standby':
      return current.state === 'standby' && sameHolder(current.holder, input.holder)
        ? current
        : { state: 'standby', holder: input.holder };
    case 'subscribed':
      return { state: 'catchingUp', from: input.from === 'after' ? 'position' : input.from };
    case 'quiet':
      return current.state === 'catchingUp' ? { state: 'live', basis: 'quiet' } : current;
    case 'down':
      return current.state === 'catchingUp' || current.state === 'live'
        ? { state: 'reconnecting', attempt: 1, cause: 'transport' }
        : current;
    case 'up':
      return current.state === 'reconnecting' && current.cause === 'transport'
        ? { state: 'catchingUp', from: 'position' }
        : current;
    case 'reconnecting':
      return { state: 'reconnecting', attempt: input.attempt, cause: input.cause };
    case 'stopped':
      return { state: 'stopped', outcome: input.outcome };
    case 'failed':
      return { state: 'failed', code: input.code, message: input.message };
    default:
      return assertNever(input, 'capture state input');
  }
}

/** Pure: whether a stored event closes the open gap: it is newer than the newest event stored before the gap. */
export function closesGap(gap: { after?: string }, stored: { createdDate: string; uuid: EventUuid }): boolean {
  return gap.after === undefined || stored.createdDate > gap.after;
}

export const storeGapOf = (gap: OpenGap): CustomLogStoreGap => ({
  reason: gap.reason,
  ...(gap.after !== undefined ? { after: gap.after } : {}),
  detectedAt: gap.detectedAt
});
