import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import proxyquire from 'proxyquire';
import { MAX_TAIL_BUFFER_LINES, TailService } from '../host/utils/tailService';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import * as cli from '../host/salesforce/cli';
import * as jsforce from '../host/salesforce/jsforce';
import * as streaming from '../host/salesforce/streaming';
import * as traceflags from '../host/salesforce/traceflags';
import {
  __resetApiVersionFallbackStateForTests,
  recordApiVersionFallback,
  setApiVersion
} from '../host/salesforce/apiVersion';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';
import { WEBVIEW_SESSION_MOUNT_DELAY_MS } from '../provider/webviewSession';
import { TestClock } from './testClock';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

function loadTailService(stubs?: {
  cli?: Record<string, unknown>;
  http?: Record<string, unknown>;
  traceflags?: Record<string, unknown>;
  streaming?: Record<string, unknown>;
  jsforce?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}) {
  return proxyquireStrict('../host/utils/tailService', {
    '../salesforce/cli': stubs?.cli ?? {},
    '../salesforce/http': stubs?.http ?? {},
    '../salesforce/traceflags': stubs?.traceflags ?? {},
    '../salesforce/streaming': stubs?.streaming ?? {},
    '../salesforce/jsforce': stubs?.jsforce ?? {},
    '../../runtime/runtimeClient': stubs?.runtime ?? {
      runtimeClient: {
        getOrgAuth:
          stubs?.cli?.getOrgAuth ??
          (async ({ username }: { username?: string } = {}) => ({
            username,
            instanceUrl: 'https://example.com',
            accessToken: 'token'
          })),
        logsList: async () => [],
        readApexLog: async ({ logId }: { logId: string }) => ({
          logId,
          resolvedUsername: 'user@example.com',
          source: 'remote',
          persistence: 'failed',
          persistenceError: new Error('not stored'),
          body: '',
          sizeBytes: 0,
          truncated: false
        }),
        requireLocalLogPath: async ({ logId }: { logId: string }) => ({
          logId,
          resolvedUsername: 'user@example.com',
          source: 'remote',
          provenance: 'downloaded',
          localPath: `/tmp/${logId}.log`
        })
      }
    }
  }) as typeof import('../host/utils/tailService');
}

function loadTailProvider(stubs?: { cli?: Record<string, unknown>; traceflags?: Record<string, unknown> }) {
  class TailServiceStub {
    setOrg(_username?: string): void {}
    setWindowActive(_active: boolean): void {}
    setBufferLimit(_limit: number): void {}
    isRunning(): boolean {
      return false;
    }
    getBufferedLines(): string[] {
      return [];
    }
    promptPoll(): void {}
    stop(): void {}
    clearLogPaths(): void {}
    clearBufferedLines(): void {}
    ensureLogSaved = async () => '/tmp/test.log';
    start = async () => undefined;
  }

  return proxyquireStrict('../provider/SfLogTailViewProvider', {
    '../runtime/runtimeClient': {
      runtimeClient: {
        orgList: stubs?.cli?.listOrgs ?? (async () => []),
        getOrgAuth:
          stubs?.cli?.getOrgAuth ??
          (async () => ({
            username: undefined,
            instanceUrl: 'https://example.com',
            accessToken: 'token'
          }))
      }
    },
    '../host/utils/replayDebugger': {
      ensureReplayDebuggerAvailable: async () => true
    },
    '../host/salesforce/traceflags': stubs?.traceflags ?? {},
    '../host/utils/tailService': { TailService: TailServiceStub }
  }) as typeof import('../provider/SfLogTailViewProvider');
}

class MockDisposable implements vscode.Disposable {
  dispose(): void {
    /* noop */
  }
}

class MockWebview implements vscode.Webview {
  private _html = '';
  readonly htmlAssignments: string[] = [];
  options: vscode.WebviewOptions = {};
  cspSource = 'vscode-resource://test';
  private handler: ((e: any) => any) | undefined;
  get html(): string {
    return this._html;
  }
  set html(value: string) {
    this._html = value;
    this.htmlAssignments.push(value);
  }
  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri;
  }
  postMessage(_message: any): Thenable<boolean> {
    return Promise.resolve(true);
  }
  onDidReceiveMessage(listener: (e: any) => any): vscode.Disposable {
    this.handler = listener;
    return new MockDisposable();
  }
  emit(message: any) {
    return this.handler?.(message);
  }
}

