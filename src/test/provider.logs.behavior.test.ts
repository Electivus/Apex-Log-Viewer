import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import * as cli from '../salesforce/cli';
import * as http from '../salesforce/http';

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

  test('refresh posts logBody when full search is enabled', async () => {
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (http as any).fetchApexLogs = async () => [{ Id: '1', LogLength: 10 }];
    (http as any).fetchApexLogHead = async () => [];
    (http as any).fetchApexLogBody = async () => 'First line\nERROR something happened';
    (http as any).extractCodeUnitStartedFromLines = () => undefined;

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

    const bodies = posted.filter(m => m?.type === 'logBody');
    assert.equal(bodies.length, 1, 'should post one logBody message');
    assert.equal(bodies[0]?.logId, '1');
    assert.ok((bodies[0]?.body || '').includes('ERROR something happened'));
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
