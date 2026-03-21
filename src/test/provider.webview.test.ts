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
  public readonly viewType = 'sfLogViewer.logsEditor';
  public title = 'Apex Logs';
  public iconPath?: vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } | undefined;
  public readonly options: vscode.WebviewPanelOptions = {};
  public readonly viewColumn = vscode.ViewColumn.Active;
  public readonly active = true;
  public readonly visible = true;
  public revealCalls = 0;
  public webview: vscode.Webview;

  constructor(webview: vscode.Webview) {
    this.webview = webview;
  }

  reveal(_viewColumn?: vscode.ViewColumn, _preserveFocus?: boolean): void {
    this.revealCalls += 1;
  }

  dispose(): void {
    /* noop */
  }

  onDidDispose(_listener: () => any, _thisArgs?: any, _disposables?: vscode.Disposable[]): vscode.Disposable {
    return new MockDisposable();
  }

  onDidChangeViewState(
    _listener: (e: vscode.WebviewPanelOnDidChangeViewStateEvent) => any,
    _thisArgs?: any,
    _disposables?: vscode.Disposable[]
  ): vscode.Disposable {
    return new MockDisposable();
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

  test('showEditor creates the logs editor webview and reuses it on subsequent calls', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const provider = new SfLogsViewProvider(context);
    const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
    const webview = new MockWebview();
    const panel = new MockWebviewPanel(webview);
    let createCalls = 0;

    (vscode.window as any).createWebviewPanel = () => {
      createCalls += 1;
      return panel;
    };

    try {
      await (provider as any).showEditor();
      await (provider as any).showEditor();
    } finally {
      (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
    }

    assert.equal(createCalls, 1, 'should create the logs editor panel only once');
    assert.equal(panel.revealCalls, 1, 'second call should reveal the existing logs editor');
    assert.equal(webview.options.enableScripts, true, 'editor webview should enable scripts');
    assert.ok(webview.html.includes('Content-Security-Policy'), 'editor webview should include CSP');
    assert.ok(webview.html.includes('media/main.js'), 'editor webview should load the logs bundle');
  });

  test('restoreEditorPanel rehydrates a deserialized logs editor and reuses it on later showEditor calls', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const provider = new SfLogsViewProvider(context);
    const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
    const restoredWebview = new MockWebview();
    const restoredPanel = new MockWebviewPanel(restoredWebview);
    let createCalls = 0;

    (vscode.window as any).createWebviewPanel = () => {
      createCalls += 1;
      return new MockWebviewPanel(new MockWebview());
    };

    try {
      await (provider as any).restoreEditorPanel(restoredPanel);
      await (provider as any).showEditor();
    } finally {
      (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
    }

    assert.equal(createCalls, 0, 'restored logs editor should be reused instead of creating a new panel');
    assert.equal(restoredPanel.revealCalls, 1, 'showEditor should reveal the restored panel');
    assert.equal(restoredWebview.options.enableScripts, true, 'restored editor webview should enable scripts');
    assert.ok(restoredWebview.html.includes('Content-Security-Policy'), 'restored editor should include CSP');
    assert.ok(restoredWebview.html.includes('media/main.js'), 'restored editor should load the logs bundle');
  });

  test('restoreEditorPanel restores the selected org from serializer state', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const provider = new SfLogsViewProvider(context);
    const restoredPanel = new MockWebviewPanel(new MockWebview());

    await (provider as any).restoreEditorPanel(restoredPanel, { selectedOrg: 'restored@example.com' });

    assert.equal(provider.getSelectedOrg(), 'restored@example.com');
  });

  test('showEditor seeds the webview bootstrap state with the selected org', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const provider = new SfLogsViewProvider(context);
    provider.setSelectedOrg('seeded@example.com');
    const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
    const webview = new MockWebview();
    const panel = new MockWebviewPanel(webview);

    (vscode.window as any).createWebviewPanel = () => panel;

    try {
      await (provider as any).showEditor();
    } finally {
      (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
    }

    assert.ok(webview.html.includes('data-initial-state='));
    assert.ok(webview.html.includes(encodeURIComponent(JSON.stringify({ selectedOrg: 'seeded@example.com' }))));
  });
});