class MockWebviewView implements vscode.WebviewView {
  visible = true;
  title = 'Test';
  viewType = 'electivus.apexLogViewer.tailView';
  description?: string | undefined;
  badge?: { value: number; tooltip: string } | undefined;
  webview: vscode.Webview;
  private visibilityListeners: Array<() => void> = [];
  private disposeListener: (() => void) | undefined;
  constructor(webview: vscode.Webview) {
    this.webview = webview;
  }
  show(): void {
    /* noop */
  }
  onDidChangeVisibility: vscode.Event<void> = listener => {
    this.visibilityListeners.push(listener);
    return new MockDisposable();
  };
  onDidDispose: vscode.Event<void> = listener => {
    this.disposeListener = listener;
    return new MockDisposable();
  };
  fireVisible(visible: boolean): void {
    this.visible = visible;
    for (const listener of this.visibilityListeners) {
      listener();
    }
  }
  fireDispose(): void {
    this.disposeListener?.();
  }
}

class MockWebviewPanel implements vscode.WebviewPanel {
  readonly active = true;
  visible = true;
  readonly options: vscode.WebviewPanelOptions = {};
  public title = 'Electivus Apex Logs Tail';
  public viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active;
  public webview: vscode.Webview;
  private disposeListener: (() => void) | undefined;
  private viewStateListener: ((event: vscode.WebviewPanelOnDidChangeViewStateEvent) => void) | undefined;

  constructor(
    public viewType: string,
    webview: vscode.Webview
  ) {
    this.webview = webview;
  }

  reveal(_viewColumn?: vscode.ViewColumn, _preserveFocus?: boolean): void {
    /* noop */
  }

  dispose(): void {
    this.disposeListener?.();
  }

  onDidDispose(listener: () => void): vscode.Disposable {
    this.disposeListener = listener;
    return new MockDisposable();
  }

  onDidChangeViewState(listener: (e: vscode.WebviewPanelOnDidChangeViewStateEvent) => any): vscode.Disposable {
    this.viewStateListener = listener;
    return new MockDisposable();
  }

  fireVisible(visible = true): void {
    this.visible = visible;
    this.viewStateListener?.({ webviewPanel: this } as vscode.WebviewPanelOnDidChangeViewStateEvent);
  }
}

async function remountTailSidebar(
  provider: SfLogTailViewProvider,
  clock: TestClock,
  posted: any[]
): Promise<MockWebview> {
  const webview = new MockWebview();
  webview.postMessage = (message: any) => {
    posted.push(message);
    return Promise.resolve(true);
  };
  const view = new MockWebviewView(webview);
  await provider.resolveWebviewView(view);
  await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
  await webview.emit({ type: 'ready', mountSequence: provider.getWebviewDiagnosticState().mountSequence });
  await clock.flushMicrotasks();
  return webview;
}

function postTailUpdate(provider: SfLogTailViewProvider, message: unknown): void {
  (provider as any).post(message, 'replayable');
}

