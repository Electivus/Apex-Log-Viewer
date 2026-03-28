import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'node:os';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();
const makeUri = (filePath: string) => ({ fsPath: filePath, path: filePath, toString: () => filePath });
const makeDisposable = (dispose: () => void = () => {}) => ({ dispose });

function makeContext() {
  const context = {
    extensionUri: vscode.Uri.file(path.resolve('.')),
    subscriptions: [] as vscode.Disposable[]
  } as unknown as vscode.ExtensionContext;
  return context;
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 500));
  const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 10));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  assert.fail(`waitForCondition timed out after ${timeoutMs} ms`);
}

function createProviderHarness() {
  const httpStub: any = {
    clearListCache: () => undefined,
    getApiVersionFallbackWarning: () => undefined
  };
  const workspaceStub: any = {
    getWorkspaceRoot: () => '/tmp/alv-workspace',
    ensureApexLogsDir: async () => path.join(process.cwd(), 'apexlogs'),
    purgeSavedLogs: async () => 0,
    getLogIdFromLogFilePath: () => undefined
  };
  const debugFlagsPanelStub: any = {
    show: async () => undefined
  };
  const runtimeClientStub: any = {
    orgList: async () => [],
    getOrgAuth: async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' }),
    logsList: async () => [],
    searchQuery: async () => ({ logIds: [], snippets: {}, pendingLogIds: [] }),
    logsTriage: async () => []
  };
  const cliStub: any = runtimeClientStub;
  const vscodeMock: any = {
    Uri: {
      file: (filePath: string) => makeUri(filePath),
      joinPath: (base: { fsPath?: string; path?: string; toString?: () => string }, ...pathsToJoin: string[]) => {
        const root = base.fsPath || base.path || base.toString?.() || '';
        return makeUri(path.join(root, ...pathsToJoin));
      }
    },
    Disposable: {
      from: (...items: Array<{ dispose?: () => void }>) =>
        makeDisposable(() => {
          for (const item of items) {
            item?.dispose?.();
          }
        })
    },
    ProgressLocation: {
      Notification: 15
    },
    ViewColumn: {
      Active: -1,
      Beside: -2,
      One: 1
    },
    env: {
      language: 'en-US'
    },
    workspace: {
      onDidChangeConfiguration: () => makeDisposable(),
      openTextDocument: async () => ({})
    },
    window: {
      state: { active: true },
      onDidChangeWindowState: () => makeDisposable(),
      withProgress: async (_opts: any, task: any) =>
        task(
          { report: () => {} },
          {
            onCancellationRequested: () => {},
            isCancellationRequested: false
          }
        ),
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showTextDocument: async () => undefined,
      activeTextEditor: undefined
    },
    commands: {
      getCommands: async () => [],
      executeCommand: async () => undefined
    }
  };

  class LogServiceStub {
    setHeadConcurrency(): void {}
    async fetchLogs(): Promise<any[]> {
      return [];
    }
    loadLogHeads(): void {}
    async ensureLogsSaved(): Promise<any> {
      return {
        total: 0,
        success: 0,
        downloaded: 0,
        existing: 0,
        missing: 0,
        failed: 0,
        cancelled: 0,
        failedLogIds: []
      };
    }
    async classifyLogsForErrors(): Promise<Map<string, any>> {
      return new Map<string, any>();
    }
    async openLog(): Promise<void> {}
    async debugLog(): Promise<void> {}
  }

  class OrgManagerStub {
    private selectedOrg: string | undefined;

    getSelectedOrg(): string | undefined {
      return this.selectedOrg;
    }

    setSelectedOrg(org?: string): void {
      this.selectedOrg = org;
    }

    async ensureProjectDefaultSelected(): Promise<void> {}
  }

  class ConfigManagerStub {
    getHeadConcurrency(): number {
      return 5;
    }

    getPageLimit(): number {
      return 100;
    }

    shouldLoadFullLogBodies(): boolean {
      return false;
    }

    handleChange(): void {}
  }

  const module = proxyquireStrict('../provider/SfLogsViewProvider', {
    vscode: vscodeMock,
    '../../../../src/salesforce/http': httpStub,
    '../../../../src/utils/workspace': workspaceStub,
    '../runtime/runtimeClient': { runtimeClient: runtimeClientStub },
    '../utils/orgManager': { OrgManager: OrgManagerStub },
    '../../../../src/utils/configManager': { ConfigManager: ConfigManagerStub },
    '../../../../src/services/logService': { LogService: LogServiceStub },
    '../panel/DebugFlagsPanel': { DebugFlagsPanel: debugFlagsPanelStub }
  }) as typeof import('../provider/SfLogsViewProvider');

  return {
    SfLogsViewProvider: module.SfLogsViewProvider,
    cli: cliStub,
    http: httpStub,
    workspace: workspaceStub,
    DebugFlagsPanel: debugFlagsPanelStub,
    vscode: vscodeMock
  };
}

