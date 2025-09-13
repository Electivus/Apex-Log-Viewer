import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { TailService } from '../utils/tailService';
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
  posted: any[] = [];
  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri;
  }
  postMessage(message: any): Thenable<boolean> {
    this.posted.push(message);
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

suite('TailService', () => {
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
    (service as any).pollOnce = async () => {};
    await service.start('DEBUG');
    assert.equal((service as any).seenLogIds.size, 0);
    assert.equal((service as any).logIdToPath.size, 0);
    (cli as any).getOrgAuth = origGetAuth;
    (traceflags as any).ensureUserTraceFlag = origEnsure;
    (http as any).fetchApexLogs = origFetch;
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

  test('stop cleans streaming client, connection and log service', () => {
    const service = new TailService(() => {});
    let streamDisconnect = false;
    let connLogout = false;
    let connDispose = false;
    let logLogout = false;
    let logDispose = false;
    (service as any).streamingClient = {
      disconnect() {
        streamDisconnect = true;
      }
    };
    (service as any).connection = {
      logout() {
        connLogout = true;
      },
      dispose() {
        connDispose = true;
      }
    };
    (service as any).logService = {
      logout() {
        logLogout = true;
      },
      dispose() {
        logDispose = true;
      }
    };
    (service as any).currentAuth = { username: 'u' } as any;
    (service as any).lastReplayId = 1;
    service.stop();
    assert.equal(streamDisconnect, true);
    assert.equal(connLogout, true);
    assert.equal(connDispose, true);
    assert.equal(logLogout, true);
    assert.equal(logDispose, true);
    assert.equal((service as any).streamingClient, undefined);
    assert.equal((service as any).connection, undefined);
    assert.equal((service as any).logService, undefined);
    assert.equal((service as any).currentAuth, undefined);
    assert.equal((service as any).lastReplayId, undefined);
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

  test('posts tail buffer size using config manager', async () => {
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
    await webview.emit({ type: 'ready' });
    const size = (provider as any).configManager.getTailBufferSize();
    const msg = webview.posted.find((m: any) => m.type === 'tailConfig');
    assert.equal(msg?.tailBufferSize, size);
  });

  test('retries log ID after fetch failure', async () => {
    const service = new TailService(() => {});
    (service as any).tailRunning = true;
    (service as any).currentAuth = { username: 'u', instanceUrl: 'i', accessToken: 't' };
    const origFetch = http.fetchApexLogBody;
    let calls = 0;
    (http as any).fetchApexLogBody = async () => {
      calls++;
      if (calls === 1) {
        throw new Error('fail');
      }
      return 'body';
    };
    (service as any).emitLogWithHeader = async () => {};
    await (service as any).handleIncomingLogId('1');
    assert.equal(calls, 1);
    assert.equal((service as any).seenLogIds.has('1'), false);
    await (service as any).handleIncomingLogId('1');
    assert.equal(calls, 2);
    assert.equal((service as any).seenLogIds.has('1'), true);
    (http as any).fetchApexLogBody = origFetch;
  });
});
