import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type test from 'node:test';

import { saveOrgAuth } from './salesforceDouble.ts';

/**
 * A local HTTP Bayeux long-poll server that the real Faye client inside `@salesforce/core`'s
 * Connection talks to. It answers `/meta/handshake`, `/meta/subscribe`, `/meta/connect` (long polls
 * that return scripted events), `/meta/unsubscribe` and `/meta/disconnect` the way Salesforce does,
 * including the batching Faye uses (a `/meta/connect` sent with other messages carries
 * `advice.timeout: 0` and returns at once).
 */

export type RecordedEvent = {
  /** The HTTP response of the recording this event arrived in; the double ignores it. */
  batch: number;
  data: {
    schema: string;
    payload: Record<string, unknown>;
    event: { EventUuid: string; replayId: number; EventApiName: string };
  };
};

type Advice = { reconnect: 'none' | 'handshake' | 'retry' };

export type DoubleFailure = {
  error: string;
  advice?: Advice;
  /** Salesforce repeats the reason under `ext.sfdc.failureReason` on authentication failures. */
  failureReason?: string;
};

export type DoubleConnect =
  /** A long poll that answers with these messages (`data` as Faye hands it to the subscriber) after `delayMs`. */
  | { events: readonly { data: unknown }[]; delayMs?: number }
  /** A `/meta/connect` reply with `successful: false`. */
  | DoubleFailure
  /** The socket is destroyed before any reply. */
  | { dropConnection: true };

export type DoubleScript = {
  /** Every `/meta/handshake` is answered after `delayMs`, or refused. Default: immediately, successful. */
  handshake?: { delayMs?: number } | DoubleFailure;
  /** The first session's `/meta/subscribe`. Default: acknowledged. */
  subscribe?: { ok: true } | ({ ok: false } & DoubleFailure);
  /** Every later session's `/meta/subscribe`, after a re-handshake. Default: the same as `subscribe`. */
  resubscribe?: { ok: true } | ({ ok: false } & DoubleFailure);
  /** Each long poll takes the next item; once they run out a poll is held until the client disconnects. */
  connects?: readonly DoubleConnect[];
};

export type BayeuxDouble = {
  readonly instanceUrl: string;
  /** Stops listening and drops every connection, as an unreachable server does. Also runs when the test ends. */
  close(): Promise<void>;
  /** An org saved for this double in the isolated Salesforce home: `openConnection(username)` reaches it. */
  readonly username: string;
  /** `ext.replay` of every `/meta/subscribe` received, oldest first. */
  readonly replays: readonly unknown[];
  readonly handshakes: number;
  readonly disconnects: number;
  /** Long polls the double has not answered yet. */
  readonly heldPolls: number;
};

type BayeuxMessage = {
  id?: string;
  channel?: string;
  clientId?: string;
  subscription?: string;
  advice?: { timeout?: number };
  ext?: { replay?: unknown };
};

type Session = { id: string; index: number; channel: string | undefined };

const ADVICE = { reconnect: 'retry', interval: 0, timeout: 110_000 };
const UNKNOWN_CLIENT = {
  successful: false,
  error: '403::Unknown client',
  advice: { reconnect: 'handshake', interval: 0 }
};