suite('SfLogsViewProvider behavior', () => {
  test('refresh posts logs and logHead with code unit', async () => {
    const { SfLogsViewProvider, cli } = createProviderHarness();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-provider-heads-'));
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    cli.logsList = async () => [
      { Id: '07L000000000001AA', LogLength: 10 },
      { Id: '07L000000000002AA', LogLength: 20 }
    ];

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).logService.loadLogHeads = (
      logs: Array<{ Id: string }>,
      _auth: unknown,
      _token: number,
      postHead: (logId: string, codeUnit: string) => void
    ) => {
      for (const log of logs) {
        postHead(log.Id, 'MyClass.myMethod');
      }
    };
    // Inject minimal view so refresh proceeds
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    try {
      await provider.refresh();
      await waitForCondition(() => posted.filter(m => typeof m?.codeUnitStarted === 'string').length === 2);

      const init = posted.find(m => m?.type === 'init');
      const logs = posted.find(m => m?.type === 'logs');
      const heads = posted.filter(m => m?.type === 'logHead');
      const codeUnitHeads = heads.filter(m => typeof m?.codeUnitStarted === 'string' && m.codeUnitStarted.length > 0);
      assert.ok(init, 'should post init');
      assert.ok(logs, 'should post logs');
      assert.equal((logs?.data || []).length, 2, 'should include two logs');
      assert.equal(codeUnitHeads.length, 2, 'should post code unit head for each log');
      const byId = new Map(codeUnitHeads.map(m => [m.logId, m.codeUnitStarted]));
      assert.equal(byId.get('07L000000000001AA'), 'MyClass.myMethod');
      assert.equal(byId.get('07L000000000002AA'), 'MyClass.myMethod');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('refresh preloads full log bodies when enabled', async () => {
    const { SfLogsViewProvider, cli, workspace } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    cli.logsList = async () => [
      { Id: '07L000000000001AA' },
      { Id: '07L000000000002AA' }
    ];

    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => true;
    (provider as any).view = {
      webview: {
        postMessage: () => Promise.resolve(true)
      }
    } as any;
    (provider as any).logService.loadLogHeads = () => {};

    const calls: Array<{ logs: any[]; signal?: AbortSignal }> = [];
    (provider as any).logService.ensureLogsSaved = async (
      logs: any[],
      _org: string | undefined,
      signal?: AbortSignal,
      _options?: any
    ) => {
      calls.push({ logs, signal });
    };
    const purged: Array<{ keepIds?: Set<string>; maxAgeMs?: number; signal?: AbortSignal }> = [];
    workspace.purgeSavedLogs = async (opts: any) => {
      purged.push(opts);
      return 3;
    };

    await provider.refresh();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(calls.length, 1, 'should preload log bodies once');
    assert.deepEqual(
      calls[0]?.logs.map(l => l.Id),
      ['07L000000000001AA', '07L000000000002AA'],
      'should pass fetched logs to ensureLogsSaved'
    );
    assert.equal(typeof calls[0]?.signal?.aborted, 'boolean', 'should pass abort signal to ensureLogsSaved');
    assert.equal(purged.length, 1, 'should purge cached logs after refresh');
    const keepIds = Array.from(purged[0]?.keepIds ?? []);
    assert.deepEqual(
      keepIds.sort(),
      ['07L000000000001AA', '07L000000000002AA'],
      'purge should keep current log ids'
    );
  });

  test('refresh posts progressive error scan status and marks visible logs with errors', async () => {
    const { SfLogsViewProvider, cli, workspace } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    cli.logsList = async () => [
      { Id: '07L000000000001AA', LogLength: 10 },
      { Id: '07L000000000002AA', LogLength: 20 }
    ];
    const triageCalls: Array<{ logIds: string[]; workspaceRoot?: string }> = [];
    cli.logsTriage = async (params: { logIds: string[]; workspaceRoot?: string }) => {
      triageCalls.push(params);
      return [
        {
          logId: params.logIds[0],
          summary: {
            hasErrors: true,
            primaryReason: 'Fatal exception',
            reasons: [
              {
                code: 'fatal_exception',
                severity: 'error',
                summary: 'Fatal exception',
                line: 1,
                eventType: 'EXCEPTION_THROWN'
              }
            ]
          }
        },
        {
          logId: params.logIds[1],
          summary: {
            hasErrors: false,
            reasons: []
          }
        }
      ];
    };
    workspace.purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => false;
    (provider as any).logService.loadLogHeads = () => {};
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    await provider.refresh();
    await new Promise(resolve => setTimeout(resolve, 30));

    const scanRunning = posted.find(m => m?.type === 'errorScanStatus' && m?.state === 'running');
    const scanIdle = posted.find(m => m?.type === 'errorScanStatus' && m?.state === 'idle' && m?.total === 2);
    const errorHead = posted.find(m => m?.type === 'logHead' && m?.logId === '07L000000000001AA' && m?.hasErrors === true);

    assert.ok(scanRunning, 'should post running scan status');
    assert.ok(scanIdle, 'should post idle scan status after completion');
    assert.ok(errorHead, 'should mark visible error log in logHead stream');
    assert.equal(errorHead?.primaryReason, 'Fatal exception');
    assert.equal(errorHead?.reasons?.[0]?.code, 'fatal_exception');
    assert.equal(triageCalls[0]?.workspaceRoot, '/tmp/alv-workspace');
  });

  test('refresh cancellation aborts background error scan', async () => {
    const { SfLogsViewProvider, cli, workspace, vscode: vscodeMock } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    cli.logsList = async () => [{ Id: '07L000000000001AA', LogLength: 10 }];
    workspace.purgeSavedLogs = async () => 0;

    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => false;
    (provider as any).logService.loadLogHeads = () => {};

    const posted: any[] = [];
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    let triageSignal: AbortSignal | undefined;
    let triageStarted!: () => void;
    const started = new Promise<void>(resolve => {
      triageStarted = resolve;
    });
    cli.logsTriage = async (_params: { logIds: string[] }, signal?: AbortSignal) => {
      if (signal) {
        triageSignal = signal;
      }
      triageStarted();
      await new Promise(resolve => setTimeout(resolve, 30));
      return [];
    };

    vscodeMock.window.withProgress = async (_opts: any, task: any) => {
      let cancel: (() => void) | undefined;
      const token: any = {
        onCancellationRequested: (listener: () => void) => {
          cancel = listener;
        },
        isCancellationRequested: false
      };
      const resultPromise = task({ report: () => {} }, token);
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 200))]);
      token.isCancellationRequested = true;
      cancel?.();
      return resultPromise;
    };

    await provider.refresh();
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.ok(triageSignal, 'should start runtime triage');
    assert.equal(triageSignal?.aborted, true, 'scan signal should be aborted when refresh is cancelled');
    assert.ok(posted.some(m => m?.type === 'errorScanStatus' && m?.state === 'running'), 'should have started scan status');
  });

  test('preloadFullLogBodies re-runs active search after downloads complete', async () => {
    const { SfLogsViewProvider } = createProviderHarness();
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => true;
    (provider as any).lastSearchQuery = 'error';

    const searchCalls: string[] = [];
    (provider as any).executeSearch = async (query: string) => {
      searchCalls.push(query);
    };
    (provider as any).logService.ensureLogsSaved = async () => ({
      total: 1,
      success: 1,
      downloaded: 1,
      existing: 0,
      missing: 0,
      failed: 0,
      cancelled: 0,
      failedLogIds: []
    });

    (provider as any).preloadFullLogBodies([{ Id: '07L000000000001AA' }]);
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(searchCalls, ['error'], 'should re-run active search after preload saves logs');
  });

  test('refresh posts API version fallback warning when available', async () => {
    const { SfLogsViewProvider, cli, http, workspace } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    cli.logsList = async () => [{ Id: '07L000000000001AA', LogLength: 10 }];
    http.getApiVersionFallbackWarning = () =>
      'sourceApiVersion 66.0 > org max 64.0; falling back to 64.0';
    workspace.purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => false;
    (provider as any).logService.loadLogHeads = () => {};
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    await provider.refresh();
    await new Promise(resolve => setTimeout(resolve, 20));

    const warnings = posted.filter(m => m?.type === 'warning');
    assert.ok(warnings.some(m => m.message === undefined), 'should clear warning before refresh');
    assert.ok(
      warnings.some(m => m.message === 'sourceApiVersion 66.0 > org max 64.0; falling back to 64.0'),
      'should post fallback warning when available'
    );
  });

  test('searchQuery posts searchMatches from runtime search results', async () => {
    const { SfLogsViewProvider, cli, workspace } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    cli.logsList = async () => [{ Id: '07L000000000001AA', LogLength: 10 }];

    const tmpDir = path.join(process.cwd(), 'tmp-apexlogs-tests');
    await fs.mkdir(tmpDir, { recursive: true });
    workspace.ensureApexLogsDir = async () => tmpDir;
    workspace.purgeSavedLogs = async () => 0;
    workspace.getLogIdFromLogFilePath = (filePath: string) => {
      const match = /07L[0-9A-Za-z]+/.exec(filePath);
      return match?.[0];
    };

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => true;
    (provider as any).logService.loadLogHeads = () => {};
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    const searchCalls: any[] = [];
    const needle = '323301606';
    cli.searchQuery = async (params: any) => {
      searchCalls.push(params);
      return {
        logIds: ['07L000000000001AA'],
        snippets: {
          '07L000000000001AA': {
            text: `Usuário João gerou erro crítico ${needle}`,
            ranges: [[33, 42]]
          }
        },
        pendingLogIds: []
      };
    };

    try {
      await provider.refresh();
      await new Promise(r => setTimeout(r, 20));
      await (provider as any).setSearchQuery('error');
      await new Promise(r => setTimeout(r, 20));

      assert.equal(searchCalls.length, 1, 'should call runtime search once');
      assert.deepEqual(searchCalls[0], {
        username: undefined,
        query: 'error',
        logIds: ['07L000000000001AA'],
        workspaceRoot: '/tmp/alv-workspace'
      });
      const matches = posted
        .filter(m => m?.type === 'searchMatches' && Array.isArray(m.logIds) && m.logIds.includes('07L000000000001AA'))
        .pop();
      assert.ok(matches, 'should post searchMatches');
      assert.deepEqual(matches?.logIds, ['07L000000000001AA']);
      assert.ok(matches?.snippets, 'should include snippets payload');
      const snippet = matches?.snippets?.['07L000000000001AA'];
      assert.ok(snippet, 'should include snippet for match');
      assert.ok(snippet?.ranges?.length, 'snippet should include highlight ranges');
      assert.ok(snippet?.text.includes(needle), 'snippet should contain the matched text');
      assert.ok(Array.isArray(matches?.pendingLogIds), 'should include pendingLogIds array');
      assert.equal((matches?.pendingLogIds || []).length, 0, 'pendingLogIds should be empty when cached');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('searchQuery posts pendingLogIds from runtime search results', async () => {
    const { SfLogsViewProvider, cli, workspace } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    cli.logsList = async () => [{ Id: '07L000000000001AA', LogLength: 10 }];

    const tmpDir = path.join(process.cwd(), 'tmp-apexlogs-tests-missing');
    await fs.mkdir(tmpDir, { recursive: true });
    workspace.ensureApexLogsDir = async () => tmpDir;
    workspace.purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => true;
    (provider as any).logService.loadLogHeads = () => {};
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    let searchCalls = 0;
    cli.searchQuery = async () => {
      searchCalls++;
      return {
        logIds: [],
        snippets: {},
        pendingLogIds: ['07L000000000001AA']
      };
    };

    try {
      await provider.refresh();
      await new Promise(r => setTimeout(r, 20));
      await (provider as any).setSearchQuery('anything');
      await new Promise(r => setTimeout(r, 20));

      const matches = posted
        .filter(m => m?.type === 'searchMatches')
        .pop();
      assert.ok(matches, 'should post searchMatches even when missing');
      assert.ok(Array.isArray(matches?.pendingLogIds), 'pendingLogIds should be an array');
      assert.deepEqual(matches?.pendingLogIds, ['07L000000000001AA']);
      assert.equal(searchCalls, 1, 'should delegate missing-log state to runtime search');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('setSearchQuery aborts previous search before running a new one', async () => {
    const { SfLogsViewProvider, cli, workspace } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    cli.logsList = async () => [{ Id: '07L000000000001AA', LogLength: 10 }];

    const tmpDir = path.join(process.cwd(), 'tmp-apexlogs-tests-cancel');
    await fs.mkdir(tmpDir, { recursive: true });
    workspace.ensureApexLogsDir = async () => tmpDir;
    workspace.purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => true;
    (provider as any).logService.loadLogHeads = () => {};
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    await provider.refresh();
    await new Promise(r => setTimeout(r, 20));

    const searchSignals: AbortSignal[] = [];
    cli.searchQuery = async (_params: any, signal?: AbortSignal) => {
      if (signal) {
        searchSignals.push(signal);
      }
      if (searchSignals.length === 1 && signal) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      return {
        logIds: signal?.aborted ? [] : ['07L000000000001AA'],
        snippets: {},
        pendingLogIds: []
      };
    };

    try {
      const firstSearch = (provider as any).setSearchQuery('first');
      await new Promise(r => setTimeout(r, 10));
      await (provider as any).setSearchQuery('second');
      await firstSearch;
      await new Promise(r => setTimeout(r, 10));

      assert.ok(searchSignals[0]?.aborted, 'first search should be aborted');
      assert.equal(searchSignals.length, 2, 'should issue runtime search twice');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadMore appends logs', async () => {
    const { SfLogsViewProvider, cli } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    let listCalls = 0;
    cli.logsList = async (_params: any) => {
      listCalls++;
      if (listCalls > 1) {
        return [{ Id: '2', LogLength: 20 }];
      }
      return [{ Id: '1', LogLength: 10 }];
    };

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).logService.loadLogHeads = (
      logs: Array<{ Id: string }>,
      _auth: unknown,
      _token: number,
      postHead: (logId: string, codeUnit: string) => void
    ) => {
      for (const log of logs) {
        postHead(log.Id, 'C.m');
      }
    };
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    await provider.refresh();
    await new Promise(r => setTimeout(r, 10));
    await (provider as any).loadMore();
    await new Promise(r => setTimeout(r, 10));

    const append = posted.find(m => m?.type === 'appendLogs');
    assert.ok(append, 'should post appendLogs');
    assert.equal((append?.data || []).length, 1);
    assert.equal(append.data[0]?.Id, '2');
  });

  test('openLog forwards to logService', async () => {
    const { SfLogsViewProvider } = createProviderHarness();
    const opened: string[] = [];
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    (provider as any).logService.openLog = async (logId: string) => {
      opened.push(logId);
    };
    class MockWebview implements vscode.Webview {
      html = '';
      options: vscode.WebviewOptions = {};
      cspSource = 'vscode-resource://test';
      private handler: ((e: any) => any) | undefined;
      asWebviewUri(uri: vscode.Uri): vscode.Uri { return uri; }
      postMessage(_message: any): Thenable<boolean> { return Promise.resolve(true); }
      onDidReceiveMessage(listener: (e: any) => any): vscode.Disposable {
        this.handler = listener; return { dispose() {} } as any;
      }
      emit(message: any) { return this.handler?.(message); }
    }
    class MockWebviewView implements vscode.WebviewView {
      visible = true; title = 'Test'; viewType = 'sfLogViewer';
      description?: string | undefined; badge?: { value: number; tooltip: string } | undefined;
      webview: vscode.Webview; constructor(webview: vscode.Webview) { this.webview = webview; }
      show(): void { /* noop */ }
      onDidChangeVisibility: vscode.Event<void> = () => ({ dispose() {} } as any);
      onDidDispose: vscode.Event<void> = () => ({ dispose() {} } as any);
    }
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    await provider.resolveWebviewView(view);
    await (webview as any).emit({ type: 'openLog', logId: 'abc' });
    assert.equal(opened[0], 'abc');
  });

  test('debugLog forwards to logService', async () => {
    const { SfLogsViewProvider } = createProviderHarness();
    const executed: string[] = [];
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    (provider as any).logService.debugLog = async (logId: string) => {
      executed.push(logId);
    };
    class MockWebview implements vscode.Webview {
      html = '';
      options: vscode.WebviewOptions = {};
      cspSource = 'vscode-resource://test';
      private handler: ((e: any) => any) | undefined;
      asWebviewUri(uri: vscode.Uri): vscode.Uri { return uri; }
      postMessage(_message: any): Thenable<boolean> { return Promise.resolve(true); }
      onDidReceiveMessage(listener: (e: any) => any): vscode.Disposable {
        this.handler = listener; return { dispose() {} } as any;
      }
      emit(message: any) { return this.handler?.(message); }
    }
    class MockWebviewView implements vscode.WebviewView {
      visible = true; title = 'Test'; viewType = 'sfLogViewer';
      description?: string | undefined; badge?: { value: number; tooltip: string } | undefined;
      webview: vscode.Webview; constructor(webview: vscode.Webview) { this.webview = webview; }
      show(): void { /* noop */ }
      onDidChangeVisibility: vscode.Event<void> = () => ({ dispose() {} } as any);
      onDidDispose: vscode.Event<void> = () => ({ dispose() {} } as any);
    }
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    await provider.resolveWebviewView(view);
    await (webview as any).emit({ type: 'replay', logId: 'abc' });
    assert.equal(executed[0], 'abc');
  });

  test('downloadAllLogs message performs explicit bulk download flow', async () => {
    const { SfLogsViewProvider, cli, vscode: vscodeMock } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    (provider as any).lastSearchQuery = 'error';
    (provider as any).configManager.getPageLimit = () => 2;

    const callOrder: string[] = [];
    const listSignals: AbortSignal[] = [];
    const listCalls: any[] = [];
    cli.logsList = async (params: any, signal?: AbortSignal) => {
      callOrder.push('list');
      listCalls.push(params);
      if (signal) {
        listSignals.push(signal);
      }
      if (listCalls.length === 1) {
        return [
          { Id: '07L000000000001AA', StartTime: '2026-01-01T00:00:00.000Z', LogLength: 10 },
          { Id: '07L000000000002AA', StartTime: '2025-12-31T23:59:59.000Z', LogLength: 20 }
        ] as any;
      }
      if (listCalls.length === 2) {
        return [
          { Id: '07L000000000003AA', StartTime: '2025-12-31T23:59:58.000Z', LogLength: 30 }
        ] as any;
      }
      return [] as any;
    };
    const searchCalls: string[] = [];
    (provider as any).executeSearch = async (query: string) => {
      searchCalls.push(query);
    };

    const ensureCalls: Array<{ count: number; selectedOrg?: string }> = [];
    (provider as any).logService.ensureLogsSaved = async (
      logs: any[],
      selectedOrg?: string,
      _signal?: AbortSignal,
      options?: { onItemComplete?: (result: { logId: string; status: string }) => void }
    ) => {
      ensureCalls.push({ count: logs.length, selectedOrg });
      for (const log of logs) {
        options?.onItemComplete?.({ logId: log.Id, status: 'downloaded' });
      }
      return {
        total: logs.length,
        success: logs.length,
        downloaded: logs.length,
        existing: 0,
        missing: 0,
        failed: 0,
        cancelled: 0,
        failedLogIds: []
      };
    };

    const warningCalls: any[] = [];
    vscodeMock.window.showWarningMessage = async (...args: any[]) => {
      callOrder.push('confirm');
      warningCalls.push(args);
      return args[2];
    };
    const infoCalls: any[] = [];
    vscodeMock.window.showInformationMessage = async (...args: any[]) => {
      infoCalls.push(args);
      return undefined;
    };
    vscodeMock.window.showErrorMessage = async () => undefined;
    vscodeMock.window.withProgress = async (_opts: any, task: any) =>
      task(
        { report: () => {} },
        {
          onCancellationRequested: () => {},
          isCancellationRequested: false
        }
      );

    class MockWebview implements vscode.Webview {
      html = '';
      options: vscode.WebviewOptions = {};
      cspSource = 'vscode-resource://test';
      private handler: ((e: any) => any) | undefined;
      asWebviewUri(uri: vscode.Uri): vscode.Uri { return uri; }
      postMessage(_message: any): Thenable<boolean> { return Promise.resolve(true); }
      onDidReceiveMessage(listener: (e: any) => any): vscode.Disposable {
        this.handler = listener; return { dispose() {} } as any;
      }
      emit(message: any) { return this.handler?.(message); }
    }
    class MockWebviewView implements vscode.WebviewView {
      visible = true; title = 'Test'; viewType = 'sfLogViewer';
      description?: string | undefined; badge?: { value: number; tooltip: string } | undefined;
      webview: vscode.Webview; constructor(webview: vscode.Webview) { this.webview = webview; }
      show(): void { /* noop */ }
      onDidChangeVisibility: vscode.Event<void> = () => ({ dispose() {} } as any);
      onDidDispose: vscode.Event<void> = () => ({ dispose() {} } as any);
    }
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    await provider.resolveWebviewView(view);
    await (webview as any).emit({ type: 'downloadAllLogs' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(ensureCalls.length, 1, 'should perform one bulk save run');
    assert.equal(ensureCalls[0]?.count, 3, 'should include all paged logs fetched for the org');
    assert.ok(warningCalls.length >= 1, 'should request user confirmation');
    assert.ok(infoCalls.length >= 1, 'should show completion summary');
    assert.equal(callOrder[0], 'confirm', 'should confirm before listing org logs');
    assert.equal(typeof listSignals[0]?.aborted, 'boolean', 'should pass cancellation signal while listing logs');
    assert.ok(searchCalls.includes('error'), 'should re-run active search query after bulk download');
    assert.deepEqual(listCalls[0], { username: undefined, limit: 2, cursor: undefined });
    assert.deepEqual(listCalls[1], {
      username: undefined,
      limit: 2,
      cursor: {
        beforeStartTime: '2025-12-31T23:59:59.000Z',
        beforeId: '07L000000000002AA'
      }
    });
  });

  test('downloadAllLogs supports cancellation while listing org logs', async () => {
    const { SfLogsViewProvider, cli, vscode: vscodeMock } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);

    const listSignals: AbortSignal[] = [];
    cli.logsList = async (_params: any, signal?: AbortSignal) => {
      if (signal) {
        listSignals.push(signal);
      }
      await new Promise(resolve => setTimeout(resolve, 30));
      if (signal?.aborted) {
        const error = new Error('The operation was aborted');
        (error as { name?: string }).name = 'AbortError';
        throw error;
      }
      return [
        { Id: '07L000000000001AA', StartTime: '2026-01-01T00:00:00.000Z', LogLength: 10 }
      ] as any;
    };

    let ensureCalled = false;
    (provider as any).logService.ensureLogsSaved = async () => {
      ensureCalled = true;
      return {
        total: 0,
        success: 0,
        downloaded: 0,
        existing: 0,
        missing: 0,
        failed: 0,
        cancelled: 0,
        failedLogIds: []
      };
    };

    const warningCalls: string[] = [];
    const errorCalls: string[] = [];
    vscodeMock.window.showWarningMessage = async (...args: any[]) => {
      warningCalls.push(String(args[0]));
      if (typeof args[2] === 'string') {
        return args[2];
      }
      return undefined;
    };
    vscodeMock.window.showInformationMessage = async () => undefined;
    vscodeMock.window.showErrorMessage = async (message: string) => {
      errorCalls.push(message);
      return undefined;
    };
    vscodeMock.window.withProgress = async (_opts: any, task: any) => {
      let cancel: (() => void) | undefined;
      const resultPromise = task(
        { report: () => {} },
        {
          onCancellationRequested: (listener: () => void) => {
            cancel = listener;
          },
          isCancellationRequested: false
        }
      );
      cancel?.();
      return resultPromise;
    };

    class MockWebview implements vscode.Webview {
      html = '';
      options: vscode.WebviewOptions = {};
      cspSource = 'vscode-resource://test';
      private handler: ((e: any) => any) | undefined;
      asWebviewUri(uri: vscode.Uri): vscode.Uri { return uri; }
      postMessage(_message: any): Thenable<boolean> { return Promise.resolve(true); }
      onDidReceiveMessage(listener: (e: any) => any): vscode.Disposable {
        this.handler = listener; return { dispose() {} } as any;
      }
      emit(message: any) { return this.handler?.(message); }
    }
    class MockWebviewView implements vscode.WebviewView {
      visible = true; title = 'Test'; viewType = 'sfLogViewer';
      description?: string | undefined; badge?: { value: number; tooltip: string } | undefined;
      webview: vscode.Webview; constructor(webview: vscode.Webview) { this.webview = webview; }
      show(): void { /* noop */ }
      onDidChangeVisibility: vscode.Event<void> = () => ({ dispose() {} } as any);
      onDidDispose: vscode.Event<void> = () => ({ dispose() {} } as any);
    }
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    await provider.resolveWebviewView(view);
    await (webview as any).emit({ type: 'downloadAllLogs' });
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(ensureCalled, false, 'should not start downloads when cancelled during listing');
    assert.equal(listSignals.length >= 1, true, 'should pass signal to listing calls');
    assert.equal(listSignals[0]?.aborted, true, 'listing signal should be aborted after cancellation');
    assert.ok(
      warningCalls.some(msg => msg.includes('cancelled while listing logs')),
      'should show cancellation summary for listing stage'
    );
    assert.equal(errorCalls.length, 0, 'should not show hard error toast for listing abort');
  });

  test('openDebugFlags opens debug flags panel', async () => {
    const { SfLogsViewProvider, DebugFlagsPanel } = createProviderHarness();
    const opened: Array<{ selectedOrg?: string; sourceView?: string }> = [];
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    provider.setSelectedOrg('user@example.com');
    (DebugFlagsPanel as any).show = async (options: any) => {
      opened.push(options || {});
    };

    class MockWebview implements vscode.Webview {
      html = '';
      options: vscode.WebviewOptions = {};
      cspSource = 'vscode-resource://test';
      private handler: ((e: any) => any) | undefined;
      asWebviewUri(uri: vscode.Uri): vscode.Uri { return uri; }
      postMessage(_message: any): Thenable<boolean> { return Promise.resolve(true); }
      onDidReceiveMessage(listener: (e: any) => any): vscode.Disposable {
        this.handler = listener; return { dispose() {} } as any;
      }
      emit(message: any) { return this.handler?.(message); }
    }
    class MockWebviewView implements vscode.WebviewView {
      visible = true; title = 'Test'; viewType = 'sfLogViewer';
      description?: string | undefined; badge?: { value: number; tooltip: string } | undefined;
      webview: vscode.Webview; constructor(webview: vscode.Webview) { this.webview = webview; }
      show(): void { /* noop */ }
      onDidChangeVisibility: vscode.Event<void> = () => ({ dispose() {} } as any);
      onDidDispose: vscode.Event<void> = () => ({ dispose() {} } as any);
    }
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    await provider.resolveWebviewView(view);
    await (webview as any).emit({ type: 'openDebugFlags' });

    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.selectedOrg, 'user@example.com');
    assert.equal(opened[0]?.sourceView, 'logs');
  });

  test('tailLogs falls back when viewsService command is unavailable', async () => {
    const { SfLogsViewProvider, vscode: vscodeMock } = createProviderHarness();
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    const executed: string[] = [];
    vscodeMock.commands.executeCommand = async (command: string) => {
      executed.push(command);
      if (command === 'workbench.viewsService.openView') {
        throw new Error('Command not found');
      }
      return undefined;
    };

    await provider.tailLogs();

    assert.deepEqual(executed, [
      'workbench.view.extension.salesforceTailPanel',
      'workbench.viewsService.openView',
      'workbench.action.openView'
    ]);
  });
});
