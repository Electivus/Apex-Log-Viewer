import assert from 'assert/strict';
import { Buffer } from 'node:buffer';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import * as cli from '../salesforce/cli';
import * as http from '../salesforce/http';
import * as workspace from '../utils/workspace';
import * as ripgrep from '../utils/ripgrep';

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
  const origGetCommands = vscode.commands.getCommands;
  const origExecCommand = vscode.commands.executeCommand;

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
    (vscode.commands as any).getCommands = origGetCommands;
    (vscode.commands as any).executeCommand = origExecCommand;
  });

  test('refresh posts logs and logHead with code unit', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => ([
      { Id: '07L000000000001AA', LogLength: 10 },
      { Id: '07L000000000002AA', LogLength: 20 }
    ]);
    (http as any).fetchApexLogHead = async () => ['|CODE_UNIT_STARTED|Foo|MyClass.myMethod'];
    (http as any).extractCodeUnitStartedFromLines = () => 'MyClass.myMethod';
    (workspace as any).purgeSavedLogs = async () => 0;

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    (provider as any).configManager.shouldLoadFullLogBodies = () => false;
    // Inject minimal view so refresh proceeds
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    await provider.refresh();
    // Allow head limiter tasks to complete
    await new Promise(r => setTimeout(r, 20));

    const init = posted.find(m => m?.type === 'init');
    const logs = posted.find(m => m?.type === 'logs');
    const heads = posted.filter(m => m?.type === 'logHead');
    assert.ok(init, 'should post init');
    assert.ok(logs, 'should post logs');
    assert.equal((logs?.data || []).length, 2, 'should include two logs');
    assert.equal(heads.length, 2, 'should post head for each log');
    assert.equal(heads[0]?.codeUnitStarted, 'MyClass.myMethod');
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
    (ripgrep as any).ripgrepSearch = async () => [];

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
});
