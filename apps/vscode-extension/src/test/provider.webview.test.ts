import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import { WEBVIEW_SESSION_MOUNT_DELAY_MS } from '../provider/webviewSession';
import { TestClock } from './testClock';

class MockDisposable implements vscode.Disposable {
  dispose(): void {
    /* noop */
  }
}

class MockWebview implements vscode.Webview {
  private _html = '';
  readonly htmlAssignments: string[] = [];
  options: vscode.WebviewOptions = {};
  cspSource = 'vscode-resource://test';
  private messageHandler: ((e: any) => void | Promise<void>) | undefined;
  get html(): string {
    return this._html;
  }
  set html(value: string) {
    this._html = value;
    this.htmlAssignments.push(value);
  }
  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri;
  }
  postMessage(_message: any): Thenable<boolean> {
    return Promise.resolve(true);
  }
  onDidReceiveMessage(listener: (e: any) => void | Promise<void>): vscode.Disposable {
    this.messageHandler = listener;
    return new MockDisposable();
  }
  // helper for tests (not part of interface)
  async emit(message: any): Promise<void> {
    await this.messageHandler?.(message);
  }
}

class MockWebviewView implements vscode.WebviewView {
  visible = true;
  title = 'Test';
  viewType = 'electivus.apexLogViewer.logsView';
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
  private viewStateListeners: Array<(event: vscode.WebviewPanelOnDidChangeViewStateEvent) => void> = [];

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
    this.viewStateListeners.push(listener);
    return new MockDisposable();
  }

  fireVisible(visible = true): void {
    this.visible = visible;
    for (const listener of this.viewStateListeners) {
      listener({ webviewPanel: this } as vscode.WebviewPanelOnDidChangeViewStateEvent);
    }
  }
}

function getMountSequence(webview: MockWebview): number {
  const match = webview.html.match(/<meta name="alv-mount-sequence" content="(\d+)">/);
  assert.ok(match, 'mounted webview html should expose its readiness generation');
  return Number(match[1]);
}

function postReplayable(provider: SfLogsViewProvider, message: any): void {
  (provider as any).post(message, 'replayable');
}

async function remountLogsSidebar(provider: SfLogsViewProvider, clock: TestClock, posted: any[]): Promise<MockWebview> {
  const webview = new MockWebview();
  webview.postMessage = (message: any) => {
    posted.push(message);
    return Promise.resolve(true);
  };
  const view = new MockWebviewView(webview);
  await provider.resolveWebviewView(view);
  await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
  await webview.emit({ type: 'ready', mountSequence: getMountSequence(webview) });
  await clock.flushMicrotasks();
  return webview;
}

