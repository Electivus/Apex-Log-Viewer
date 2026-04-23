import assert from 'assert/strict';
import proxyquire from 'proxyquire';
import type {
  DaemonProcess,
  JsonRpcErrorResponse,
  JsonRpcSuccessResponse
} from '../../../../../packages/app-server-client-ts/src/index';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

function createFakeDaemon(handlers: {
  onWrite: (
    message: { id: string; method: string; params?: unknown },
    helpers: {
      emitMessage: (message: JsonRpcSuccessResponse<unknown> | JsonRpcErrorResponse) => void;
    }
  ) => void;
}): DaemonProcess {
  const messageListeners = new Set<(message: unknown) => void>();
  return {
    child: {} as DaemonProcess['child'],
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onError() {
      return () => undefined;
    },
    onExit() {
      return () => undefined;
    },
    writeMessage(message) {
      handlers.onWrite(message as { id: string; method: string; params?: unknown }, {
        emitMessage: payload => {
          for (const listener of messageListeners) {
            listener(payload);
          }
        }
      });
    },
    dispose() {}
  };
}

suite('runtime client trace logging', () => {
  test('logs full runtime responses while redacting auth secrets', async () => {
    const traceEntries: unknown[][] = [];
    const { RuntimeClient } = proxyquireStrict('../../runtime/runtimeClient', {
      '../../../../src/utils/logger': {
        isTraceEnabled: () => false,
        logTrace: (...parts: unknown[]) => traceEntries.push(parts),
        logWarn: () => undefined,
        '@noCallThru': true
      },
      '../../../../src/salesforce/path': {
        getLoginShellEnv: async () => undefined,
        '@noCallThru': true
      },
      '../../../../src/utils/config': {
        getConfig: () => '',
        '@noCallThru': true
      },
      '../shared/telemetry': {
        safeSendEvent: () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../../runtime/runtimeClient');

    const daemon = createFakeDaemon({
      onWrite(message, helpers) {
        if (message.method === 'initialize') {
          helpers.emitMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              runtime_version: '0.1.0',
              cli_version: '0.1.0',
              protocol_version: '1',
              channel: 'stable',
              platform: 'win32',
              arch: 'x64',
              capabilities: {
                orgs: true,
                logs: true,
                search: true,
                tail: true,
                debug_flags: true,
                doctor: true
              },
              state_dir: '.alv/state',
              cache_dir: '.alv/cache'
            }
          });
          return;
        }
        if (message.method === 'org/auth') {
          helpers.emitMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              username: 'demo@example.com',
              instanceUrl: 'https://example.my.salesforce.com',
              accessToken: 'secret-token'
            }
          });
          return;
        }
        throw new Error(`unexpected method: ${message.method}`);
      }
    });

    const client = new RuntimeClient({
      createProcess: () => daemon,
      prepareProcessEnv: async () => undefined
    });

    await client.getOrgAuth({ username: 'demo@example.com' });

    const serializedTrace = JSON.stringify(traceEntries);
    assert.match(serializedTrace, /received success response/);
    assert.match(serializedTrace, /org\/auth/);
    assert.match(serializedTrace, /"accessToken":"\[redacted\]"/);
    assert.doesNotMatch(serializedTrace, /secret-token/);
    assert.match(serializedTrace, /example\.my\.salesforce\.com/);
  });

  test('logs runtime error response codes and data, and preserves data on the thrown error', async () => {
    const traceEntries: unknown[][] = [];
    const { RuntimeClient } = proxyquireStrict('../../runtime/runtimeClient', {
      '../../../../src/utils/logger': {
        isTraceEnabled: () => false,
        logTrace: (...parts: unknown[]) => traceEntries.push(parts),
        logWarn: () => undefined,
        '@noCallThru': true
      },
      '../../../../src/salesforce/path': {
        getLoginShellEnv: async () => undefined,
        '@noCallThru': true
      },
      '../../../../src/utils/config': {
        getConfig: () => '',
        '@noCallThru': true
      },
      '../shared/telemetry': {
        safeSendEvent: () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../../runtime/runtimeClient');

    const daemon = createFakeDaemon({
      onWrite(message, helpers) {
        if (message.method === 'initialize') {
          helpers.emitMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              runtime_version: '0.1.0',
              cli_version: '0.1.0',
              protocol_version: '1',
              channel: 'stable',
              platform: 'win32',
              arch: 'x64',
              capabilities: {
                orgs: true,
                logs: true,
                search: true,
                tail: true,
                debug_flags: true,
                doctor: true
              },
              state_dir: '.alv/state',
              cache_dir: '.alv/cache'
            }
          });
          return;
        }
        if (message.method === 'logs/list') {
          helpers.emitMessage({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32000,
              message: 'HTTP 403 Forbidden from https://example.my.salesforce.com/services/data/v64.0/tooling/query',
              data: {
                status: 403,
                responseBody: '[{"message":"Session expired","errorCode":"INVALID_SESSION_ID"}]'
              }
            }
          });
          return;
        }
        throw new Error(`unexpected method: ${message.method}`);
      }
    });

    const client = new RuntimeClient({
      createProcess: () => daemon,
      prepareProcessEnv: async () => undefined
    });

    await assert.rejects(client.logsList({ username: 'demo@example.com', limit: 1 }), error => {
      assert.equal(error instanceof Error, true);
      assert.match((error as Error).message, /HTTP 403 Forbidden/);
      assert.match((error as Error).message, /INVALID_SESSION_ID/);
      assert.equal((error as { code?: number }).code, -32000);
      assert.equal((error as { data?: { status?: number } }).data?.status, 403);
      return true;
    });

    const serializedTrace = JSON.stringify(traceEntries);
    assert.match(serializedTrace, /received error response/);
    assert.match(serializedTrace, /"code":-32000/);
    assert.match(serializedTrace, /INVALID_SESSION_ID/);
  });

  test('passes ALV_TRACE to the runtime process when extension trace logging is enabled', async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const { RuntimeClient } = proxyquireStrict('../../runtime/runtimeClient', {
      '../../../../src/utils/logger': {
        isTraceEnabled: () => true,
        logTrace: () => undefined,
        logWarn: () => undefined,
        '@noCallThru': true
      },
      '../../../../src/salesforce/path': {
        getLoginShellEnv: async () => ({ PATH: 'C:\\sf\\bin' }),
        '@noCallThru': true
      },
      '../../../../src/utils/config': {
        getConfig: () => '',
        '@noCallThru': true
      },
      '../shared/telemetry': {
        safeSendEvent: () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../../runtime/runtimeClient');

    const client = new RuntimeClient({
      createProcess: (_executable, env) => {
        seenEnv = env;
        return createFakeDaemon({
          onWrite() {
            throw new Error('unexpected runtime write');
          }
        });
      }
    });

    await client.startRuntime();

    assert.equal(seenEnv?.ALV_TRACE, '1');
    assert.equal(seenEnv?.PATH, 'C:\\sf\\bin');
  });
});
