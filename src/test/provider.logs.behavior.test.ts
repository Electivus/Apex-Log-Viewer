import assert from 'assert/strict';
import { Buffer } from 'node:buffer';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'node:os';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import * as cli from '../salesforce/cli';
import * as http from '../salesforce/http';
import * as workspace from '../utils/workspace';
import * as ripgrep from '../utils/ripgrep';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';

function makeContext() {
  const context = {
    extensionUri: vscode.Uri.file(path.resolve('.')),
    subscriptions: [] as vscode.Disposable[]
  } as unknown as vscode.ExtensionContext;
  return context;
}

suite('SfLogsViewProvider behavior', () => {
  const origGetOrgAuth = cli.getOrgAuth;
  const origFetchApexLogs = http.fetchApexLogs;
  const origFetchHead = http.fetchApexLogHead;
  const origFetchBody = http.fetchApexLogBody;
  const origGetApiVersionFallbackWarning = (http as any).getApiVersionFallbackWarning;
  const origExtract = http.extractCodeUnitStartedFromLines;
  const origEnsureApexLogsDir = workspace.ensureApexLogsDir;
  const origPurgeSavedLogs = workspace.purgeSavedLogs;
  const origRipgrepSearch = ripgrep.ripgrepSearch;
  const origOpenTextDocument = vscode.workspace.openTextDocument;
  const origShowTextDocument = vscode.window.showTextDocument;
  const origShowWarningMessage = vscode.window.showWarningMessage;
  const origShowInformationMessage = vscode.window.showInformationMessage;
  const origShowErrorMessage = vscode.window.showErrorMessage;
  const origWithProgress = vscode.window.withProgress;
  const origGetCommands = vscode.commands.getCommands;
  const origExecCommand = vscode.commands.executeCommand;
  const origDebugFlagsShow = DebugFlagsPanel.show;

  teardown(() => {
    (cli as any).getOrgAuth = origGetOrgAuth;
    (http as any).fetchApexLogs = origFetchApexLogs;
    (http as any).fetchApexLogHead = origFetchHead;
    (http as any).fetchApexLogBody = origFetchBody;
    (http as any).getApiVersionFallbackWarning = origGetApiVersionFallbackWarning;
    (http as any).extractCodeUnitStartedFromLines = origExtract;
    (workspace as any).ensureApexLogsDir = origEnsureApexLogsDir;
    (workspace as any).purgeSavedLogs = origPurgeSavedLogs;
    (ripgrep as any).ripgrepSearch = origRipgrepSearch;
    (vscode.workspace as any).openTextDocument = origOpenTextDocument;
    (vscode.window as any).showTextDocument = origShowTextDocument;
    (vscode.window as any).showWarningMessage = origShowWarningMessage;
    (vscode.window as any).showInformationMessage = origShowInformationMessage;
    (vscode.window as any).showErrorMessage = origShowErrorMessage;
    (vscode.window as any).withProgress = origWithProgress;
    (vscode.commands as any).getCommands = origGetCommands;
    (vscode.commands as any).executeCommand = origExecCommand;
    (DebugFlagsPanel as any).show = origDebugFlagsShow;
  });

  test('refresh posts logs and logHead with code unit', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-provider-heads-'));
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => ([
      { Id: '07L000000000001AA', LogLength: 10 },
      { Id: '07L000000000002AA', LogLength: 20 }
    ]);
    (http as any).fetchApexLogBody = async () => '\n|CODE_UNIT_STARTED|Foo|MyClass.myMethod\n';
    (http as any).extractCodeUnitStartedFromLines = () => 'MyClass.myMethod';
    (workspace as any).purgeSavedLogs = async () => 0;
    (workspace as any).findExistingLogFile = async () => undefined;
    (workspace as any).getLogFilePathWithUsername = async (_username: string | undefined, logId: string) => ({
      dir: tmpDir,
      filePath: path.join(tmpDir, `u_${logId}.log`)
    });

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
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
      // Allow background tasks to complete
      await new Promise(r => setTimeout(r, 50));

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
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => ([
      { Id: '07L000000000001AA' },
      { Id: '07L000000000002AA' }
    ]);
    (http as any).fetchApexLogHead = async () => [];
    (http as any).extractCodeUnitStartedFromLines = () => undefined;

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
    (workspace as any).purgeSavedLogs = async (opts: any) => {
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
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => ([
      { Id: '07L000000000001AA', LogLength: 10 },
      { Id: '07L000000000002AA', LogLength: 20 }
    ]);
    (http as any).fetchApexLogHead = async () => [];
    (http as any).extractCodeUnitStartedFromLines = () => undefined;
    (workspace as any).purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => false;
    (provider as any).logService.classifyLogsForErrors = async (
      logs: Array<{ Id: string }>,
      _selectedOrg: string | undefined,
      _signal: AbortSignal | undefined,
      options?: { onProgress?: (entry: any) => void }
    ) => {
      options?.onProgress?.({
        logId: logs[0]!.Id,
        hasErrors: true,
        processed: 1,
        total: logs.length,
        errorsFound: 1
      });
      options?.onProgress?.({
        logId: logs[1]!.Id,
        hasErrors: false,
        processed: 2,
        total: logs.length,
        errorsFound: 1
      });
      return new Map<string, boolean>([
        [logs[0]!.Id, true],
        [logs[1]!.Id, false]
      ]);
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
    await new Promise(resolve => setTimeout(resolve, 30));

    const scanRunning = posted.find(m => m?.type === 'errorScanStatus' && m?.state === 'running');
    const scanIdle = posted.find(m => m?.type === 'errorScanStatus' && m?.state === 'idle' && m?.total === 2);
    const errorHead = posted.find(m => m?.type === 'logHead' && m?.logId === '07L000000000001AA' && m?.hasErrors === true);

    assert.ok(scanRunning, 'should post running scan status');
    assert.ok(scanIdle, 'should post idle scan status after completion');
    assert.ok(errorHead, 'should mark visible error log in logHead stream');
  });

  test('preloadFullLogBodies re-runs active search after downloads complete', async () => {
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
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => ([{ Id: '07L000000000001AA', LogLength: 10 }]);
    (http as any).fetchApexLogHead = async () => [];
    (http as any).extractCodeUnitStartedFromLines = () => undefined;
    (http as any).getApiVersionFallbackWarning = () =>
      'sourceApiVersion 66.0 > org max 64.0; falling back to 64.0';
    (workspace as any).purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => false;
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

  test('searchQuery posts searchMatches when ripgrep finds logs', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => ([{ Id: '07L000000000001AA', LogLength: 10 }]);
    (http as any).fetchApexLogHead = async () => [];
    (http as any).fetchApexLogBody = async () => 'Body';
    (http as any).extractCodeUnitStartedFromLines = () => undefined;

    const tmpDir = path.join(process.cwd(), 'tmp-apexlogs-tests');
    await fs.mkdir(tmpDir, { recursive: true });
    (workspace as any).ensureApexLogsDir = async () => tmpDir;
    (workspace as any).purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => true;
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    const ensureOptions: any[] = [];
    const sampleLine = 'Usuário João gerou erro crítico 323301606';
    const needle = '323301606';
    const filePath = path.join(tmpDir, 'default_07L000000000001AA.log');
    (provider as any).logService.ensureLogsSaved = async (
      _logs: any[],
      _org: string | undefined,
      _signal?: AbortSignal,
      options?: { downloadMissing?: boolean }
    ) => {
      ensureOptions.push(options);
      if (options?.downloadMissing === false) {
        return;
      }
      await fs.writeFile(filePath, sampleLine, 'utf8');
    };
    (ripgrep as any).ripgrepSearch = async (
      _pattern: string,
      _cwd: string,
      _signal?: AbortSignal
    ) => {
      const prefix = sampleLine.slice(0, sampleLine.indexOf(needle));
      const start = Buffer.from(prefix, 'utf8').length;
      const end = start + Buffer.from(needle, 'utf8').length;
      return [
        {
          filePath: path.join(tmpDir, 'default_07L000000000001AA.log'),
          lineText: sampleLine,
          submatches: [{ start, end }]
        }
      ];
    };

    try {
      await provider.refresh();
      await new Promise(r => setTimeout(r, 20));
      await (provider as any).setSearchQuery('error');
      await new Promise(r => setTimeout(r, 20));

      assert.equal(ensureOptions.length >= 1, true, 'ensureLogsSaved should be called');
      assert.ok(
        ensureOptions.some(opt => opt && opt.downloadMissing === false),
        'search ensureLogsSaved call should skip downloads'
      );
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

  test('searchQuery posts pendingLogIds when bodies are missing', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => ([{ Id: '07L000000000001AA', LogLength: 10 }]);
    (http as any).fetchApexLogHead = async () => [];
    (http as any).fetchApexLogBody = async () => 'Body';

    const tmpDir = path.join(process.cwd(), 'tmp-apexlogs-tests-missing');
    await fs.mkdir(tmpDir, { recursive: true });
    (workspace as any).ensureApexLogsDir = async () => tmpDir;
    (workspace as any).purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => true;
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    (provider as any).logService.ensureLogsSaved = async (
      logs: any[],
      _org: string | undefined,
      _signal?: AbortSignal,
      options?: { downloadMissing?: boolean; onMissing?: (id: string) => void }
    ) => {
      if (options?.downloadMissing === false && typeof options.onMissing === 'function') {
        for (const log of logs) {
          if (log?.Id) {
            options.onMissing(log.Id);
          }
        }
      }
    };
    let ripgrepCalls = 0;
    (ripgrep as any).ripgrepSearch = async () => {
      ripgrepCalls++;
      return [];
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
      assert.equal(ripgrepCalls, 0, 'should not run ripgrep while logs are pending');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('setSearchQuery aborts previous search before running a new one', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => ([{ Id: '07L000000000001AA', LogLength: 10 }]);
    (http as any).fetchApexLogHead = async () => [];
    (http as any).fetchApexLogBody = async () => 'Body';

    const tmpDir = path.join(process.cwd(), 'tmp-apexlogs-tests-cancel');
    await fs.mkdir(tmpDir, { recursive: true });
    (workspace as any).ensureApexLogsDir = async () => tmpDir;
    (workspace as any).purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => true;
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

    const logPath = path.join(tmpDir, 'default_07L000000000001AA.log');
    await fs.writeFile(logPath, 'Example line', 'utf8');

    const ensureSignals: AbortSignal[] = [];
    (provider as any).logService.ensureLogsSaved = async (
      _logs: any,
      _org: any,
      signal?: AbortSignal,
      _options?: any
    ) => {
      if (signal) {
        ensureSignals.push(signal);
      }
      if (ensureSignals.length === 1 && signal) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
    };

    let ripgrepCalls = 0;
    (ripgrep as any).ripgrepSearch = async (
      _pattern: string,
      _cwd: string,
      signal?: AbortSignal
    ) => {
      ripgrepCalls++;
      if (signal?.aborted) {
        return [];
      }
      return [
        {
          filePath: logPath,
          lineText: 'Example line',
          submatches: []
        }
      ];
    };

    try {
      const firstSearch = (provider as any).setSearchQuery('first');
      await new Promise(r => setTimeout(r, 10));
      await (provider as any).setSearchQuery('second');
      await firstSearch;
      await new Promise(r => setTimeout(r, 10));

      assert.ok(ensureSignals[0]?.aborted, 'first search should be aborted');
      assert.equal(ensureSignals.length, 2, 'should issue ensureLogsSaved twice');
      assert.ok(ripgrepCalls >= 1, 'second search should invoke ripgrep');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadMore appends logs', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async (_auth: any, limit: number, offset: number) => {
      if (offset > 0) {
        return [{ Id: '2', LogLength: 20 }].slice(0, limit);
      }
      return [{ Id: '1', LogLength: 10 }].slice(0, limit);
    };
    (http as any).fetchApexLogHead = async () => ['|CODE_UNIT_STARTED|Foo|C.m'];
    (http as any).extractCodeUnitStartedFromLines = () => 'C.m';

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
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
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    (provider as any).lastSearchQuery = 'error';

    const callOrder: string[] = [];
    const fetchSignals: AbortSignal[] = [];
    (provider as any).logService.fetchLogs = async (
      _auth: any,
      _limit: number,
      _offset: number,
      signal?: AbortSignal
    ) => {
      callOrder.push('fetch');
      if (signal) {
        fetchSignals.push(signal);
      }
      return [
        { Id: '07L000000000001AA', StartTime: '2026-01-01T00:00:00.000Z', LogLength: 10 },
        { Id: '07L000000000002AA', StartTime: '2025-12-31T23:59:59.000Z', LogLength: 20 }
      ] as any;
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
    (vscode.window as any).showWarningMessage = async (...args: any[]) => {
      callOrder.push('confirm');
      warningCalls.push(args);
      return args[2];
    };
    const infoCalls: any[] = [];
    (vscode.window as any).showInformationMessage = async (...args: any[]) => {
      infoCalls.push(args);
      return undefined;
    };
    (vscode.window as any).showErrorMessage = async () => undefined;
    (vscode.window as any).withProgress = async (_opts: any, task: any) =>
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
    assert.equal(ensureCalls[0]?.count, 2, 'should include all logs fetched for the org');
    assert.ok(warningCalls.length >= 1, 'should request user confirmation');
    assert.ok(infoCalls.length >= 1, 'should show completion summary');
    assert.equal(callOrder[0], 'confirm', 'should confirm before listing org logs');
    assert.equal(typeof fetchSignals[0]?.aborted, 'boolean', 'should pass cancellation signal while listing logs');
    assert.ok(searchCalls.includes('error'), 'should re-run active search query after bulk download');
  });

  test('downloadAllLogs supports cancellation while listing org logs', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);

    const fetchSignals: AbortSignal[] = [];
    (provider as any).logService.fetchLogs = async (
      _auth: any,
      _limit: number,
      _offset: number,
      signal?: AbortSignal
    ) => {
      if (signal) {
        fetchSignals.push(signal);
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
    (vscode.window as any).showWarningMessage = async (...args: any[]) => {
      warningCalls.push(String(args[0]));
      if (typeof args[2] === 'string') {
        return args[2];
      }
      return undefined;
    };
    (vscode.window as any).showInformationMessage = async () => undefined;
    (vscode.window as any).showErrorMessage = async (message: string) => {
      errorCalls.push(message);
      return undefined;
    };
    (vscode.window as any).withProgress = async (_opts: any, task: any) => {
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
    assert.equal(fetchSignals.length >= 1, true, 'should pass signal to listing calls');
    assert.equal(fetchSignals[0]?.aborted, true, 'listing signal should be aborted after cancellation');
    assert.ok(
      warningCalls.some(msg => msg.includes('cancelled while listing logs')),
      'should show cancellation summary for listing stage'
    );
    assert.equal(errorCalls.length, 0, 'should not show hard error toast for listing abort');
  });

  test('openDebugFlags opens debug flags panel', async () => {
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
    const context = makeContext();
    const provider = new SfLogsViewProvider(context);
    const executed: string[] = [];
    (vscode.commands as any).executeCommand = async (command: string) => {
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