suite('SfLogsViewProvider webview', () => {
  test('mounts Logs presentation with scripts, CSP, and the bundled webview entrypoint', async () => {
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
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
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

  test('mounts Logs editor presentation with scripts, CSP, and the bundled webview entrypoint', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const panel = new MockWebviewPanel('electivus.apexLogViewer.logsView.editorPanel', webview);

      provider.resolveWebviewPanel(panel);

      assert.equal(webview.options.enableScripts, true, 'enableScripts should be set for editor panel');
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
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
      const panel = new MockWebviewPanel('electivus.apexLogViewer.logsView.editorPanel', webview);
      const calls: string[] = [];

      (provider as any).sendOrgs = async () => {
        calls.push('sendOrgs');
      };
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['sendOrgs', 'refresh']);
    } finally {
      clock.dispose();
    }
  });

  test('routes each validated logs interaction once and rejects malformed input', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      const calls: string[] = [];
      (provider as any).sendOrgs = async () => undefined;
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready', mountSequence: getMountSequence(webview) });
      calls.length = 0;

      await webview.emit({ type: 'refresh' });
      await webview.emit({ type: 'selectOrg', target: 42 });

      assert.deepEqual(calls, ['refresh']);
    } finally {
      clock.dispose();
    }
  });

  test('keeps logs ready when a bootstrap workflow reports its own failure', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;
      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      let bootstrapAttempts = 0;
      (provider as any).sendOrgs = async () => {
        bootstrapAttempts += 1;
        throw new Error('logs-owned bootstrap failure');
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      const mountSequence = getMountSequence(webview);
      await webview.emit({ type: 'ready', mountSequence });

      assert.equal(provider.isReady(), true);
      assert.equal(bootstrapAttempts, 1);
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
        postReplayable(provider, { type: 'orgs', data: [], selected: 'test@example.com' });
      };
      (provider as any).refresh = async () => {
        posted.push({ type: 'refreshCalled' });
        (provider as any).setCurrentLogs([{ Id: '07L000000000001', StartTime: '2024-01-01T00:00:00.000Z' }]);
        postReplayable(provider, {
          type: 'logs',
          data: [{ Id: '07L000000000001', StartTime: '2024-01-01T00:00:00.000Z' }],
          hasMore: false
        });
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();
      posted.length = 0;

      await remountLogsSidebar(provider, clock, posted);

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

  test('forces a refresh when reopening after an offscreen refresh dirties the cached logs snapshot', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const cachedLogs = [{ Id: '07L000000000001AA', StartTime: '2026-04-19T00:00:00.000Z' }] as any[];

      postReplayable(provider, { type: 'orgs', data: [], selected: 'cached@example.com' });
      (provider as any).setCurrentLogs(cachedLogs);
      postReplayable(provider, { type: 'logs', data: cachedLogs, hasMore: false });

      await provider.refresh();

      const webview = new MockWebview();
      const panel = new MockWebviewPanel('electivus.apexLogViewer.logsView.editorPanel', webview);
      const posted: any[] = [];
      const calls: string[] = [];
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['refresh']);
      assert.equal(
        posted.some(message => message?.type === 'logs'),
        false,
        'dirty snapshots should not replay stale logs before refresh runs'
      );
    } finally {
      clock.dispose();
    }
  });

  test('forces a refresh when reopening after an offscreen org switch dirties cached logs', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const cachedLogs = [{ Id: '07L000000000002AA', StartTime: '2026-04-19T00:01:00.000Z' }] as any[];

      postReplayable(provider, { type: 'orgs', data: [], selected: 'cached@example.com' });
      (provider as any).setCurrentLogs(cachedLogs);
      postReplayable(provider, { type: 'logs', data: cachedLogs, hasMore: false });
      provider.setSelectedOrg('switched@example.com');

      const webview = new MockWebview();
      const panel = new MockWebviewPanel('electivus.apexLogViewer.logsView.editorPanel', webview);
      const posted: any[] = [];
      const calls: string[] = [];
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['refresh']);
      assert.equal(
        posted.some(message => message?.type === 'logs'),
        false,
        'org changes outside the view should invalidate stale log replay'
      );
    } finally {
      clock.dispose();
    }
  });

  test('forces a refresh when org bootstrap changes the selected org during remount', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      const calls: string[] = [];

      postReplayable(provider, {
        type: 'orgs',
        data: [{ username: 'first@example.com', alias: 'First', isDefaultUsername: true }],
        selected: 'first@example.com'
      });
      postReplayable(provider, {
        type: 'logs',
        data: [],
        hasMore: false
      });
      (provider as any).orgsBootstrapNeedsRefresh = true;
      (provider as any).sendOrgs = async () => {
        calls.push('sendOrgs');
        postReplayable(provider, {
          type: 'orgs',
          data: [{ username: 'second@example.com', alias: 'Second', isDefaultUsername: true }],
          selected: 'second@example.com'
        });
      };
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['sendOrgs', 'refresh']);
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
    const panel = new MockWebviewPanel('electivus.apexLogViewer.logsView.editorPanel', webview);
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
        postReplayable(provider, {
          type: 'orgs',
          data: [],
          selected: 'first@example.com'
        });
      };
      (provider as any).refresh = async () => {};

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      provider.setSelectedOrg('second@example.com');
      posted.length = 0;

      await remountLogsSidebar(provider, clock, posted);

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
      const panel = new MockWebviewPanel('electivus.apexLogViewer.logsView.editorPanel', webview);
      const calls: string[] = [];

      postReplayable(provider, { type: 'orgs', data: [], selected: 'test@example.com' });
      (provider as any).activeRefreshToken = 123;
      (provider as any).loadingState = true;
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, []);
    } finally {
      clock.dispose();
    }
  });

  test('replays the latest logs error across remounts until logs clear it', async () => {
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

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      postReplayable(provider, { type: 'error', message: 'load failed' });
      posted.length = 0;

      await remountLogsSidebar(provider, clock, posted);

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === 'load failed'),
        true
      );

      (provider as any).setCurrentLogs([]);
      postReplayable(provider, { type: 'logs', data: [], hasMore: false });
      posted.length = 0;

      await remountLogsSidebar(provider, clock, posted);

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message !== undefined),
        false,
        'the replacement may receive an explicit clear but must not replay the stale Logs error'
      );
    } finally {
      clock.dispose();
    }
  });

  test('preserves refresh errors when replaying cached logs across repeated remounts', async () => {
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

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      (provider as any).setCurrentLogs([]);
      postReplayable(provider, { type: 'logs', data: [], hasMore: false });
      postReplayable(provider, { type: 'error', message: 'refresh failed' });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        posted.length = 0;
        await remountLogsSidebar(provider, clock, posted);

        assert.equal(
          posted.some(message => message?.type === 'error' && message?.message === 'refresh failed'),
          true
        );
      }

      postReplayable(provider, { type: 'logs', data: [], hasMore: false });
      posted.length = 0;

      await remountLogsSidebar(provider, clock, posted);

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message !== undefined),
        false,
        'the replacement may receive an explicit clear but must not replay the stale refresh error'
      );
    } finally {
      clock.dispose();
    }
  });

  test('appendLogs clears stale loadMore errors and prevents them from replaying', async () => {
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

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      const logs = [{ Id: '07L000000000003AA', StartTime: '2026-04-19T00:02:00.000Z' }] as any[];
      (provider as any).setCurrentLogs(logs);
      postReplayable(provider, { type: 'logs', data: logs, hasMore: true });
      postReplayable(provider, { type: 'error', message: 'load more failed' });
      posted.length = 0;

      postReplayable(provider, {
        type: 'appendLogs',
        data: [{ Id: '07L000000000004AA', StartTime: '2026-04-19T00:03:00.000Z' }],
        hasMore: false
      });

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        true,
        'successful appendLogs should clear the webview error banner'
      );

      posted.length = 0;
      view.fireVisible(false);
      view.fireVisible(true);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready', mountSequence: getMountSequence(webview) });
      await clock.flushMicrotasks();

      assert.equal(
        posted.some(message => message?.type === 'error'),
        false,
        'cleared loadMore errors should not replay on remount'
      );
    } finally {
      clock.dispose();
    }
  });

  test('replays an explicit logs error clear after hidden recovery', async () => {
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
      let dropVisibleReplay = false;
      webview.postMessage = (message: any) => {
        if (!view.visible) {
          return Promise.resolve(false);
        }
        if (dropVisibleReplay) {
          return Promise.resolve(false);
        }
        posted.push(message);
        return Promise.resolve(true);
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready', mountSequence: getMountSequence(webview) });
      await clock.flushMicrotasks();

      postReplayable(provider, { type: 'error', message: 'load more failed' });
      posted.length = 0;

      view.fireVisible(false);
      postReplayable(provider, {
        type: 'appendLogs',
        data: [{ Id: '07L000000000005AA', StartTime: '2026-04-19T00:04:00.000Z' }],
        hasMore: false
      });
      await clock.flushMicrotasks();

      assert.equal(posted.length, 0, 'hidden clear is not delivered in this test harness');

      dropVisibleReplay = true;
      view.fireVisible(true);
      await clock.flushMicrotasks();

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        false,
        'dropped visible replay should not count as a delivered clear'
      );

      dropVisibleReplay = false;
      posted.length = 0;
      await clock.advanceBy(1000);

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        true,
        'visible retry should still include the stale retained logs error clear'
      );
    } finally {
      clock.dispose();
    }
  });

  test('retries org bootstrap after a failed org snapshot on remount', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const panel = new MockWebviewPanel('electivus.apexLogViewer.logsView.editorPanel', webview);
      const calls: string[] = [];

      postReplayable(provider, { type: 'orgs', data: [], selected: undefined });
      (provider as any).setCurrentLogs([]);
      postReplayable(provider, { type: 'logs', data: [], hasMore: false });
      (provider as any).orgsBootstrapNeedsRefresh = true;
      (provider as any).sendOrgs = async () => {
        calls.push('sendOrgs');
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['sendOrgs']);
    } finally {
      clock.dispose();
    }
  });
});
