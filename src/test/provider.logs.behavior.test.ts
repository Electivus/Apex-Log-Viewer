import assert from 'assert/strict';
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
  const origFetchLogs = http.fetchApexLogs;
  const origFetchHead = http.fetchApexLogHead;
  const origFetchBody = http.fetchApexLogBody;
  const origExtract = http.extractCodeUnitStartedFromLines;
  const origEnsureApexLogsDir = workspace.ensureApexLogsDir;
  const origRipgrepSearch = ripgrep.ripgrepSearch;
  const origOpenTextDocument = vscode.workspace.openTextDocument;
  const origShowTextDocument = vscode.window.showTextDocument;
  const origGetCommands = vscode.commands.getCommands;
  const origExecCommand = vscode.commands.executeCommand;

  teardown(() => {
    (cli as any).getOrgAuth = origGetOrgAuth;
    (http as any).fetchApexLogs = origFetchLogs;
    (http as any).fetchApexLogHead = origFetchHead;
    (http as any).fetchApexLogBody = origFetchBody;
    (http as any).extractCodeUnitStartedFromLines = origExtract;
    (workspace as any).ensureApexLogsDir = origEnsureApexLogsDir;
    (ripgrep as any).ripgrepSearch = origRipgrepSearch;
    (vscode.workspace as any).openTextDocument = origOpenTextDocument;
    (vscode.window as any).showTextDocument = origShowTextDocument;
    (vscode.commands as any).getCommands = origGetCommands;
    (vscode.commands as any).executeCommand = origExecCommand;
  });

  test('refresh posts logs and logHead with code unit', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => [{ Id: '1', LogLength: 10 }, { Id: '2', LogLength: 20 }];
    (http as any).fetchApexLogHead = async () => ['|CODE_UNIT_STARTED|Foo|MyClass.myMethod'];
    (http as any).extractCodeUnitStartedFromLines = () => 'MyClass.myMethod';

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

  test('searchQuery posts searchMatches when ripgrep finds logs', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => [{ Id: '07L000000000001AA', LogLength: 10 }];
    (http as any).fetchApexLogHead = async () => [];
    (http as any).fetchApexLogBody = async () => 'Body';
    (http as any).extractCodeUnitStartedFromLines = () => undefined;

    const tmpDir = path.join(process.cwd(), 'tmp-apexlogs-tests');
    await fs.mkdir(tmpDir, { recursive: true });
    (workspace as any).ensureApexLogsDir = async () => tmpDir;

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

    let saved = false;
    (provider as any).logService.ensureLogsSaved = async () => {
      saved = true;
      const file = path.join(tmpDir, 'default_07L000000000001AA.log');
      await fs.writeFile(file, 'error line', 'utf8');
    };
    (ripgrep as any).ripgrepSearch = async () => [path.join(tmpDir, 'default_07L000000000001AA.log')];

    try {
      await provider.refresh();
      await new Promise(r => setTimeout(r, 20));
      await (provider as any).setSearchQuery('error');
      await new Promise(r => setTimeout(r, 20));

      assert.ok(saved, 'ensureLogsSaved should be called');
      const matches = posted
        .filter(m => m?.type === 'searchMatches' && Array.isArray(m.logIds) && m.logIds.includes('07L000000000001AA'))
        .pop();
      assert.ok(matches, 'should post searchMatches');
      assert.deepEqual(matches?.logIds, ['07L000000000001AA']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadMore appends logs', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    let call = 0;
    (http as any).fetchApexLogs = async () => {
      call++;
      return call === 1 ? [{ Id: '1', LogLength: 10 }] : [{ Id: '2', LogLength: 20 }];
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
