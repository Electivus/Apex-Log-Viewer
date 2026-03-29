import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import type {
  DaemonProcess,
  JsonRpcErrorResponse,
  JsonRpcSuccessResponse,
  OrgAuth,
  OrgListItem,
} from '../../../../../packages/app-server-client-ts/src/index';
import { resolveBundledBinary, resolveBundledBinaryCandidates } from '../../runtime/bundledBinary';
import { RuntimeClient } from '../../runtime/runtimeClient';

suite('runtime client', () => {
  function createFakeDaemon(handlers: {
    onWrite: (
      message: { id: string; method: string; params?: unknown },
      helpers: {
        emitMessage: (message: JsonRpcSuccessResponse<unknown> | JsonRpcErrorResponse) => void;
        emitError: (error: Error) => void;
        emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
      }
    ) => void;
  }): DaemonProcess {
    const messageListeners = new Set<(message: unknown) => void>();
    const errorListeners = new Set<(error: Error) => void>();
    const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
    return {
      child: {} as DaemonProcess['child'],
      onMessage(listener) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      onError(listener) {
        errorListeners.add(listener);
        return () => errorListeners.delete(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      writeMessage(message) {
        handlers.onWrite(message as { id: string; method: string; params?: unknown }, {
          emitMessage: payload => {
            for (const listener of messageListeners) {
              listener(payload);
            }
          },
          emitError: error => {
            for (const listener of errorListeners) {
              listener(error);
            }
          },
          emitExit: (code, signal) => {
            for (const listener of exitListeners) {
              listener(code, signal);
            }
          }
        });
      },
      dispose() {}
    };
  }

  test('resolves a platform specific bundled binary path', () => {
    const resolved = resolveBundledBinary('linux', 'x64');
    assert.equal(resolved.endsWith(path.join('bin', 'linux-x64', 'apex-log-viewer')), true);
  });

  test('supports both source-tree and dist-tree runtime layouts', () => {
    const sourceCandidates = resolveBundledBinaryCandidates('/workspace/apps/vscode-extension/src/runtime', 'linux', 'x64');
    const distCandidates = resolveBundledBinaryCandidates('/workspace/apps/vscode-extension/dist', 'linux', 'x64');

    assert.deepEqual(sourceCandidates, [
      path.resolve('/workspace/apps/vscode-extension/src/runtime', '..', 'bin', 'linux-x64', 'apex-log-viewer'),
      path.resolve('/workspace/apps/vscode-extension/src/runtime', '..', '..', 'bin', 'linux-x64', 'apex-log-viewer')
    ]);
    assert.deepEqual(distCandidates, [
      path.resolve('/workspace/apps/vscode-extension/dist', '..', 'bin', 'linux-x64', 'apex-log-viewer'),
      path.resolve('/workspace/apps/vscode-extension/dist', '..', '..', 'bin', 'linux-x64', 'apex-log-viewer')
    ]);
  });

  test('tracks initialize capabilities from the daemon handshake', async () => {
    const client = new RuntimeClient({
      clientVersion: '0.1.0',
      requestHandler: async <TResult>(method: string): Promise<TResult> => {
        assert.equal(method, 'initialize');
        return {
          runtime_version: '0.1.0',
          protocol_version: '1',
          channel: 'stable',
          platform: 'linux',
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
        } as TResult;
      }
    });
    const result = await client.initialize();

    assert.equal(result.protocol_version, '1');
    assert.equal(result.channel, 'stable');
    assert.equal(result.capabilities.orgs, true);
  });

  test('orgList and getOrgAuth use runtime request methods', async () => {
    const methods: string[] = [];
    const client = new RuntimeClient({
      requestHandler: async (method, params) => {
        methods.push(method);
        if (method === 'org/list') {
          return [
            {
              username: 'demo@example.com',
              alias: 'Demo',
              isDefaultUsername: true
            }
          ] as never;
        }
        if (method === 'org/auth') {
          return {
            username: (params as { username?: string }).username,
            instanceUrl: 'https://example.my.salesforce.com',
            accessToken: 'token'
          } as never;
        }
        throw new Error(`unexpected method: ${method}`);
      }
    });

    const orgs = await client.orgList({ forceRefresh: true });
    const auth = await client.getOrgAuth({ username: 'demo@example.com' });

    assert.deepEqual(methods, ['org/list', 'org/auth']);
    assert.equal(orgs[0]?.username, 'demo@example.com');
    assert.equal(auth.username, 'demo@example.com');
  });

  test('coalesces concurrent orgList requests with identical params', async () => {
    let orgListCalls = 0;
    let resolveOrgList: ((value: OrgListItem[]) => void) | undefined;
    const client = new RuntimeClient({
      requestHandler: async <TResult>(method: string, params: unknown) => {
        assert.equal(method, 'org/list');
        assert.deepEqual(params, { forceRefresh: false });
        orgListCalls++;
        return (await new Promise<OrgListItem[]>(resolve => {
          resolveOrgList = resolve;
        })) as TResult;
      }
    });

    const first = client.orgList({ forceRefresh: false });
    const second = client.orgList({ forceRefresh: false });

    assert.equal(orgListCalls, 1);
    resolveOrgList?.([
      {
        username: 'demo@example.com',
        alias: 'Demo',
        isDefaultUsername: true
      }
    ]);

    const [left, right] = await Promise.all([first, second]);
    assert.equal(orgListCalls, 1);
    assert.deepEqual(left, right);
  });

  test('forwards abort signals to orgList request handling', async () => {
    let seenSignal: AbortSignal | undefined;
    const client = new RuntimeClient({
      requestHandler: async <TResult>(method: string, params: unknown, signal?: AbortSignal) => {
        assert.equal(method, 'org/list');
        assert.deepEqual(params, { forceRefresh: true });
        seenSignal = signal;
        return (await new Promise<OrgListItem[]>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('missing signal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('Request aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })) as TResult;
      }
    });

    const controller = new AbortController();
    const pending = client.orgList({ forceRefresh: true }, controller.signal);
    controller.abort();

    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );
    assert.ok(seenSignal, 'orgList should provide an abortable signal to the runtime request');
  });

  test('does not dispatch orgList after cancellation during initialize', async () => {
    let orgListCalls = 0;
    let releaseInitialize: (() => void) | undefined;
    const daemon = createFakeDaemon({
      onWrite(message, helpers) {
        if (message.method === 'initialize') {
          releaseInitialize = () => {
            helpers.emitMessage({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                runtime_version: '0.1.0',
                protocol_version: '1',
                platform: 'linux',
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
          };
          return;
        }
        if (message.method === 'org/list') {
          orgListCalls++;
          helpers.emitMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: []
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

    const controller = new AbortController();
    const pending = client.orgList({ forceRefresh: true }, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    releaseInitialize?.();

    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );
    assert.equal(orgListCalls, 0);
  });

  test('starts a fresh orgList request after a cancelled shared request aborts', async () => {
    let orgListCalls = 0;
    let rejectAbortedRequest: (() => void) | undefined;
    let resolveRetriedRequest: ((value: OrgListItem[]) => void) | undefined;
    const client = new RuntimeClient({
      requestHandler: async <TResult>(method: string, params: unknown, signal?: AbortSignal) => {
        assert.equal(method, 'org/list');
        assert.deepEqual(params, { forceRefresh: false });
        orgListCalls++;
        return (await new Promise<OrgListItem[]>((resolve, reject) => {
          if (orgListCalls === 1) {
            signal?.addEventListener(
              'abort',
              () => {
                rejectAbortedRequest = () => {
                  const error = new Error('Request aborted');
                  error.name = 'AbortError';
                  reject(error);
                };
              },
              { once: true }
            );
            return;
          }

          resolveRetriedRequest = resolve;
        })) as TResult;
      }
    });

    const controller = new AbortController();
    const first = client.orgList({ forceRefresh: false }, controller.signal);
    controller.abort();

    const second = client.orgList({ forceRefresh: false });

    assert.equal(orgListCalls, 2);
    rejectAbortedRequest?.();
    resolveRetriedRequest?.([
      {
        username: 'demo@example.com',
        alias: 'Demo',
        isDefaultUsername: true
      }
    ]);

    await assert.rejects(
      first,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );
    await assert.doesNotReject(second);
  });

  test('coalesces concurrent getOrgAuth requests for the same username', async () => {
    let authCalls = 0;
    let resolveAuth: ((value: OrgAuth) => void) | undefined;
    const client = new RuntimeClient({
      requestHandler: async <TResult>(method: string, params: unknown) => {
        assert.equal(method, 'org/auth');
        assert.deepEqual(params, { username: 'demo@example.com' });
        authCalls++;
        return (await new Promise<OrgAuth>(resolve => {
          resolveAuth = resolve;
        })) as TResult;
      }
    });

    const first = client.getOrgAuth({ username: 'demo@example.com' });
    const second = client.getOrgAuth({ username: 'demo@example.com' });

    assert.equal(authCalls, 1);
    resolveAuth?.({
      username: 'demo@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: 'token'
    });

    const [left, right] = await Promise.all([first, second]);
    assert.equal(authCalls, 1);
    assert.deepEqual(left, right);
  });

  test('coalesces concurrent signaled getOrgAuth requests for the same username', async () => {
    let authCalls = 0;
    let resolveAuth: ((value: OrgAuth) => void) | undefined;
    const client = new RuntimeClient({
      requestHandler: async <TResult>(method: string, params: unknown, signal?: AbortSignal) => {
        assert.equal(method, 'org/auth');
        assert.deepEqual(params, { username: 'demo@example.com' });
        authCalls++;
        return (await new Promise<OrgAuth>((resolve, reject) => {
          resolveAuth = resolve;
          signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('Request aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })) as TResult;
      }
    });

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = client.getOrgAuth({ username: 'demo@example.com' }, firstController.signal);
    const second = client.getOrgAuth({ username: 'demo@example.com' }, secondController.signal);

    assert.equal(authCalls, 1);
    firstController.abort();
    resolveAuth?.({
      username: 'demo@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: 'token'
    });

    await assert.rejects(
      first,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );
    await assert.doesNotReject(second);
    assert.equal(authCalls, 1);
  });

  test('forwards abort signals to getOrgAuth request handling', async () => {
    let seenSignal: AbortSignal | undefined;
    const client = new RuntimeClient({
      requestHandler: async <TResult>(method: string, params: unknown, signal?: AbortSignal) => {
        assert.equal(method, 'org/auth');
        assert.deepEqual(params, { username: 'demo@example.com' });
        seenSignal = signal;
        return (await new Promise<OrgAuth>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('missing signal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('Request aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })) as TResult;
      }
    });

    const controller = new AbortController();
    const pending = client.getOrgAuth({ username: 'demo@example.com' }, controller.signal);
    controller.abort();

    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );
    assert.ok(seenSignal, 'getOrgAuth should provide an abortable signal to the runtime request');
  });

  test('does not dispatch getOrgAuth after cancellation during initialize', async () => {
    let authCalls = 0;
    let releaseInitialize: (() => void) | undefined;
    const daemon = createFakeDaemon({
      onWrite(message, helpers) {
        if (message.method === 'initialize') {
          releaseInitialize = () => {
            helpers.emitMessage({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                runtime_version: '0.1.0',
                protocol_version: '1',
                platform: 'linux',
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
          };
          return;
        }
        if (message.method === 'org/auth') {
          authCalls++;
          helpers.emitMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              username: 'demo@example.com',
              instanceUrl: 'https://example.my.salesforce.com',
              accessToken: 'token'
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

    const controller = new AbortController();
    const pending = client.getOrgAuth({ username: 'demo@example.com' }, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    releaseInitialize?.();

    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );
    assert.equal(authCalls, 0);
  });

  test('starts a fresh getOrgAuth request after a cancelled shared request aborts', async () => {
    let authCalls = 0;
    let rejectAbortedRequest: (() => void) | undefined;
    let resolveRetriedRequest: ((value: OrgAuth) => void) | undefined;
    const client = new RuntimeClient({
      requestHandler: async <TResult>(method: string, params: unknown, signal?: AbortSignal) => {
        assert.equal(method, 'org/auth');
        assert.deepEqual(params, { username: 'demo@example.com' });
        authCalls++;
        return (await new Promise<OrgAuth>((resolve, reject) => {
          if (authCalls === 1) {
            signal?.addEventListener(
              'abort',
              () => {
                rejectAbortedRequest = () => {
                  const error = new Error('Request aborted');
                  error.name = 'AbortError';
                  reject(error);
                };
              },
              { once: true }
            );
            return;
          }

          resolveRetriedRequest = resolve;
        })) as TResult;
      }
    });

    const controller = new AbortController();
    const first = client.getOrgAuth({ username: 'demo@example.com' }, controller.signal);
    controller.abort();

    const second = client.getOrgAuth({ username: 'demo@example.com' });

    assert.equal(authCalls, 2);
    rejectAbortedRequest?.();
    resolveRetriedRequest?.({
      username: 'demo@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: 'token'
    });

    await assert.rejects(
      first,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );
    await assert.doesNotReject(second);
  });

  test('prepares daemon env before starting the runtime process', async () => {
    let prepareCalls = 0;
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const daemon = createFakeDaemon({
      onWrite(message, helpers) {
        if (message.method === 'initialize') {
          helpers.emitMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              runtime_version: '0.1.0',
              protocol_version: '1',
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
        if (message.method === 'org/list') {
          helpers.emitMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: []
          });
          return;
        }
        throw new Error(`unexpected method: ${message.method}`);
      }
    });

    const client = new RuntimeClient({
      prepareProcessEnv: async () => {
        prepareCalls++;
        return { PATH: 'C:\\custom\\sf\\bin', Path: 'C:\\custom\\sf\\bin' };
      },
      createProcess: (_executable: string, env: NodeJS.ProcessEnv | undefined) => {
        seenEnv = env;
        return daemon;
      }
    } as any);

    await client.orgList();

    assert.equal(prepareCalls, 1);
    assert.equal(seenEnv?.PATH, 'C:\\custom\\sf\\bin');
    assert.equal(seenEnv?.Path, 'C:\\custom\\sf\\bin');
  });

  test('logsList, searchQuery, and logsTriage use runtime request methods', async () => {
    const methods: string[] = [];
    const client = new RuntimeClient({
      requestHandler: async (method, params) => {
        methods.push(method);
        if (method === 'logs/list') {
          assert.deepEqual(params, {
            username: 'demo@example.com',
            limit: 25,
            cursor: {
              beforeStartTime: '2026-03-27T12:00:00.000Z',
              beforeId: '07L000000000001AA'
            }
          });
          return [
            {
              Id: '07L000000000001AA',
              StartTime: '2026-03-27T12:00:00.000Z',
              Operation: 'Execute Anonymous',
              Application: 'Apex',
              DurationMilliseconds: 12,
              Status: 'Success',
              Request: 'API',
              LogLength: 123
            }
          ] as never;
        }
        if (method === 'search/query') {
          assert.deepEqual(params, {
            username: 'demo@example.com',
            query: 'NullPointerException',
            logIds: ['07L000000000001AA']
          });
          return {
            logIds: ['07L000000000001AA'],
            snippets: {
              '07L000000000001AA': {
                text: 'System.NullPointerException: Attempt to de-reference a null object',
                ranges: [[7, 27]]
              }
            },
            pendingLogIds: []
          } as never;
        }
        if (method === 'logs/triage') {
          assert.deepEqual(params, {
            username: 'demo@example.com',
            logIds: ['07L000000000001AA']
          });
          return [
            {
              logId: '07L000000000001AA',
              summary: {
                hasErrors: true,
                primaryReason: 'Fatal exception',
                reasons: [
                  {
                    code: 'fatal_exception',
                    severity: 'error',
                    summary: 'Fatal exception',
                    line: 3,
                    eventType: 'EXCEPTION_THROWN'
                  }
                ]
              }
            }
          ] as never;
        }
        throw new Error(`unexpected method: ${method}`);
      }
    });

    const logs = await client.logsList({
      username: 'demo@example.com',
      limit: 25,
      cursor: {
        beforeStartTime: '2026-03-27T12:00:00.000Z',
        beforeId: '07L000000000001AA'
      }
    });
    const searchResult = await client.searchQuery({
      username: 'demo@example.com',
      query: 'NullPointerException',
      logIds: ['07L000000000001AA']
    });
    const triageEntries = await client.logsTriage({
      username: 'demo@example.com',
      logIds: ['07L000000000001AA']
    });

    assert.deepEqual(methods, ['logs/list', 'search/query', 'logs/triage']);
    assert.equal(logs[0]?.Id, '07L000000000001AA');
    assert.equal(searchResult.logIds[0], '07L000000000001AA');
    assert.equal(searchResult.snippets?.['07L000000000001AA']?.ranges[0]?.[0], 7);
    assert.equal(triageEntries[0]?.summary.primaryReason, 'Fatal exception');
  });

  test('restarts and retries a request when the runtime exits mid-search', async () => {
    const methods: string[] = [];
    let createCount = 0;
    const client = new RuntimeClient({
      clientVersion: '0.1.0',
      createProcess() {
        createCount += 1;
        if (createCount === 1) {
          return createFakeDaemon({
            onWrite(message, helpers) {
              methods.push(`daemon1:${message.method}`);
              if (message.method === 'initialize') {
                helpers.emitMessage({
                  jsonrpc: '2.0',
                  id: message.id,
                  result: {
                    runtime_version: '0.1.0',
                    protocol_version: '1',
                    platform: 'linux',
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
              helpers.emitExit(0, null);
            }
          });
        }

        return createFakeDaemon({
          onWrite(message, helpers) {
            methods.push(`daemon2:${message.method}`);
            if (message.method === 'initialize') {
              helpers.emitMessage({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  runtime_version: '0.1.0',
                  protocol_version: '1',
                  platform: 'linux',
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
            helpers.emitMessage({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                logIds: ['07L000000000001AA'],
                snippets: {
                  '07L000000000001AA': {
                    text: 'matched',
                    ranges: [[0, 7]]
                  }
                },
                pendingLogIds: []
              }
            });
          }
        });
      }
    });

    const result = await client.searchQuery({
      query: 'marker',
      logIds: ['07L000000000001AA']
    });

    assert.equal(createCount, 2);
    assert.deepEqual(methods, ['daemon1:initialize', 'daemon1:search/query', 'daemon2:initialize', 'daemon2:search/query']);
    assert.deepEqual(result.logIds, ['07L000000000001AA']);
    assert.equal(result.snippets?.['07L000000000001AA']?.text, 'matched');
  });

  test('retries a request when the daemon emits a process error before responding', async () => {
    const methods: string[] = [];
    let createCount = 0;
    const client = new RuntimeClient({
      clientVersion: '0.1.0',
      createProcess() {
        createCount += 1;
        if (createCount === 1) {
          return createFakeDaemon({
            onWrite(message, helpers) {
              methods.push(`daemon1:${message.method}`);
              if (message.method === 'initialize') {
                helpers.emitMessage({
                  jsonrpc: '2.0',
                  id: message.id,
                  result: {
                    runtime_version: '0.1.0',
                    protocol_version: '1',
                    platform: 'linux',
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
              helpers.emitError(new Error('spawn ENOENT'));
            }
          });
        }

        return createFakeDaemon({
          onWrite(message, helpers) {
            methods.push(`daemon2:${message.method}`);
            if (message.method === 'initialize') {
              helpers.emitMessage({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  runtime_version: '0.1.0',
                  protocol_version: '1',
                  platform: 'linux',
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
            helpers.emitMessage({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                logIds: ['07L000000000001AA'],
                snippets: {
                  '07L000000000001AA': {
                    text: 'matched',
                    ranges: [[0, 7]]
                  }
                },
                pendingLogIds: []
              }
            });
          }
        });
      }
    });

    const result = await client.searchQuery({
      query: 'marker',
      logIds: ['07L000000000001AA']
    });

    assert.equal(createCount, 2);
    assert.deepEqual(methods, ['daemon1:initialize', 'daemon1:search/query', 'daemon2:initialize', 'daemon2:search/query']);
    assert.equal(result.snippets?.['07L000000000001AA']?.text, 'matched');
  });

  test('retries a request when daemon write throws after initialize', async () => {
    const methods: string[] = [];
    let createCount = 0;
    const client = new RuntimeClient({
      clientVersion: '0.1.0',
      createProcess() {
        createCount += 1;
        if (createCount === 1) {
          return createFakeDaemon({
            onWrite(message, helpers) {
              methods.push(`daemon1:${message.method}`);
              if (message.method === 'initialize') {
                helpers.emitMessage({
                  jsonrpc: '2.0',
                  id: message.id,
                  result: {
                    runtime_version: '0.1.0',
                    protocol_version: '1',
                    platform: 'linux',
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

              const error = new Error('write EPIPE') as NodeJS.ErrnoException;
              error.code = 'EPIPE';
              throw error;
            }
          });
        }

        return createFakeDaemon({
          onWrite(message, helpers) {
            methods.push(`daemon2:${message.method}`);
            if (message.method === 'initialize') {
              helpers.emitMessage({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  runtime_version: '0.1.0',
                  protocol_version: '1',
                  platform: 'linux',
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

            helpers.emitMessage({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                logIds: ['07L000000000001AA'],
                snippets: {
                  '07L000000000001AA': {
                    text: 'matched',
                    ranges: [[0, 7]]
                  }
                },
                pendingLogIds: []
              }
            });
          }
        });
      }
    });

    await client.initialize();
    const result = await client.searchQuery({
      query: 'marker',
      logIds: ['07L000000000001AA']
    });

    assert.equal(createCount, 2);
    assert.deepEqual(methods, ['daemon1:initialize', 'daemon1:search/query', 'daemon2:initialize', 'daemon2:search/query']);
    assert.equal(result.snippets?.['07L000000000001AA']?.text, 'matched');
  });

  test('does not throw when cancel write fails after the daemon exits', async () => {
    const methods: string[] = [];
    const client = new RuntimeClient({
      clientVersion: '0.1.0',
      createProcess() {
        return createFakeDaemon({
          onWrite(message, helpers) {
            methods.push(message.method);
            if (message.method === 'initialize') {
              helpers.emitMessage({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  runtime_version: '0.1.0',
                  protocol_version: '1',
                  platform: 'linux',
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

            const error = new Error('write EPIPE') as NodeJS.ErrnoException;
            error.code = 'EPIPE';
            throw error;
          }
        });
      }
    });

    await client.initialize();

    assert.doesNotThrow(() => {
      client.cancel('search/query:1');
    });
    assert.deepEqual(methods, ['initialize', 'cancel']);
  });

  test('serializes concurrent restart attempts after the daemon exits with multiple requests in flight', async () => {
    const methods: string[] = [];
    let createCount = 0;
    let shouldExit = true;
    const client = new RuntimeClient({
      clientVersion: '0.1.0',
      createProcess() {
        createCount += 1;
        if (createCount === 1) {
          return createFakeDaemon({
            onWrite(message, helpers) {
              methods.push(`daemon1:${message.method}`);
              if (message.method === 'initialize') {
                helpers.emitMessage({
                  jsonrpc: '2.0',
                  id: message.id,
                  result: {
                    runtime_version: '0.1.0',
                    protocol_version: '1',
                    platform: 'linux',
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
              if (shouldExit) {
                shouldExit = false;
                setImmediate(() => helpers.emitExit(0, null));
              }
            }
          });
        }

        return createFakeDaemon({
          onWrite(message, helpers) {
            methods.push(`daemon2:${message.method}`);
            if (message.method === 'initialize') {
              helpers.emitMessage({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  runtime_version: '0.1.0',
                  protocol_version: '1',
                  platform: 'linux',
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
            if (message.method === 'search/query') {
              helpers.emitMessage({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  logIds: ['07L000000000001AA'],
                  snippets: {
                    '07L000000000001AA': {
                      text: 'matched',
                      ranges: [[0, 7]]
                    }
                  },
                  pendingLogIds: []
                }
              });
              return;
            }
            helpers.emitMessage({
              jsonrpc: '2.0',
              id: message.id,
              result: [
                {
                  logId: '07L000000000001AA',
                  summary: {
                    hasErrors: false,
                    reasons: []
                  }
                }
              ]
            });
          }
        });
      }
    });

    await client.initialize();
    const [searchResult, triageEntries] = await Promise.all([
      client.searchQuery({
        query: 'marker',
        logIds: ['07L000000000001AA']
      }),
      client.logsTriage({
        logIds: ['07L000000000001AA']
      })
    ]);

    assert.equal(createCount, 2);
    assert.equal(
      methods.filter(method => method === 'daemon2:initialize').length,
      1
    );
    assert.deepEqual(searchResult.logIds, ['07L000000000001AA']);
    assert.equal(triageEntries[0]?.logId, '07L000000000001AA');
  });
});
