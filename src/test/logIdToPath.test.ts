import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import * as salesforce from '../salesforce';

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

suite('SfLogTailViewProvider logIdToPath', () => {
  test('evicts oldest entries beyond limit', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);

    const originalGetOrgAuth = salesforce.getOrgAuth;
    const originalFetchApexLogBody = salesforce.fetchApexLogBody;
    const originalGetPath = (provider as any).getLogFilePathWithUsername;
    const originalWriteFile = fs.writeFile;
    (salesforce as any).getOrgAuth = async () => ({ username: 'u' }) as any;
    (salesforce as any).fetchApexLogBody = async () => 'body';
    (provider as any).getLogFilePathWithUsername = async (_u: string | undefined, id: string) => ({
      dir: '.',
      filePath: `${id}.log`
    });
    (fs as any).writeFile = async () => {};
    try {
      for (let i = 0; i < 110; i++) {
        await (provider as any).ensureLogSaved(String(i));
      }
      assert.equal((provider as any).logIdToPath.size, 100);
      assert.ok(!(provider as any).logIdToPath.has('0'));
      assert.ok((provider as any).logIdToPath.has('109'));
    } finally {
      (salesforce as any).getOrgAuth = originalGetOrgAuth;
      (salesforce as any).fetchApexLogBody = originalFetchApexLogBody;
      (provider as any).getLogFilePathWithUsername = originalGetPath;
      (fs as any).writeFile = originalWriteFile;
    }
  });

  test('clears map on stopTail', () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    (provider as any).logIdToPath.set('a', 'p');
    (provider as any).stopTail();
    assert.equal((provider as any).logIdToPath.size, 0);
  });

  test('clears map on tailClear message', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    (provider as any).logIdToPath.set('a', 'p');
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    await provider.resolveWebviewView(view);
    webview.emit({ type: 'tailClear' });
    assert.equal((provider as any).logIdToPath.size, 0);
  });
});