export async function startBayeuxDouble(t: test.TestContext, script: DoubleScript = {}): Promise<BayeuxDouble> {
  const sessions = new Map<string, Session>();
  const held = new Map<string, Set<() => void>>();
  const connects = [...(script.connects ?? [])];
  const replays: unknown[] = [];
  const state = { handshakes: 0, disconnects: 0, heldPolls: 0 };

  const failure = (reply: DoubleFailure) => ({
    successful: false,
    error: reply.error,
    ...(reply.advice ? { advice: reply.advice } : {}),
    ...(reply.failureReason ? { ext: { sfdc: { failureReason: reply.failureReason } } } : {})
  });

  const hold = (clientId: string): Promise<void> =>
    new Promise(resolve => {
      const waiting = held.get(clientId) ?? new Set();
      held.set(clientId, waiting);
      const release = () => {
        waiting.delete(release);
        state.heldPolls -= 1;
        resolve();
      };
      waiting.add(release);
      state.heldPolls += 1;
    });

  const release = (clientId: string) => [...(held.get(clientId) ?? [])].forEach(resolve => resolve());

  async function answer(message: BayeuxMessage, response: http.ServerResponse): Promise<Record<string, unknown>[]> {
    const base = { id: message.id, channel: message.channel, clientId: message.clientId };
    const session = message.clientId ? sessions.get(message.clientId) : undefined;
    switch (message.channel) {
      case '/meta/handshake': {
        state.handshakes += 1;
        const plan = script.handshake;
        if (plan && 'delayMs' in plan && plan.delayMs) await new Promise(resolve => setTimeout(resolve, plan.delayMs));
        if (plan && 'error' in plan) return [{ id: message.id, channel: message.channel, ...failure(plan) }];
        const created: Session = { id: `client-${state.handshakes}`, index: state.handshakes - 1, channel: undefined };
        sessions.set(created.id, created);
        return [
          {
            id: message.id,
            channel: message.channel,
            successful: true,
            version: '1.0',
            clientId: created.id,
            supportedConnectionTypes: ['long-polling'],
            ext: { replay: true, 'payload.format': true },
            advice: ADVICE
          }
        ];
      }
      case '/meta/subscribe': {
        replays.push(message.ext?.replay);
        if (!session) return [{ ...base, ...UNKNOWN_CLIENT }];
        session.channel = message.subscription;
        const plan = (session.index === 0 ? script.subscribe : (script.resubscribe ?? script.subscribe)) ?? {
          ok: true
        };
        return [
          plan.ok
            ? { ...base, subscription: message.subscription, successful: true }
            : { ...base, subscription: message.subscription, ...failure(plan) }
        ];
      }
      case '/meta/connect': {
        if (!session) return [{ ...base, ...UNKNOWN_CLIENT }];
        const connected = { ...base, successful: true, advice: ADVICE };
        if (message.advice?.timeout === 0) return [connected];
        const next = connects.shift();
        if (!next) {
          await hold(session.id);
          return [connected];
        }
        if ('dropConnection' in next) {
          response.destroy();
          return [];
        }
        if ('error' in next) {
          if (next.advice?.reconnect === 'handshake') sessions.delete(session.id);
          return [{ ...base, ...failure(next) }];
        }
        if (next.delayMs) await new Promise(resolve => setTimeout(resolve, next.delayMs));
        return [...next.events.map(event => ({ channel: session.channel, data: event.data })), connected];
      }
      case '/meta/disconnect':
        state.disconnects += 1;
        if (session) {
          sessions.delete(session.id);
          release(session.id);
        }
        return [{ ...base, successful: true }];
      default:
        return [session ? { ...base, successful: true } : { ...base, ...UNKNOWN_CLIENT }];
    }
  }

  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/services/data') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ label: 'Test', url: '/services/data/v63.0', version: '63.0' }]));
      return;
    }
    if (request.method !== 'POST' || !request.url?.startsWith('/cometd/')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('[]');
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      void (async () => {
        const replies: Record<string, unknown>[] = [];
        for (const message of JSON.parse(Buffer.concat(chunks).toString('utf8')) as BayeuxMessage[]) {
          replies.push(...(await answer(message, response)));
        }
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(replies));
      })();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () =>
    new Promise<void>(resolve => {
      sessions.forEach((_, clientId) => release(clientId));
      server.closeAllConnections();
      server.close(() => resolve());
    });
  t.after(close);

  const { port } = server.address() as AddressInfo;
  const instanceUrl = `http://127.0.0.1:${port}`;
  const username = `bayeux-${port}@example.com`;
  await saveOrgAuth(username, instanceUrl);

  return {
    instanceUrl,
    close,
    username,
    replays,
    get handshakes() {
      return state.handshakes;
    },
    get disconnects() {
      return state.disconnects;
    },
    get heldPolls() {
      return state.heldPolls;
    }
  };
}

/** The sanitized events unit 0 recorded from the dedicated events org (`test/fixtures/customLogs/events`). */
export function recordedEvents(name: 'burst-870' | 'single'): RecordedEvent[] {
  const file = path.resolve(__dirname, `../../../../test/fixtures/customLogs/events/${name}.events.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RecordedEvent[];
}