suite('TailService', () => {
  const originalDebugFlagsShow = DebugFlagsPanel.show;

  teardown(() => {
    (DebugFlagsPanel as any).show = originalDebugFlagsShow;
    streaming.__resetStreamingClientFactoryForTests();
    jsforce.__resetConnectionFactoryForTests();
    __resetApiVersionFallbackStateForTests();
    setApiVersion('64.0');
  });

  test('requires debug level', async () => {
    const posted: any[] = [];
    const service = new TailService(m => posted.push(m));
    const original = cli.getOrgAuth;
    (cli as any).getOrgAuth = async () => {
      throw new Error('getOrgAuth should not be called');
    };
    await service.start(undefined);
    assert.equal(posted[0]?.type, 'error');
    (cli as any).getOrgAuth = original;
  });

  test('start clears stale caches', async () => {
    const service = new TailService(() => {});
    (service as any).seenLogIds.add('old');
    (service as any).logIdToPath.set('old', '/tmp/old');
    const origGetAuth = cli.getOrgAuth;
    const origEnsure = traceflags.ensureUserTraceFlag;
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (traceflags as any).ensureUserTraceFlag = async () => false;
    jsforce.__setConnectionFactoryForTests(
      async () =>
        ({
          version: '64.0',
          instanceUrl: 'i',
          accessToken: 't',
          request: async () => '',
          query: async () => ({ records: [] }),
          queryMore: async () => ({ records: [] }),
          tooling: {
            query: async () => ({ records: [] }),
            create: async () => ({ success: true, id: '1', errors: [] }),
            update: async () => ({ success: true, id: '1', errors: [] }),
            destroy: async () => ({ success: true, id: '1', errors: [] })
          },
          streaming: {} as any
        }) as any
    );
    streaming.__setStreamingClientFactoryForTests(async () => ({
      handshake: async () => {},
      replay: () => {},
      subscribe: async () => {},
      disconnect: () => {}
    }));
    await service.start('DEBUG');
    assert.equal((service as any).seenLogIds.size, 0);
    assert.equal((service as any).logIdToPath.size, 0);
    (cli as any).getOrgAuth = origGetAuth;
    (traceflags as any).ensureUserTraceFlag = origEnsure;
    service.stop();
  });

  test('start resolves auth through runtime client instead of salesforce cli', async () => {
    const { TailService } = loadTailService({
      cli: {
        getOrgAuth: async () => {
          throw new Error('should not call cli getOrgAuth');
        }
      },
      runtime: {
        runtimeClient: {
          getOrgAuth: async ({ username }: { username?: string } = {}) => ({
            username,
            instanceUrl: 'https://example.com',
            accessToken: 'token'
          }),
          logsList: async () => []
        }
      },
      traceflags: {
        ensureUserTraceFlag: async () => false
      },
      http: {
        getEffectiveApiVersion: () => '64.0'
      },
      streaming: {
        createConnectionFromAuth: async (auth: any, apiVersion: string) => ({
          version: apiVersion,
          instanceUrl: auth.instanceUrl,
          accessToken: auth.accessToken,
          request: async () => '',
          query: async () => ({ records: [] }),
          queryMore: async () => ({ records: [] }),
          tooling: {
            query: async () => ({ records: [] }),
            create: async () => ({ success: true, id: '1', errors: [] }),
            update: async () => ({ success: true, id: '1', errors: [] }),
            destroy: async () => ({ success: true, id: '1', errors: [] })
          },
          streaming: {} as any
        }),
        createLoggingStreamingClient: async () => ({
          handshake: async () => {},
          replay: () => {},
          subscribe: async () => {},
          disconnect: () => {}
        })
      }
    });
    const service = new TailService(() => {});
    service.setOrg('runtime-user@example.com');

    await service.start('DEBUG');

    assert.equal((service as any).currentAuth?.username, 'runtime-user@example.com');
    service.stop();
  });

  test('start recreates the tail connection after API-version fallback', async () => {
    setApiVersion('66.0');
    const auth = { username: 'legacy-user', instanceUrl: 'https://legacy.example.com', accessToken: 't' };
    const requestedVersions: string[] = [];
    const { TailService } = loadTailService({
      cli: {
        getOrgAuth: async () => auth
      },
      traceflags: {
        ensureUserTraceFlag: async () => {
          recordApiVersionFallback(auth as any, '66.0', '64.0');
          return false;
        }
      },
      http: {
        getEffectiveApiVersion: () => '64.0'
      },
      streaming: {
        createConnectionFromAuth: async (_auth: any, apiVersion: string) => {
          requestedVersions.push(apiVersion);
          return {
            version: apiVersion,
            instanceUrl: auth.instanceUrl,
            accessToken: auth.accessToken,
            request: async () => '',
            query: async () => ({ records: [] }),
            queryMore: async () => ({ records: [] }),
            tooling: {
              query: async () => ({ records: [] }),
              create: async () => ({ success: true, id: '1', errors: [] }),
              update: async () => ({ success: true, id: '1', errors: [] }),
              destroy: async () => ({ success: true, id: '1', errors: [] })
            },
            streaming: {} as any
          };
        },
        createLoggingStreamingClient: async () => ({
          handshake: async () => {},
          replay: () => {},
          subscribe: async () => {},
          disconnect: () => {}
        })
      },
      jsforce: {
        requestTextWithConnection: async () => ''
      }
    });
    const service = new TailService(() => {});

    await service.start('DEBUG');

    assert.deepEqual(requestedVersions, ['64.0']);
    assert.equal((service as any).connection?.version, '64.0');
    service.stop();
  });

  test('stop clears caches', () => {
    const service = new TailService(() => {});
    (service as any).seenLogIds.add('a');
    (service as any).logIdToPath.set('a', 'b');
    service.stop();
    assert.equal((service as any).seenLogIds.size, 0);
    assert.equal((service as any).logIdToPath.size, 0);
  });

  test('stop cleans streaming client and connection state', () => {
    const service = new TailService(() => {});
    let streamDisconnect = false;
    (service as any).streamingClient = {
      disconnect() {
        streamDisconnect = true;
      }
    };
    (service as any).connection = { instanceUrl: 'i' };
    (service as any).currentAuth = { username: 'u' } as any;
    (service as any).lastReplayId = 1;
    service.stop();
    assert.equal(streamDisconnect, true);
    assert.equal((service as any).streamingClient, undefined);
    assert.equal((service as any).connection, undefined);
    assert.equal((service as any).currentAuth, undefined);
    assert.equal((service as any).lastReplayId, undefined);
  });

  test('setBufferLimit clamps to the shared maximum and trims buffered replay lines', () => {
    const service = new TailService(() => {});
    (service as any).bufferedLines = Array.from({ length: MAX_TAIL_BUFFER_LINES + 25 }, (_, index) => `line-${index}`);

    service.setBufferLimit(Number.MAX_SAFE_INTEGER);

    assert.equal(service.getBufferedLines().length, MAX_TAIL_BUFFER_LINES);
  });

  test('buffer trimming preserves the newest logical tail window without shifting the whole array each append', () => {
    const service = new TailService(() => {});
    service.setBufferLimit(1000);

    (service as any).appendBufferedLines(Array.from({ length: 1000 }, (_, index) => `line-${index}`));
    (service as any).appendBufferedLines(['line-1000']);

    assert.deepEqual(service.getBufferedLines().slice(0, 3), ['line-1', 'line-2', 'line-3']);
    assert.deepEqual(service.getBufferedLines().slice(-3), ['line-998', 'line-999', 'line-1000']);
    assert.equal((service as any).bufferedLinesOffset > 0, true, 'trim should advance the logical head');
  });

  test('selectOrg resets caches and stops tail', async () => {
    const clock = new TestClock();
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    const posted: any[] = [];
    webview.postMessage = (message: any) => {
      posted.push(message);
      return Promise.resolve(true);
    };
    (provider as any).sendOrgs = async () => {};
    (provider as any).sendDebugLevels = async () => {};
    await provider.resolveWebviewView(view);
    await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    await webview.emit({ type: 'ready', mountSequence: provider.getWebviewDiagnosticState().mountSequence });
    await clock.flushMicrotasks();
    posted.length = 0;
    const service = (provider as any).tailService;
    (service as any).seenLogIds.add('x');
    (service as any).logIdToPath.set('x', 'y');
    (service as any).bufferedLines = ['USER_DEBUG|stale'];
    (service as any).tailRunning = true;
    await webview.emit({ type: 'selectOrg', target: 'newOrg' });
    assert.equal((service as any).seenLogIds.size, 0);
    assert.equal((service as any).logIdToPath.size, 0);
    assert.deepEqual(service.getBufferedLines(), []);
    assert.equal(service.isRunning(), false);
    assert.equal(
      posted.some(message => message?.type === 'tailReset'),
      true,
      'switching orgs should clear the visible tail buffer'
    );
    clock.dispose();
  });

  test('sendDebugLevels selects the first available level when no active trace flag exists', async () => {
    const { SfLogTailViewProvider } = loadTailProvider({
      cli: {
        getOrgAuth: async () => ({ username: 'u', instanceUrl: 'https://example.com', accessToken: 't' })
      },
      traceflags: {
        listDebugLevels: async () => ['ALV_E2E'],
        getActiveUserDebugLevel: async () => undefined,
        ensureDefaultTailDebugLevel: async () => {
          throw new Error('should not create a fallback debug level when records already exist');
        }
      }
    });
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const posted: any[] = [];

    (provider as any).post = (message: any) => {
      posted.push(message);
    };
    await (provider as any).sendDebugLevels();

    assert.deepEqual(posted.at(-1), { type: 'debugLevels', data: ['ALV_E2E'], active: 'ALV_E2E' });
  });

  test('sendDebugLevels creates a fallback debug level when the org has none', async () => {
    const { SfLogTailViewProvider } = loadTailProvider({
      cli: {
        getOrgAuth: async () => ({ username: 'u', instanceUrl: 'https://example.com', accessToken: 't' })
      },
      traceflags: {
        listDebugLevels: async () => [],
        getActiveUserDebugLevel: async () => undefined,
        ensureDefaultTailDebugLevel: async () => 'ALV_DEVELOPER_FOCUS'
      }
    });
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const posted: any[] = [];

    (provider as any).post = (message: any) => {
      posted.push(message);
    };
    await (provider as any).sendDebugLevels();

    assert.deepEqual(posted.at(-1), {
      type: 'debugLevels',
      data: ['ALV_DEVELOPER_FOCUS'],
      active: 'ALV_DEVELOPER_FOCUS'
    });
  });

  test('sendDebugLevels does not create a fallback debug level when listing levels fails', async () => {
    let ensureCalls = 0;
    const { SfLogTailViewProvider } = loadTailProvider({
      cli: {
        getOrgAuth: async () => ({ username: 'u', instanceUrl: 'https://example.com', accessToken: 't' })
      },
      traceflags: {
        listDebugLevels: async () => {
          throw new Error('temporary read failure');
        },
        getActiveUserDebugLevel: async () => undefined,
        ensureDefaultTailDebugLevel: async () => {
          ensureCalls++;
          return 'ALV_DEVELOPER_FOCUS';
        }
      }
    });
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const posted: any[] = [];

    (provider as any).post = (message: any) => {
      posted.push(message);
    };
    await (provider as any).sendDebugLevels();

    assert.equal(ensureCalls, 0);
    assert.deepEqual(posted.at(-1), { type: 'debugLevels', data: [], active: undefined });
  });

  test('retries log ID after fetch failure', async () => {
    let calls = 0;
    const tailFetch = async () => {
      calls++;
      if (calls === 1) {
        throw new Error('fail');
      }
      return {
        logId: '1',
        resolvedUsername: 'u',
        source: 'remote',
        persistence: 'failed',
        persistenceError: new Error('not stored'),
        body: 'body',
        sizeBytes: 4,
        truncated: false
      };
    };
    const { TailService: RetryingTailService } = loadTailService({
      runtime: {
        runtimeClient: {
          getOrgAuth: async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' }),
          readApexLog: tailFetch
        }
      }
    });
    const retryService = new RetryingTailService(() => {});
    (retryService as any).tailRunning = true;
    (retryService as any).currentAuth = { username: 'u', instanceUrl: 'i', accessToken: 't' };
    (retryService as any).emitLogWithHeader = async () => {};
    await (retryService as any).handleIncomingLogId('1');
    assert.equal(calls, 1);
    assert.equal((retryService as any).seenLogIds.has('1'), false);
    await (retryService as any).handleIncomingLogId('1');
    assert.equal(calls, 2);
    assert.equal((retryService as any).seenLogIds.has('1'), true);
  });

  test('ensureLogSaved delegates cancellation to the shared lifecycle', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const { TailService: LifecycleTailService } = loadTailService({
      runtime: {
        runtimeClient: {
          getOrgAuth: async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' }),
          requireLocalLogPath: async (_params: unknown, signal?: AbortSignal) => {
            receivedSignal = signal;
            await new Promise<void>((_resolve, reject) =>
              signal?.addEventListener(
                'abort',
                () => {
                  const error = new Error('aborted');
                  error.name = 'AbortError';
                  reject(error);
                },
                { once: true }
              )
            );
            throw new Error('unreachable');
          }
        }
      }
    });
    const service = new LifecycleTailService(() => {});

    const pending = service.ensureLogSaved('07Lxx0000000001', controller.signal);
    controller.abort();

    await assert.rejects(pending, /aborted/i);
    assert.equal(receivedSignal, controller.signal);
  });

  test('replay treats AbortError from ensureLogSaved as cancellation', async () => {
    const originalExecuteCommand = vscode.commands.executeCommand;
    const originalWithProgress = vscode.window.withProgress;
    const executed: Array<{ command: string; args: any[] }> = [];
    (vscode.commands as any).executeCommand = async (command: string, ...args: any[]) => {
      executed.push({ command, args });
      return undefined;
    };
    (vscode.window as any).withProgress = async (_options: any, task: any) =>
      task(
        { report() {} },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => new MockDisposable()
        }
      );

    try {
      const { SfLogTailViewProvider } = loadTailProvider();
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const posted: any[] = [];
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);

      (provider as any).post = (message: any) => {
        posted.push(message);
      };
      (provider as any).sendOrgs = async () => {};
      (provider as any).sendDebugLevels = async () => {};
      await provider.resolveWebviewView(view);

      (provider as any).tailService.ensureLogSaved = async () => {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        throw error;
      };

      await webview.emit({ type: 'replay', logId: '07Lxx0000000001' });

      assert.equal(
        posted.some(message => message?.type === 'error'),
        false,
        'AbortError should be treated as cancellation'
      );
      assert.equal(
        executed.some(
          entry =>
            entry.command === 'sf.launch.replay.debugger.logfile' ||
            entry.command === 'sfdx.launch.replay.debugger.logfile'
        ),
        false,
        'replay debugger should not launch after cancellation'
      );
    } finally {
      (vscode.commands as any).executeCommand = originalExecuteCommand;
      (vscode.window as any).withProgress = originalWithProgress;
    }
  });

  test('openDebugFlags opens debug flags panel from tail view', async () => {
    const clock = new TestClock();
    const opened: Array<{ selectedOrg?: string; sourceView?: string }> = [];
    (DebugFlagsPanel as any).show = async (options: any) => {
      opened.push(options || {});
    };

    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    (provider as any).sendOrgs = async () => {};
    (provider as any).sendDebugLevels = async () => {};
    (provider as any).refreshViewState = async () => undefined;
    await provider.resolveWebviewView(view);
    await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    const mountSequence = provider.getWebviewDiagnosticState().mountSequence;
    await webview.emit({ type: 'ready', mountSequence });

    await webview.emit({ type: 'selectOrg', target: 'tail-user@example.com' });
    await webview.emit({ type: 'openDebugFlags' });

    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.selectedOrg, 'tail-user@example.com');
    assert.equal(opened[0]?.sourceView, 'tail');
    clock.dispose();
  });

  test('editor tail panel resolves html and stays idle after ready', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const posted: any[] = [];
      const webview = new MockWebview();
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };
      const panel = new MockWebviewPanel('electivus.apexLogViewer.tailView.editorPanel', webview);

      (provider as any).sendOrgs = async () => {
        posted.push({ type: 'sendOrgsCalled' });
      };
      (provider as any).sendDebugLevels = async () => {
        posted.push({ type: 'sendDebugLevelsCalled' });
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.ok(webview.html.includes('media/tail.js'));
      assert.ok(
        posted.some(message => message?.type === 'init'),
        'should post init message'
      );
      assert.ok(
        posted.some(message => message?.type === 'sendOrgsCalled'),
        'should refresh org state on ready'
      );
      assert.ok(
        posted.some(message => message?.type === 'sendDebugLevelsCalled'),
        'should refresh debug levels on ready'
      );
      assert.equal(
        (provider as any).tailService.isRunning(),
        false,
        'editor tail should stay idle until explicit start'
      );
    } finally {
      clock.dispose();
    }
  });

  test('tail replays an explicit error clear after hidden recovery', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      const posted: any[] = [];
      let dropVisibleReplay = false;
      webview.postMessage = (message: any) => {
        if (!view.visible) {
          return Promise.resolve(false);
        }
        if (dropVisibleReplay) {
          return Promise.resolve(false);
        }
        posted.push(message);
        return Promise.resolve(true);
      };

      (provider as any).refreshViewState = async () => undefined;

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready', mountSequence: provider.getWebviewDiagnosticState().mountSequence });
      await clock.flushMicrotasks();

      postTailUpdate(provider, { type: 'error', message: 'tail failed' });
      posted.length = 0;

      view.fireVisible(false);
      postTailUpdate(provider, { type: 'tailData', lines: ['USER_DEBUG|recovered while hidden'] });
      await clock.flushMicrotasks();

      assert.equal(posted.length, 0, 'hidden recovery messages are not delivered in this test harness');

      dropVisibleReplay = true;
      view.fireVisible(true);
      await clock.flushMicrotasks();

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        false,
        'dropped visible tail replay should not count as a delivered clear'
      );

      dropVisibleReplay = false;
      posted.length = 0;
      await clock.advanceBy(1000);

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        true,
        'visible retry should still include the stale retained Tail error clear'
      );
    } finally {
      clock.dispose();
    }
  });

  test('tail remount replays the latest error until successful data clears it', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      const posted: any[] = [];
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      postTailUpdate(provider, { type: 'error', message: 'tail failed' });
      posted.length = 0;

      await remountTailSidebar(provider, clock, posted);

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === 'tail failed'),
        true
      );

      postTailUpdate(provider, { type: 'tailData', lines: ['USER_DEBUG|hello'] });
      posted.length = 0;

      await remountTailSidebar(provider, clock, posted);

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message !== undefined),
        false,
        'the replacement may receive an explicit clear but must not replay the stale Tail error'
      );
    } finally {
      clock.dispose();
    }
  });

  test('tail remount preserves errors across replayed buffered lines until live recovery clears them', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      const posted: any[] = [];
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      (provider as any).tailService.bufferedLines = ['USER_DEBUG|buffered'];
      postTailUpdate(provider, { type: 'error', message: 'tail failed' });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        posted.length = 0;
        await remountTailSidebar(provider, clock, posted);

        assert.equal(
          posted.some(message => message?.type === 'error' && message?.message === 'tail failed'),
          true
        );
      }

      posted.length = 0;
      postTailUpdate(provider, { type: 'tailData', lines: ['USER_DEBUG|recovered'] });

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        true
      );
    } finally {
      clock.dispose();
    }
  });

  test('tail recovery clears the webview error banner when status or data succeeds', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const panel = new MockWebviewPanel('electivus.apexLogViewer.tailView.editorPanel', webview);
      const posted: any[] = [];
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      postTailUpdate(provider, { type: 'error', message: 'tail failed' });
      posted.length = 0;
      postTailUpdate(provider, { type: 'tailStatus', running: true });

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        true
      );

      postTailUpdate(provider, { type: 'error', message: 'tail failed again' });
      posted.length = 0;
      postTailUpdate(provider, { type: 'tailData', lines: ['USER_DEBUG|hello'] });

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        true
      );
    } finally {
      clock.dispose();
    }
  });

  test('tail retries bootstrap after a failed debug-level snapshot on remount', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const panel = new MockWebviewPanel('electivus.apexLogViewer.tailView.editorPanel', webview);
      const calls: string[] = [];

      postTailUpdate(provider, { type: 'orgs', data: [], selected: undefined });
      postTailUpdate(provider, { type: 'debugLevels', data: [] });
      (provider as any).debugLevelsBootstrapNeedsRefresh = true;
      (provider as any).refreshViewState = async () => {
        calls.push('refreshViewState');
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['refreshViewState']);
    } finally {
      clock.dispose();
    }
  });

  test('tail remount refreshes cached metadata in the background', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      const calls: Array<{ showLoading?: boolean }> = [];
      const posted: any[] = [];

      postTailUpdate(provider, { type: 'orgs', data: [], selected: undefined });
      postTailUpdate(provider, { type: 'debugLevels', data: [] });
      (provider as any).refreshViewState = async (options?: { showLoading?: boolean }) => {
        calls.push(options ?? {});
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, [], 'initial ready should rely on the cached snapshot');

      await remountTailSidebar(provider, clock, posted);

      assert.deepEqual(calls, [{ showLoading: false }], 'remount should silently refresh cached metadata');
    } finally {
      clock.dispose();
    }
  });

  test('tail replay preserves selected org, configuration, running state, reset ordering, buffer, and error', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const posted: any[] = [];
      const webview = new MockWebview();
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };

      postTailUpdate(provider, {
        type: 'orgs',
        data: [{ username: 'selected@example.com', alias: 'selected' }],
        selected: 'selected@example.com'
      });
      postTailUpdate(provider, { type: 'debugLevels', data: ['ALV_Tail'], active: 'ALV_Tail' });
      postTailUpdate(provider, { type: 'tailConfig', tailBufferSize: 321 });
      postTailUpdate(provider, { type: 'tailStatus', running: true });
      (provider as any).tailService.bufferedLines = ['USER_DEBUG|first', 'USER_DEBUG|second'];
      postTailUpdate(provider, { type: 'error', message: 'tail failed' });
      (provider as any).refreshViewState = async () => undefined;

      await provider.resolveWebviewView(new MockWebviewView(webview));
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({
        type: 'ready',
        mountSequence: provider.getWebviewDiagnosticState().mountSequence
      });
      await clock.flushMicrotasks();

      assert.ok(
        posted.some(
          message =>
            message?.type === 'orgs' &&
            message?.selected === 'selected@example.com' &&
            message?.data?.[0]?.username === 'selected@example.com'
        )
      );
      assert.ok(posted.some(message => message?.type === 'tailConfig' && message?.tailBufferSize === 321));
      assert.ok(posted.some(message => message?.type === 'tailStatus' && message?.running === true));
      const resetIndex = posted.findIndex(message => message?.type === 'tailReset');
      const dataIndex = posted.findIndex(message => message?.type === 'tailData');
      assert.ok(resetIndex >= 0 && dataIndex === resetIndex + 1, 'buffer replay should reset immediately before data');
      assert.deepEqual(posted[dataIndex]?.lines, ['USER_DEBUG|first', 'USER_DEBUG|second']);
      assert.ok(posted.some(message => message?.type === 'error' && message?.message === 'tail failed'));
    } finally {
      clock.dispose();
    }
  });

  test('tail bootstrap failure remains surface-owned and does not reset readiness', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      (provider as any).refreshViewState = async () => {
        throw new Error('tail bootstrap failed');
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({
        type: 'ready',
        mountSequence: provider.getWebviewDiagnosticState().mountSequence
      });
      await clock.flushMicrotasks();

      assert.equal(provider.isReady(), true);
    } finally {
      clock.dispose();
    }
  });

  test('tail host replacement preserves the active stream and replays its running status', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const firstWebview = new MockWebview();
      const firstView = new MockWebviewView(firstWebview);
      (provider as any).refreshViewState = async () => undefined;

      await provider.resolveWebviewView(firstView);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await firstWebview.emit({
        type: 'ready',
        mountSequence: provider.getWebviewDiagnosticState().mountSequence
      });
      await clock.flushMicrotasks();

      (provider as any).tailService.tailRunning = true;
      postTailUpdate(provider, { type: 'tailStatus', running: true });
      await clock.flushMicrotasks();

      const posted: any[] = [];
      const replacementWebview = new MockWebview();
      replacementWebview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };
      await provider.resolveWebviewView(new MockWebviewView(replacementWebview));
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await replacementWebview.emit({
        type: 'ready',
        mountSequence: provider.getWebviewDiagnosticState().mountSequence
      });
      await clock.flushMicrotasks();

      assert.equal((provider as any).tailService.isRunning(), true, 'replacement should not stop the active tail');
      assert.ok(
        posted.some(message => message?.type === 'tailStatus' && message?.running === true),
        'replacement should replay the latest running state'
      );
    } finally {
      clock.dispose();
    }
  });

  test('tail host disposal stops the active stream while retaining the provider for recovery', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      (provider as any).refreshViewState = async () => undefined;

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({
        type: 'ready',
        mountSequence: provider.getWebviewDiagnosticState().mountSequence
      });
      await clock.flushMicrotasks();

      (provider as any).tailService.tailRunning = true;
      postTailUpdate(provider, { type: 'tailStatus', running: true });
      view.fireDispose();
      await clock.flushMicrotasks();

      assert.equal(provider.isReady(), false);
      assert.equal(provider.getWebviewDiagnosticState().disposed, false);
      assert.equal(provider.getWebviewDiagnosticState().snapshots.tailRunning, false);
    } finally {
      clock.dispose();
    }
  });

  test('syncSelectedOrg refreshes an existing editor tail session and stops the current stream', async () => {
    const clock = new TestClock();
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const webview = new MockWebview();
    const panel = new MockWebviewPanel('electivus.apexLogViewer.tailView.editorPanel', webview);
    const calls: string[] = [];
    const posted: any[] = [];
    webview.postMessage = (message: any) => {
      posted.push(message);
      return Promise.resolve(true);
    };

    postTailUpdate(provider, { type: 'orgs', data: [], selected: undefined });
    postTailUpdate(provider, { type: 'debugLevels', data: [] });
    (provider as any).refreshViewState = async () => {
      calls.push('refreshViewState');
    };
    provider.resolveWebviewPanel(panel);
    await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    await webview.emit({ type: 'ready', mountSequence: provider.getWebviewDiagnosticState().mountSequence });
    await clock.flushMicrotasks();
    posted.length = 0;
    calls.length = 0;
    provider.setSelectedOrg('tail-first@example.com');
    (provider as any).tailService.setOrg('tail-first@example.com');
    (provider as any).tailService.bufferedLines = ['USER_DEBUG|stale'];
    (provider as any).tailService.tailRunning = true;
    await provider.syncSelectedOrg('tail-second@example.com');

    assert.equal(provider.getSelectedOrg(), 'tail-second@example.com');
    assert.deepEqual((provider as any).tailService.getBufferedLines(), []);
    assert.equal((provider as any).tailService.isRunning(), false, 'should stop the previous tail session');
    assert.equal(
      posted.some(message => message?.type === 'tailReset'),
      true,
      'syncSelectedOrg should clear buffered lines before refreshing the next org'
    );
    assert.deepEqual(calls, ['refreshViewState']);
    clock.dispose();
  });
});
