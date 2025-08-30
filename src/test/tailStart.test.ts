import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import * as cli from '../salesforce/cli';
import * as http from '../salesforce/http';
import * as traceflags from '../salesforce/traceflags';

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
  constructor(webview: vscode.Webview) {
    this.webview = webview;
  }
  show(): void {
    /* noop */
  }
  onDidChangeVisibility: vscode.Event<void> = () => new MockDisposable();
  onDidDispose: vscode.Event<void> = () => new MockDisposable();
}

suite('SfLogTailViewProvider startTail', () => {
  test('requires debug level', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const posted: any[] = [];
    (provider as any).post = (m: any) => posted.push(m);
    const original = cli.getOrgAuth;
    (cli as any).getOrgAuth = async () => {
      throw new Error('getOrgAuth should not be called');
    };
    await (provider as any).startTail(undefined);
    assert.equal(posted[0]?.type, 'error');
    (cli as any).getOrgAuth = original;
  });

  test('startTail clears stale caches', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    (provider as any).seenLogIds.add('old');
    (provider as any).logIdToPath.set('old', '/tmp/old');
    const origGetAuth = cli.getOrgAuth;
    const origEnsure = traceflags.ensureUserTraceFlag;
    const origFetch = http.fetchApexLogs;
    (cli as any).getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    (traceflags as any).ensureUserTraceFlag = async () => false;
    (http as any).fetchApexLogs = async () => [];
    (provider as any).pollOnce = async () => {};
    await (provider as any).startTail('DEBUG');
    assert.equal((provider as any).seenLogIds.size, 0);
    assert.equal((provider as any).logIdToPath.size, 0);
    (cli as any).getOrgAuth = origGetAuth;
    (traceflags as any).ensureUserTraceFlag = origEnsure;
    (http as any).fetchApexLogs = origFetch;
    (provider as any).stopTail();
  });

  test('stopTail clears caches', () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    (provider as any).seenLogIds.add('a');
    (provider as any).logIdToPath.set('a', 'b');
    (provider as any).stopTail();
    assert.equal((provider as any).seenLogIds.size, 0);
    assert.equal((provider as any).logIdToPath.size, 0);
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
    (provider as any).seenLogIds.add('x');
    (provider as any).logIdToPath.set('x', 'y');
    (provider as any).tailRunning = true;
    await webview.emit({ type: 'selectOrg', target: 'newOrg' });
    assert.equal((provider as any).seenLogIds.size, 0);
    assert.equal((provider as any).logIdToPath.size, 0);
    assert.equal((provider as any).tailRunning, false);
  });
});
