/**
 * CometD long-polling through the Faye client that core's `@salesforce/core` Connection already
 * exposes (`connection.streaming.createClient(extensions)`, inherited from jsforce). No new
 * dependency; jsforce's StreamingExtension classes are not imported (core does not declare
 * `@jsforce/jsforce-node`), so the extensions are inline `{ incoming, outgoing }` objects.
 *
 * Not `@salesforce/core`'s StreamingClient: it completes only when a processor says so, times out
 * after 3 min by default, cannot drop its replay extension, and hides `disconnect`.
 * Not Tail's `host/salesforce/streaming.ts`: extension-only, hard-coded channel and replay.
 * Not jsforce's `Replay` extension: it advances on delivery, which is the resume-past-unflushed bug.
 */

import { cometdCursor, parseEventUuid, readCursor, type ReplayCursor } from './ids.js';
import {
  TransportError,
  type BusEvent,
  type EventTransport,
  type ReplayFrom,
  type TransportFailure
} from './transport.js';

/** How long a stop waits for the server to acknowledge `/meta/disconnect` before it gives up. */
const DISCONNECT_GRACE_MS = 5_000;

/** The Faye surface this adapter touches. The typings jsforce exposes omit `disconnect`, `callback` and `on`, so the boundary is spelled here. */
type FayeMessage = {
  channel?: string;
  successful?: boolean;
  error?: string;
  advice?: { reconnect?: string };
  ext?: { sfdc?: { failureReason?: string } } & Record<string, unknown>;
  [key: string]: unknown;
};
type FayeExtension = {
  incoming?(message: FayeMessage, callback: (message: FayeMessage) => void): void;
  outgoing?(message: FayeMessage, callback: (message: FayeMessage) => void): void;
};
type FayeDeferred = { callback(listener: () => void): unknown; errback(listener: () => void): unknown };
type FayeClient = {
  subscribe(channel: string, listener: (data: unknown) => void): unknown;
  /** `undefined` until the handshake completes: Faye only disconnects a CONNECTED client. */
  disconnect(): FayeDeferred | undefined;
  /** Runs `listener` the next time the client is connected. */
  callback(listener: () => void): unknown;
  on(event: 'transport:down' | 'transport:up', listener: () => void): unknown;
  removeListener(event: 'transport:down' | 'transport:up', listener: () => void): unknown;
  _dispatcher?: {
    _envelopes?: Record<string, { timer?: NodeJS.Timeout | null }>;
    close?(): void;
  };
};

export function createCometdTransport(): EventTransport {
  return {
    name: 'cometd',
    async open({ connection, channel, from, durableCursor, signal, onSignal }) {
      replayValueFor(undefined, from); // refuses a start point CometD cannot send, before any request
      if (signal.aborted) return;

      return new Promise<void>((resolve, reject) => {
        let client: FayeClient | undefined;
        let closed = false;
        let pending: BusEvent[] = [];
        let flushHandle: NodeJS.Immediate | undefined;

        const onDown = () => onSignal({ type: 'down' });
        const onUp = () => onSignal({ type: 'up' });
        const onAbort = () => close(undefined);

        /** `hasSession` is false for a refused handshake: the server holds nothing to disconnect. */
        function close(failure: TransportFailure | undefined, hasSession = true): void {
          if (closed) return;
          closed = true;
          signal.removeEventListener('abort', onAbort);
          if (flushHandle) clearImmediate(flushHandle);
          pending = [];
          client?.removeListener('transport:down', onDown);
          client?.removeListener('transport:up', onUp);
          void (client && hasSession ? stopClient(client) : Promise.resolve()).then(() =>
            failure ? reject(new TransportError(failure)) : resolve()
          );
        }

        function flush(): void {
          if (flushHandle) clearImmediate(flushHandle);
          flushHandle = undefined;
          const events = pending;
          pending = [];
          if (!closed && events.length > 0) onSignal({ type: 'events', events });
        }

        /** `callback` is withheld on a terminal failure, so Faye neither retries nor polls again. */
        const protocol: FayeExtension = {
          outgoing(message, callback) {
            if (closed || message.channel !== '/meta/subscribe') return callback(message);
            try {
              message.ext = { ...message.ext, replay: { [channel]: replayValueFor(durableCursor(), from) } };
            } catch (error) {
              return close(otherFailure(error));
            }
            callback(message);
          },
          incoming(message, callback) {
            if (closed) return callback(message);
            const failure = failureOf(message);
            if (failure) return close(failure, message.channel !== '/meta/handshake');
            if (message.channel === '/meta/subscribe' && message.successful === true) {
              onSignal({ type: 'subscribed' });
            }
            callback(message);
          }
        };

        signal.addEventListener('abort', onAbort, { once: true });
        try {
          client = connection.streaming.createClient([protocol]) as unknown as FayeClient;
          client.on('transport:down', onDown);
          client.on('transport:up', onUp);
          client.subscribe(channel, data => {
            if (closed) return;
            const event = parseCometdEvent(data);
            if (!event) {
              // The events delivered before it go first, so the run sees it between its neighbours.
              flush();
              if (!closed) onSignal({ type: 'malformed' });
              return;
            }
            pending.push(event);
            flushHandle ??= setImmediate(flush);
          });
        } catch (error) {
          close(otherFailure(error));
        }
      });
    }
  };
}

