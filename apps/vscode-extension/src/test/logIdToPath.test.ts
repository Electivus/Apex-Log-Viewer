import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { TailService } from '../utils/tailService';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import * as cli from '../salesforce/cli';
import * as http from '../salesforce/http';

class MockDisposable implements vscode.Disposable {
  dispose(): void {
    /* noop */
  }
}

class MockWebview implements vscode.Webview {
  html = '';
  options: vscode.WebviewOptions = {};
  cspSource = 'vscode-resource://test';
  private messageHandler: ((e: any) => void) | undefined;
  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri;
  }
  postMessage(_message: any): Thenable<boolean> {
    return Promise.resolve(true);
  }
  onDidReceiveMessage(listener: (e: any) => any): vscode.Disposable {
    this.messageHandler = listener;
    return new MockDisposable();
  }
  emit(message: any) {
    this.messageHandler?.(message);
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
  show(_preserveFocus?: boolean | undefined): void {
    /* noop */
  }
  onDidChangeVisibility: vscode.Event<void> = () => new MockDisposable();
  onDidDispose: vscode.Event<void> = () => new MockDisposable();
}

suite('TailService logIdToPath', () => {
  test('evicts oldest entries beyond limit', async () => {
    const service = new TailService(() => {});

    const originalGetOrgAuth = cli.getOrgAuth;
    const originalFetchApexLogBody = http.fetchApexLogBody;
    const originalGetPath = (service as any).getLogFilePathWithUsername;
    const originalWriteFile = fs.writeFile;
    (cli as any).getOrgAuth = async () => ({ username: 'u' }) as any;
    (http as any).fetchApexLogBody = async () => 'body';
    (service as any).getLogFilePathWithUsername = async (_u: string | undefined, id: string) => ({
      dir: '.',
      filePath: `${id}.log`
    });
    (fs as any).writeFile = async () => {};
    try {
      for (let i = 0; i < 110; i++) {
        await service.ensureLogSaved(String(i));
      }
      assert.equal((service as any).logIdToPath.size, 100);
      assert.ok(!(service as any).logIdToPath.has('0'));
      assert.ok((service as any).logIdToPath.has('109'));
    } finally {
      (cli as any).getOrgAuth = originalGetOrgAuth;
      (http as any).fetchApexLogBody = originalFetchApexLogBody;
      (service as any).getLogFilePathWithUsername = originalGetPath;
      (fs as any).writeFile = originalWriteFile;
    }
  });

  test('clears map on stop', () => {
    const service = new TailService(() => {});
    (service as any).logIdToPath.set('a', 'p');
    service.stop();
    assert.equal((service as any).logIdToPath.size, 0);
  });

  test('clears map on tailClear message', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    await provider.resolveWebviewView(view);
    const service = (provider as any).tailService;
    (service as any).logIdToPath.set('a', 'p');
    webview.emit({ type: 'tailClear' });
    assert.equal((service as any).logIdToPath.size, 0);
  });
});
