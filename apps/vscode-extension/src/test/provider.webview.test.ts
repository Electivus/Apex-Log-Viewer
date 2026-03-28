import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';

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
  // helper for tests (not part of interface)
  emit(message: any) {
    this.messageHandler?.(message);
  }
}

class MockWebviewView implements vscode.WebviewView {
  visible = true;
  title = 'Test';
  viewType = 'sfLogViewer';
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

class MockWebviewPanel implements vscode.WebviewPanel {
  readonly active = true;
  readonly visible = true;
  readonly options: vscode.WebviewPanelOptions = {};
  public title = 'Electivus Apex Logs';
  public viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active;
  public webview: vscode.Webview;
  private disposeListener: (() => void) | undefined;
  private viewStateListener:
    | ((event: vscode.WebviewPanelOnDidChangeViewStateEvent) => void)
    | undefined;

  constructor(public viewType: string, webview: vscode.Webview) {
    this.webview = webview;
  }

  reveal(_viewColumn?: vscode.ViewColumn, _preserveFocus?: boolean): void {
    /* noop */
  }

  dispose(): void {
    this.disposeListener?.();
  }

  onDidDispose(listener: () => void): vscode.Disposable {
    this.disposeListener = listener;
    return new MockDisposable();
  }

  onDidChangeViewState(
    listener: (e: vscode.WebviewPanelOnDidChangeViewStateEvent) => any
  ): vscode.Disposable {
    this.viewStateListener = listener;
    return new MockDisposable();
  }

  fireVisible(): void {
    this.viewStateListener?.({ webviewPanel: this } as vscode.WebviewPanelOnDidChangeViewStateEvent);
  }
}

suite('SfLogsViewProvider webview', () => {
  test('sets HTML with CSP and main.js on resolve', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const provider = new SfLogsViewProvider(context);
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);

    await provider.resolveWebviewView(view);

    assert.equal(webview.options.enableScripts, true, 'enableScripts should be set');
    assert.ok(webview.html.includes('Content-Security-Policy'), 'CSP meta should be present');
    assert.ok(webview.html.includes('media/main.js'), 'bundled webview script should be referenced');
  });

  test('refresh is a no-op if view not resolved', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogsViewProvider(context);
    await provider.refresh(); // should not throw or attempt CLI/network without a view
  });

  test('sets HTML with CSP and main.js when resolved as editor panel', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const provider = new SfLogsViewProvider(context);
    const webview = new MockWebview();
    const panel = new MockWebviewPanel('sfLogViewer.editorPanel', webview);

    provider.resolveWebviewPanel(panel);

    assert.equal(webview.options.enableScripts, true, 'enableScripts should be set for editor panel');
    assert.ok(webview.html.includes('Content-Security-Policy'), 'CSP meta should be present');
    assert.ok(webview.html.includes('media/main.js'), 'bundled webview script should be referenced');
  });

  test('editor panel ready message triggers org bootstrap and refresh flow', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const provider = new SfLogsViewProvider(context);
    const webview = new MockWebview();
    const panel = new MockWebviewPanel('sfLogViewer.editorPanel', webview);
    const calls: string[] = [];

    (provider as any).sendOrgs = async () => {
      calls.push('sendOrgs');
    };
    (provider as any).refresh = async () => {
      calls.push('refresh');
    };

    provider.resolveWebviewPanel(panel);
    webview.emit({ type: 'ready' });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(calls, ['sendOrgs', 'refresh']);
  });

  test('syncSelectedOrg refreshes an existing editor session when the org changes', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const provider = new SfLogsViewProvider(context);
    const webview = new MockWebview();
    const panel = new MockWebviewPanel('sfLogViewer.editorPanel', webview);
    const calls: string[] = [];

    provider.resolveWebviewPanel(panel);
    provider.setSelectedOrg('first@example.com');
    (provider as any).sendOrgs = async () => {
      calls.push('sendOrgs');
    };
    (provider as any).refresh = async () => {
      calls.push('refresh');
    };

    await provider.syncSelectedOrg('second@example.com');

    assert.equal(provider.getSelectedOrg(), 'second@example.com');
    assert.deepEqual(calls, ['sendOrgs', 'refresh']);
  });
});