const otherFailure = (error: unknown): TransportFailure => ({
  kind: 'other',
  message: error instanceof Error ? error.message : String(error)
});

/**
 * Stops a Faye client and resolves once the server acknowledged, or after the grace period.
 * Before the handshake completes `disconnect()` returns `undefined` and does nothing, which leaves
 * the handshake, the subscribe and the long poll running (measured leak), so it is deferred.
 */
function stopClient(client: FayeClient): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(grace);
      cancelRetries(client);
      resolve();
    };
    const grace = setTimeout(done, DISCONNECT_GRACE_MS);
    const settleOn = (disconnecting: FayeDeferred | undefined) => {
      if (!disconnecting) return done();
      disconnecting.callback(done);
      disconnecting.errback(done);
    };
    const first = client.disconnect();
    if (first) settleOn(first);
    else client.callback(() => settleOn(client.disconnect()));
  });
}

/**
 * Faye resends a request nobody answered every few seconds, forever, and has no way to cancel it, so
 * a stopped client whose connection dropped keeps a timer (and, while the server is unreachable, a
 * request) alive. jsforce reaches into `_dispatcher` the same way; with nothing there this does nothing.
 */
function cancelRetries(client: FayeClient): void {
  const dispatcher = client._dispatcher;
  for (const envelope of Object.values(dispatcher?._envelopes ?? {})) {
    if (envelope.timer) clearTimeout(envelope.timer);
  }
  dispatcher?.close?.();
}

/**
 * A reply that ends the subscription for good, or undefined when Faye should handle it (its own
 * `403::Unknown client` re-handshake, an ordinary success, an event).
 */
function failureOf(message: FayeMessage): TransportFailure | undefined {
  switch (message.channel) {
    case '/meta/subscribe':
      return message.successful === false ? classifyFailure(message.error ?? '') : undefined;
    case '/meta/connect':
    case '/meta/handshake': {
      const text = message.ext?.sfdc?.failureReason ?? message.error ?? '';
      const classified = classifyFailure(text);
      if (classified.kind === 'deliveryLimit' || classified.kind === 'clientLimit') return classified;
      return message.advice?.reconnect === 'none' ? { kind: 'authRejected' } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Streaming API error text, Bayeux `<code>:<args>:<message>`. Measured on `alv-events`: the `400::` replay
 * id refusal, `403:denied_by_security_policy:create_denied` for a user without Read on the event, and
 * `403::Organization concurrent user limit exceeded` (the handshake's `ext.sfdc.failureReason`). Documented,
 * not observed: `403::Restricted channel` and the daily delivery limit.
 */
export function classifyFailure(text: string): TransportFailure {
  if (/^400::.*replayId/i.test(text)) return { kind: 'cursorRejected' };
  if (/^401::/.test(text)) return { kind: 'authRejected' };
  if (/^403::Restricted channel/i.test(text) || /^403:denied_by_security_policy:/i.test(text)) {
    return { kind: 'forbidden', message: text };
  }
  if (/^403::.*total events daily limit/i.test(text)) return { kind: 'deliveryLimit', message: text };
  if (/^403::.*concurrent.*limit/i.test(text)) return { kind: 'clientLimit', message: text };
  return { kind: 'other', message: text };
}

/** The `ext.replay` value for a `/meta/subscribe`: the durable cursor wins, then `from`. */
export function replayValueFor(durable: ReplayCursor | undefined, from: ReplayFrom): number {
  const cursor = durable ?? (from.kind === 'after' ? from.cursor : undefined);
  if (!cursor) return from.kind === 'retained' ? -2 : -1;
  const { transport, value } = readCursor(cursor);
  const replayId = Number(value);
  if (transport !== 'cometd' || !Number.isSafeInteger(replayId) || replayId < 0) {
    throw new RangeError(`"${cursor}" is not a CometD replay cursor.`);
  }
  return replayId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses one Faye `data` payload (measured shape `{ schema, payload, event }`). Undefined for anything malformed. */
export function parseCometdEvent(data: unknown): BusEvent | undefined {
  if (!isRecord(data) || !isRecord(data.payload) || !isRecord(data.event)) return undefined;
  const { payload, event } = data;
  const uuid = parseEventUuid(event.EventUuid);
  const replayId = event.replayId;
  const createdDate = payload.CreatedDate;
  if (
    !uuid ||
    typeof replayId !== 'number' ||
    !Number.isSafeInteger(replayId) ||
    replayId < 0 ||
    typeof createdDate !== 'string' ||
    Number.isNaN(Date.parse(createdDate))
  ) {
    return undefined;
  }
  return { uuid, cursor: cometdCursor(replayId), createdDate, payload, bytes: Buffer.byteLength(JSON.stringify(data)) };
}
