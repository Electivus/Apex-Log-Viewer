import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { TailService } from '../utils/tailService';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import * as cli from '../salesforce/cli';
import * as http from '../salesforce/http';
import * as jsforce from '../salesforce/jsforce';
import * as streaming from '../salesforce/streaming';
import * as traceflags from '../salesforce/traceflags';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';

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

suite('TailService', () => {
  const originalDebugFlagsShow = DebugFlagsPanel.show;

  teardown(() => {
    (DebugFlagsPanel as any).show = originalDebugFlagsShow;
    streaming.__resetStreamingClientFactoryForTests();
    jsforce.__resetConnectionFactoryForTests();
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
    jsforce.__setConnectionFactoryForTests(async () => ({
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
    }) as any);
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
});
