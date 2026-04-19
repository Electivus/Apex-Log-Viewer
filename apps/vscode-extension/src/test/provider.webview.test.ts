import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogsViewProvider, WEBVIEW_STABLE_VISIBILITY_DELAY_MS } from '../provider/SfLogsViewProvider';
import { TestClock } from './testClock';

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
  private visibilityListeners: Array<() => void> = [];
  private disposeListener: (() => void) | undefined;
  constructor(webview: vscode.Webview) {
    this.webview = webview;
  }
  show(_preserveFocus?: boolean | undefined): void {
    /* noop */
  }
  onDidChangeVisibility: vscode.Event<void> = listener => {
    this.visibilityListeners.push(listener);
    return new MockDisposable();
  };
  onDidDispose: vscode.Event<void> = listener => {
    this.disposeListener = listener;
    return new MockDisposable();
  };
  fireVisible(visible: boolean): void {
    this.visible = visible;
    for (const listener of this.visibilityListeners) {
      listener();
    }
  }
}

class MockWebviewPanel implements vscode.WebviewPanel {
  readonly active = true;
  visible = true;
  readonly options: vscode.WebviewPanelOptions = {};
  public title = 'Electivus Apex Logs';
  public viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active;
  public webview: vscode.Webview;
  private disposeListener: (() => void) | undefined;
  private viewStateListener: ((event: vscode.WebviewPanelOnDidChangeViewStateEvent) => void) | undefined;

  constructor(
    public viewType: string,
    webview: vscode.Webview
  ) {
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

  onDidChangeViewState(listener: (e: vscode.WebviewPanelOnDidChangeViewStateEvent) => any): vscode.Disposable {
    this.viewStateListener = listener;
    return new MockDisposable();
  }

  fireVisible(visible = true): void {
    this.visible = visible;
    this.viewStateListener?.({ webviewPanel: this } as vscode.WebviewPanelOnDidChangeViewStateEvent);
  }
}

suite('SfLogsViewProvider webview', () => {
  test('mounts the logs view after visibility stabilizes', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);

      await provider.resolveWebviewView(view);

      assert.equal(webview.options.enableScripts, true, 'enableScripts should be set');
      assert.ok(!webview.html.includes('Content-Security-Policy'), 'real html should not mount immediately');
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      assert.ok(webview.html.includes('Content-Security-Policy'), 'CSP meta should be present after delayed mount');
      assert.ok(webview.html.includes('media/main.js'), 'bundled webview script should be referenced');
    } finally {
      clock.dispose();
    }
  });

  test('refresh is a no-op if view not resolved', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogsViewProvider(context);
    await provider.refresh(); // should not throw or attempt CLI/network without a view
  });

  test('mounts editor html after visibility stabilizes', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const panel = new MockWebviewPanel('sfLogViewer.editorPanel', webview);

      provider.resolveWebviewPanel(panel);

      assert.equal(webview.options.enableScripts, true, 'enableScripts should be set for editor panel');
      assert.ok(
        !webview.html.includes('Content-Security-Policy'),
        'real html should not mount immediately for editor panel'
      );
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      assert.ok(webview.html.includes('Content-Security-Policy'), 'CSP meta should be present');
      assert.ok(webview.html.includes('media/main.js'), 'bundled webview script should be referenced');
    } finally {
      clock.dispose();
    }
  });

  test('editor panel ready message triggers org bootstrap and refresh flow', async () => {
    const clock = new TestClock();
    try {
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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['sendOrgs', 'refresh']);
    } finally {
      clock.dispose();
    }
  });

  test('replays cached logs on remount without forcing another refresh', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      const posted: any[] = [];
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };

      (provider as any).sendOrgs = async () => {
        posted.push({ type: 'sendOrgsCalled' });
        (provider as any).post({ type: 'orgs', data: [], selected: 'test@example.com' });
      };
      (provider as any).refresh = async () => {
        posted.push({ type: 'refreshCalled' });
        (provider as any).setCurrentLogs([{ Id: '07L000000000001', StartTime: '2024-01-01T00:00:00.000Z' }]);
        (provider as any).post({
          type: 'logs',
          data: [{ Id: '07L000000000001', StartTime: '2024-01-01T00:00:00.000Z' }],
          hasMore: false
        });
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();
      posted.length = 0;

      view.fireVisible(false);
      view.fireVisible(true);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.equal(
        posted.some(message => message?.type === 'refreshCalled'),
        false,
        'should not force remote refresh'
      );
      assert.ok(
        posted.some(message => message?.type === 'logs'),
        'should replay cached logs'
      );
    } finally {
      clock.dispose();
    }
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

  test('replays the latest selected org after an optimistic logs org switch', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      const posted: any[] = [];
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };

      (provider as any).sendOrgs = async () => {
        (provider as any).post({
          type: 'orgs',
          data: [],
          selected: 'first@example.com'
        });
      };
      (provider as any).refresh = async () => {};

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      provider.setSelectedOrg('second@example.com');
      posted.length = 0;

      view.fireVisible(false);
      view.fireVisible(true);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      const replayedOrgs = posted.find(message => message?.type === 'orgs');
      assert.equal(replayedOrgs?.selected, 'second@example.com');
    } finally {
      clock.dispose();
    }
  });

  test('skips bootstrap refresh when a refresh is already in flight', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const panel = new MockWebviewPanel('sfLogViewer.editorPanel', webview);
      const calls: string[] = [];

      (provider as any).post({ type: 'orgs', data: [], selected: 'test@example.com' });
      (provider as any).activeRefreshToken = 123;
      (provider as any).loadingState = true;
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, []);
    } finally {
      clock.dispose();
    }
  });
});
