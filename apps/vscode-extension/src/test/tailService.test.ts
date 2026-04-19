import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { PassThrough } from 'stream';
import proxyquire from 'proxyquire';
import { MAX_TAIL_BUFFER_LINES, TailService } from '../../../../src/utils/tailService';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import * as cli from '../../../../src/salesforce/cli';
import * as http from '../../../../src/salesforce/http';
import * as jsforce from '../../../../src/salesforce/jsforce';
import * as streaming from '../../../../src/salesforce/streaming';
import * as traceflags from '../../../../src/salesforce/traceflags';
import {
  __resetApiVersionFallbackStateForTests,
  recordApiVersionFallback,
  setApiVersion
} from '../../../../src/salesforce/apiVersion';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';
import { WEBVIEW_READY_TIMEOUT_MS, WEBVIEW_STABLE_VISIBILITY_DELAY_MS } from '../provider/SfLogTailViewProvider';
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
  return proxyquireStrict('../../../../src/utils/tailService', {
    '../salesforce/cli': stubs?.cli ?? {},
    '../salesforce/http': stubs?.http ?? {},
    '../salesforce/traceflags': stubs?.traceflags ?? {},
    '../salesforce/streaming': stubs?.streaming ?? {},
    '../salesforce/jsforce': stubs?.jsforce ?? {},
    '../../apps/vscode-extension/src/runtime/runtimeClient': stubs?.runtime ?? {
      runtimeClient: {
        getOrgAuth:
          stubs?.cli?.getOrgAuth ??
          (async ({ username }: { username?: string } = {}) => ({
            username,
            instanceUrl: 'https://example.com',
            accessToken: 'token'
          }))
      }
    }
  }) as typeof import('../../../../src/utils/tailService');
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
    '../../../../src/utils/replayDebugger': {
      ensureReplayDebuggerAvailable: async () => true
    },
    '../../../../src/salesforce/traceflags': stubs?.traceflags ?? {},
    '../../../../src/utils/tailService': { TailService: TailServiceStub }
  }) as typeof import('../provider/SfLogTailViewProvider');
}

class MockDisposable implements vscode.Disposable {
  dispose(): void {
    /* noop */
  }
}

