import type { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { StreamingExtension, type Client as FayeClient, type Subscription } from '@jsforce/jsforce-node/lib/api/streaming';
import { createConnectionFromAuth as createBaseConnection, type JsforceConnectionLike } from './jsforce';
import type { OrgAuth } from './types';

export type { JsforceConnectionLike as Connection };

export type StreamProcessor = (message: Record<string, unknown>) => { completed: boolean; payload?: unknown };

export interface StreamingClient {
  handshake(): Promise<void>;
  replay(replayId: number): void;
  subscribe(): Promise<void>;
  disconnect(): void;
}

type StreamingClientFactory = (
  connection: JsforceConnectionLike,
  streamProcessor: StreamProcessor
) => Promise<StreamingClient> | StreamingClient;

let streamingClientFactoryForTests: StreamingClientFactory | undefined;

export function __setStreamingClientFactoryForTests(fn: StreamingClientFactory | undefined): void {
  streamingClientFactoryForTests = fn;
}

export function __resetStreamingClientFactoryForTests(): void {
  streamingClientFactoryForTests = undefined;
}

export async function createConnectionFromAuth(auth: OrgAuth, apiVersion: string): Promise<JsforceConnectionLike> {
  return createBaseConnection(auth, apiVersion);
}

export async function createLoggingStreamingClient(
  connection: JsforceConnectionLike,
  streamProcessor: StreamProcessor
): Promise<StreamingClient> {
  if (streamingClientFactoryForTests) {
    return await streamingClientFactoryForTests(connection, streamProcessor);
  }

  const channel = '/systemTopic/Logging';
  let client: FayeClient | undefined;
  let subscription: Subscription | undefined;
  let replayId: number = -1;
  let replayExtension: InstanceType<typeof StreamingExtension.Replay> | undefined;

  const ensureClient = (): FayeClient => {
    if (client) {
      return client;
    }
    const authFailure = new StreamingExtension.AuthFailure(() => {
      try {
        subscription?.cancel?.();
      } catch {}
      try {
        (client as any)?.disconnect?.();
      } catch {}
    });
    replayExtension = new StreamingExtension.Replay(channel, replayId);
    client = (connection.streaming as JsforceConnection['streaming']).createClient([authFailure, replayExtension]);
    return client;
  };

  return {
    async handshake(): Promise<void> {
      ensureClient();
    },
    replay(nextReplayId: number): void {
      replayId = nextReplayId;
      replayExtension?.setReplay(String(nextReplayId));
    },
    subscribe(): Promise<void> {
      const activeClient = ensureClient();
      return new Promise((resolve, reject) => {
        try {
          subscription = activeClient.subscribe(channel, (message: Record<string, unknown>) => {
            const result = streamProcessor(message);
            if (result?.completed) {
              resolve();
            }
          });
          (subscription as any)?.callback?.(() => {});
          (subscription as any)?.errback?.((error: unknown) => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        } catch (error) {
          reject(error);
        }
      });
    },
    disconnect(): void {
      try {
        subscription?.cancel?.();
      } catch {}
      subscription = undefined;
      try {
        (client as any)?.disconnect?.();
      } catch {}
      client = undefined;
    }
  };
}
