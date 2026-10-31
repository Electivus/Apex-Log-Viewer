/**
 * The transport seam. It moves platform events off the wire and nothing else: no store, no
 * checkpoint, no gap, no retry policy, no queue bound. `capture.ts` owns all policy, so a Pub/Sub
 * adapter later implements this one type and changes no other file.
 *
 * Wire facts stay behind it: Bayeux channels and extensions, `ext.replay`, Faye's deferred
 * disconnect, `400::` / `403::` strings, Avro for Pub/Sub. What crosses it is parsed domain data.
 */

import type { Connection } from '@salesforce/core';

import type { EventUuid, ReplayCursor } from './ids.js';

export type ReplayFrom =
  /** CometD -1 / Pub/Sub LATEST. */
  | { readonly kind: 'new' }
  /** CometD -2 / Pub/Sub EARLIEST: everything still retained. Spends one delivery per retained event, stored or not. */
  | { readonly kind: 'retained' }
  /** Everything after this event (exclusive, measured). */
  | { readonly kind: 'after'; readonly cursor: ReplayCursor };

/** One platform event as delivered, parsed at the adapter's boundary. */
export type BusEvent = Readonly<{
  uuid: EventUuid;
  cursor: ReplayCursor;
  /** `payload.CreatedDate`, ISO with milliseconds (measured). */
  createdDate: string;
  /** The payload's fields as delivered, including `CreatedById`. The store keeps all of them, nulls omitted. */
  payload: Readonly<Record<string, unknown>>;
  /** Serialized size of the message, for the run's queue bound. */
  bytes: number;
}>;

export type TransportFailure =
  /** The `after` cursor was refused (`400::The replayId ... invalid`): outside retention, ahead of the bus, or from before a reset. Only possible with `after`. */
  | { readonly kind: 'cursorRejected' }
  /** `401::Authentication invalid` / advice.reconnect none. The connection's token is no longer accepted. */
  | { readonly kind: 'authRejected' }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'clientLimit'; readonly message: string }
  | { readonly kind: 'deliveryLimit'; readonly message: string }
  | { readonly kind: 'other'; readonly message: string };

export type TransportSignal =
  | { readonly type: 'subscribed' }
  /** One server response worth of events, in delivery order. */
  | { readonly type: 'events'; readonly events: readonly BusEvent[] }
  /** A delivery the adapter could not turn into a `BusEvent`. It arrives in delivery order: after the events delivered before it, before those delivered after. */
  | { readonly type: 'malformed' }
  | { readonly type: 'down' }
  | { readonly type: 'up' };

export type EventTransport = {
  readonly name: 'cometd' | 'pubsub';
  /**
   * Subscribe `channel` and report signals until `signal` aborts (resolves) or the subscription
   * fails for good (rejects with `TransportError`). Transient network loss is `down` then `up`; the
   * adapter reconnects by itself.
   *
   * Resume rule: on every (re)subscribe the adapter asks `durableCursor()`. When it returns a cursor,
   * that is the resume point; otherwise `from` is. The run returns the cursor it last checkpointed,
   * so a reconnect resumes from disk and never from an event that was only delivered. Events that
   * were delivered but not yet durable are re-delivered and the store dedupes them.
   *
   * Always leaves no open socket or timer behind (measured leak: `cancel()` alone, or `disconnect()`
   * before the handshake completes).
   */
  open(params: {
    connection: Connection;
    channel: string;
    from: ReplayFrom;
    durableCursor(): ReplayCursor | undefined;
    signal: AbortSignal;
    onSignal(signal: TransportSignal): void;
  }): Promise<void>;
};

export class TransportError extends Error {
  constructor(readonly failure: TransportFailure) {
    super(`Event transport failed: ${failure.kind}`);
  }
}