class MockWebview implements vscode.Webview {
  html = '';
  options: vscode.WebviewOptions = {};
  cspSource = 'vscode-resource://test';
  private handler: ((e: any) => any) | undefined;
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
  viewType = 'sfLogTail';
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
    const origFetch = http.fetchApexLogs;
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (traceflags as any).ensureUserTraceFlag = async () => false;
    (http as any).fetchApexLogs = async () => [];
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
    (http as any).fetchApexLogs = origFetch;
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
          })
        }
      },
      traceflags: {
        ensureUserTraceFlag: async () => false
      },
      http: {
        fetchApexLogs: async () => [],
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
        fetchApexLogs: async () => [],
        fetchApexLogBody: async () => '',
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

  test('selectOrg resets caches and stops tail', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    (provider as any).sendOrgs = async () => {};
    (provider as any).sendDebugLevels = async () => {};
    await provider.resolveWebviewView(view);
    const service = (provider as any).tailService;
    (service as any).seenLogIds.add('x');
    (service as any).logIdToPath.set('x', 'y');
    (service as any).tailRunning = true;
    await webview.emit({ type: 'selectOrg', target: 'newOrg' });
    assert.equal((service as any).seenLogIds.size, 0);
    assert.equal((service as any).logIdToPath.size, 0);
    assert.equal(service.isRunning(), false);
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
    const { TailService } = loadTailService({
      http: {
        fetchApexLogBody: async () => {
          throw new Error('unconfigured');
        }
      }
    });
    const service = new TailService(() => {});
    (service as any).tailRunning = true;
    (service as any).currentAuth = { username: 'u', instanceUrl: 'i', accessToken: 't' };
    let calls = 0;
    const tailFetch = async () => {
      calls++;
      if (calls === 1) {
        throw new Error('fail');
      }
      return 'body';
    };
    const { TailService: RetryingTailService } = loadTailService({
      http: {
        fetchApexLogBody: tailFetch,
        getEffectiveApiVersion: () => '64.0'
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

  test('ensureLogSaved preserves abortability when using the active tail connection', async () => {
    setApiVersion('64.0');
    const service = new TailService(() => {});
    const auth = { username: 'u', instanceUrl: 'https://example.com', accessToken: 't' };
    const controller = new AbortController();
    const stream = new PassThrough();
    let destroyed = false;
    const originalDestroy = stream.destroy.bind(stream);
    (stream as any).destroy = (...args: any[]) => {
      destroyed = true;
      return originalDestroy(...args);
    };

    (service as any).currentAuth = auth;
    (service as any).connection = {
      version: '64.0',
      instanceUrl: auth.instanceUrl,
      accessToken: auth.accessToken,
      request: () => {
        const promise = new Promise<string>(() => {}) as Promise<string> & { stream: () => PassThrough };
        promise.stream = () => stream;
        return promise;
      },
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

    const pending = service.ensureLogSaved('07Lxx0000000001', controller.signal);
    controller.abort();

    await assert.rejects(pending, /aborted/i);
    assert.equal(destroyed, true);
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
    await provider.resolveWebviewView(view);

    await webview.emit({ type: 'selectOrg', target: 'tail-user@example.com' });
    await webview.emit({ type: 'openDebugFlags' });

    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.selectedOrg, 'tail-user@example.com');
    assert.equal(opened[0]?.sourceView, 'tail');
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
      const panel = new MockWebviewPanel('sfLogTail.editorPanel', webview);

      (provider as any).sendOrgs = async () => {
        posted.push({ type: 'sendOrgsCalled' });
      };
      (provider as any).sendDebugLevels = async () => {
        posted.push({ type: 'sendDebugLevelsCalled' });
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
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

  test('editor tail panel ignores visibility refreshes until ready', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const panel = new MockWebviewPanel('sfLogTail.editorPanel', webview);
      const calls: string[] = [];

      (provider as any).refreshViewState = async () => {
        calls.push('refreshViewState');
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      assert.deepEqual(calls, [], 'should not refresh while the webview has not reported ready');

      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();
      assert.deepEqual(calls, ['refreshViewState'], 'should refresh once after ready');
    } finally {
      clock.dispose();
    }
  });

  test('tail sidebar retries timed-out mounts while it stays visible', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogTailViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      assert.ok(webview.html.includes('media/tail.js'), 'initial mount should render the tail webview');

      await clock.advanceBy(WEBVIEW_READY_TIMEOUT_MS);
      assert.ok(!webview.html.includes('media/tail.js'), 'timeout should fall back to placeholder html');

      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      assert.ok(webview.html.includes('media/tail.js'), 'visible sidebar should auto-remount after timeout');
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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      (provider as any).post({ type: 'error', message: 'tail failed' });
      posted.length = 0;

      view.fireVisible(false);
      view.fireVisible(true);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === 'tail failed'),
        true
      );

      (provider as any).post({ type: 'tailData', lines: ['USER_DEBUG|hello'] });
      posted.length = 0;

      view.fireVisible(false);
      view.fireVisible(true);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.equal(
        posted.some(message => message?.type === 'error'),
        false
      );
    } finally {
      clock.dispose();
    }
  });

  test('syncSelectedOrg refreshes an existing editor tail session and stops the current stream', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const webview = new MockWebview();
    const panel = new MockWebviewPanel('sfLogTail.editorPanel', webview);
    const calls: string[] = [];

    provider.resolveWebviewPanel(panel);
    provider.setSelectedOrg('tail-first@example.com');
    (provider as any).tailService.setOrg('tail-first@example.com');
    (provider as any).tailService.tailRunning = true;
    (provider as any).refreshViewState = async () => {
      calls.push('refreshViewState');
    };

    await provider.syncSelectedOrg('tail-second@example.com');

    assert.equal(provider.getSelectedOrg(), 'tail-second@example.com');
    assert.equal((provider as any).tailService.isRunning(), false, 'should stop the previous tail session');
    assert.deepEqual(calls, ['refreshViewState']);
  });
});
