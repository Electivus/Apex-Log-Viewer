import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { createWebviewPanelHost } from '../provider/webviewHost';
import {
  SfLogsViewProvider,
  WEBVIEW_READY_TIMEOUT_MS,
  WEBVIEW_STABLE_VISIBILITY_DELAY_MS
} from '../provider/SfLogsViewProvider';
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
  private messageHandler: ((e: any) => void) | undefined;
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

async function remountLogsSidebar(
  provider: SfLogsViewProvider,
  clock: TestClock,
  posted: any[]
): Promise<MockWebview> {
  const webview = new MockWebview();
  webview.postMessage = (message: any) => {
    posted.push(message);
    return Promise.resolve(true);
  };
  const view = new MockWebviewView(webview);
  await provider.resolveWebviewView(view);
  await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
  await webview.emit({ type: 'ready', mountSequence: (provider as any).mountSequence });
  await clock.flushMicrotasks();
  return webview;
}

suite('SfLogsViewProvider webview', () => {
  test('uses corporate-friendly webview bootstrap timing windows', () => {
    assert.ok(
      WEBVIEW_STABLE_VISIBILITY_DELAY_MS >= 1000,
      'visibility should be stable for at least 1s before mounting webview content'
    );
    assert.ok(
      WEBVIEW_READY_TIMEOUT_MS >= 30000,
      'webview ready watchdog should allow at least 30s for slow corporate machines'
    );
  });

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
      const panel = new MockWebviewPanel('electivus.apexLogViewer.logsView.editorPanel', webview);

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

  test('editor visibility callbacks fire only on actual visibility transitions', () => {
    const panel = new MockWebviewPanel('electivus.apexLogViewer.logsView.editorPanel', new MockWebview());
    const host = createWebviewPanelHost(panel);
    const transitions: boolean[] = [];
    let becameVisibleCount = 0;

    host.onDidChangeVisibility(visible => {
      transitions.push(visible);
    });
    host.onDidBecomeVisible(() => {
      becameVisibleCount += 1;
    });

    panel.fireVisible(true);
    panel.fireVisible(false);
    panel.fireVisible(false);
    panel.fireVisible(true);
    panel.fireVisible(true);

    assert.deepEqual(transitions, [false, true]);
    assert.equal(becameVisibleCount, 1);
  });

  test('retries timed-out sidebar mounts while the view stays visible', async () => {
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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      assert.ok(webview.html.includes('Content-Security-Policy'), 'initial mount should render real html');

      await clock.advanceBy(WEBVIEW_READY_TIMEOUT_MS);
      assert.ok(!webview.html.includes('Content-Security-Policy'), 'timeout should fall back to placeholder html');

      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      assert.ok(webview.html.includes('Content-Security-Policy'), 'visible sidebar should auto-remount after timeout');
    } finally {
      clock.dispose();
    }
  });

  test('accepts delayed logs ready messages from slow corporate webview startup', async () => {
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

      (provider as any).sendOrgs = async () => {
        calls.push('sendOrgs');
      };
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      const mountSequence = (provider as any).mountSequence;
      assert.ok(webview.html.includes('Content-Security-Policy'), 'initial mount should render real html');

      await clock.advanceBy(20_000);
      assert.ok(
        webview.html.includes('Content-Security-Policy'),
        'slow startup should not be replaced with placeholder before the ready timeout'
      );

      webview.emit({ type: 'ready', mountSequence });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['sendOrgs', 'refresh']);
      assert.equal(provider.isReady(), true, 'delayed ready should mark the provider ready');
    } finally {
      clock.dispose();
    }
  });

  test('keeps a ready retained sidebar webview mounted across hide and show', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);

      (provider as any).sendOrgs = async () => undefined;
      (provider as any).refresh = async () => undefined;

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      const mountedHtml = webview.html;
      const mountedAssignments = webview.htmlAssignments.length;
      const mountSequence = (provider as any).mountSequence;

      await webview.emit({ type: 'ready', mountSequence });
      await clock.flushMicrotasks();

      view.fireVisible(false);
      assert.equal(webview.html, mountedHtml, 'hiding a retained ready webview should not replace html');
      assert.equal(webview.htmlAssignments.length, mountedAssignments, 'hide should not write placeholder html');
      assert.equal(provider.isReady(), true, 'ready retained webview should stay ready while hidden');

      view.fireVisible(true);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);

      assert.equal(webview.html, mountedHtml, 'showing a retained ready webview should not remount html');
      assert.equal(webview.htmlAssignments.length, mountedAssignments, 'show should not write a new html document');
      assert.equal((provider as any).mountSequence, mountSequence, 'show should keep the same mount sequence');
    } finally {
      clock.dispose();
    }
  });

  test('requeues retained sidebar replay when visible postMessage is dropped', async () => {
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

      (provider as any).sendOrgs = async () => undefined;
      (provider as any).refresh = async () => undefined;

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      await webview.emit({ type: 'ready', mountSequence: (provider as any).mountSequence });
      await clock.flushMicrotasks();

      view.fireVisible(false);
      (provider as any).post({
        type: 'logs',
        data: [{ Id: '07Lxx0000000001', StartTime: '2026-04-29T16:00:00.000Z', Status: 'Success' }],
        hasMore: false
      });
      await clock.flushMicrotasks();

      assert.equal((provider as any).needsReplayOnVisible, true, 'hidden update should request replay on show');

      posted.length = 0;
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(false);
      };
      view.fireVisible(true);
      await clock.flushMicrotasks();

      assert.ok(posted.some(message => message?.type === 'init'), 'visible transition should attempt init replay');
      assert.equal(
        (provider as any).needsReplayOnVisible,
        true,
        'dropped visible replay should stay requested until a retry delivers it'
      );

      posted.length = 0;
      webview.postMessage = (message: any) => {
        posted.push(message);
        return Promise.resolve(true);
      };
      await clock.advanceBy(1000);

      assert.equal((provider as any).needsReplayOnVisible, false, 'successful retry should clear replay request');
      assert.ok(posted.some(message => message?.type === 'init'), 'visible retry should resend init');
      assert.ok(posted.some(message => message?.type === 'logs'), 'visible retry should resend logs');
    } finally {
      clock.dispose();
    }
  });

  test('keeps an initializing retained sidebar webview mounted while hidden', async () => {
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

      (provider as any).sendOrgs = async () => {
        calls.push('sendOrgs');
      };
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      const mountedHtml = webview.html;
      const mountedAssignments = webview.htmlAssignments.length;
      const mountSequence = (provider as any).mountSequence;

      view.fireVisible(false);
      await clock.advanceBy(WEBVIEW_READY_TIMEOUT_MS + WEBVIEW_STABLE_VISIBILITY_DELAY_MS);

      assert.equal(webview.html, mountedHtml, 'hidden initializing retained webview should not fall back to placeholder');
      assert.equal(webview.htmlAssignments.length, mountedAssignments, 'hidden initializing webview should not remount');

      view.fireVisible(true);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);

      assert.equal(webview.html, mountedHtml, 'visible restore should reuse the initializing document');
      assert.equal((provider as any).mountSequence, mountSequence, 'visible restore should not allocate a new mount');

      await webview.emit({ type: 'ready', mountSequence });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['sendOrgs', 'refresh']);
      assert.equal(provider.isReady(), true);
    } finally {
      clock.dispose();
    }
  });

  test('ignores stale ready events from a previous logs mount after timeout remounts', async () => {
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

      (provider as any).sendOrgs = async () => {
        calls.push('sendOrgs');
      };
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      await clock.advanceBy(WEBVIEW_READY_TIMEOUT_MS);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);

      await webview.emit({ type: 'ready', mountSequence: 1 });
      await clock.flushMicrotasks();
      assert.deepEqual(calls, [], 'stale ready should not bootstrap the remounted logs view');

      await webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();
      assert.deepEqual(calls, [], 'unsequenced stale ready should not bootstrap the remounted logs view');

      await webview.emit({ type: 'ready', mountSequence: 2 });
      await clock.flushMicrotasks();
      assert.deepEqual(calls, ['sendOrgs', 'refresh']);
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

      (provider as any).post({ type: 'orgs', data: [], selected: 'cached@example.com' });
      (provider as any).setCurrentLogs(cachedLogs);
      (provider as any).post({ type: 'logs', data: cachedLogs, hasMore: false });

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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
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

      (provider as any).post({ type: 'orgs', data: [], selected: 'cached@example.com' });
      (provider as any).setCurrentLogs(cachedLogs);
      (provider as any).post({ type: 'logs', data: cachedLogs, hasMore: false });
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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
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

      (provider as any).post({
        type: 'orgs',
        data: [{ username: 'first@example.com', alias: 'First', isDefaultUsername: true }],
        selected: 'first@example.com'
      });
      (provider as any).post({
        type: 'logs',
        data: [],
        hasMore: false
      });
      (provider as any).orgsBootstrapNeedsRefresh = true;
      (provider as any).sendOrgs = async () => {
        calls.push('sendOrgs');
        (provider as any).post({
          type: 'orgs',
          data: [{ username: 'second@example.com', alias: 'Second', isDefaultUsername: true }],
          selected: 'second@example.com'
        });
      };
      (provider as any).refresh = async () => {
        calls.push('refresh');
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      (provider as any).post({ type: 'error', message: 'load failed' });
      posted.length = 0;

      await remountLogsSidebar(provider, clock, posted);

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === 'load failed'),
        true
      );

      (provider as any).setCurrentLogs([]);
      (provider as any).post({ type: 'logs', data: [], hasMore: false });
      posted.length = 0;

      await remountLogsSidebar(provider, clock, posted);

      assert.equal(
        posted.some(message => message?.type === 'error'),
        false
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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      (provider as any).setCurrentLogs([]);
      (provider as any).post({ type: 'logs', data: [], hasMore: false });
      (provider as any).post({ type: 'error', message: 'refresh failed' });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        posted.length = 0;
        await remountLogsSidebar(provider, clock, posted);

        assert.equal(
          posted.some(message => message?.type === 'error' && message?.message === 'refresh failed'),
          true
        );
      }

      (provider as any).post({ type: 'logs', data: [], hasMore: false });
      posted.length = 0;

      await remountLogsSidebar(provider, clock, posted);

      assert.equal(
        posted.some(message => message?.type === 'error'),
        false
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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      const logs = [{ Id: '07L000000000003AA', StartTime: '2026-04-19T00:02:00.000Z' }] as any[];
      (provider as any).setCurrentLogs(logs);
      (provider as any).post({ type: 'logs', data: logs, hasMore: true });
      (provider as any).post({ type: 'error', message: 'load more failed' });
      posted.length = 0;

      (provider as any).post({
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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready', mountSequence: (provider as any).mountSequence });
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
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready', mountSequence: (provider as any).mountSequence });
      await clock.flushMicrotasks();

      (provider as any).post({ type: 'error', message: 'load more failed' });
      posted.length = 0;

      view.fireVisible(false);
      (provider as any).post({
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

  test('retries a dropped visible logs error clear', async () => {
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
      let dropVisibleClear = false;
      webview.postMessage = (message: any) => {
        if (dropVisibleClear && message?.type === 'error' && message?.message === undefined) {
          return Promise.resolve(false);
        }
        posted.push(message);
        return Promise.resolve(true);
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready', mountSequence: (provider as any).mountSequence });
      await clock.flushMicrotasks();

      (provider as any).post({ type: 'error', message: 'load more failed' });
      posted.length = 0;

      dropVisibleClear = true;
      (provider as any).post({
        type: 'appendLogs',
        data: [{ Id: '07L000000000006AA', StartTime: '2026-04-19T00:05:00.000Z' }],
        hasMore: false
      });
      await clock.flushMicrotasks();

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        false,
        'dropped visible clear should not be treated as delivered'
      );

      dropVisibleClear = false;
      posted.length = 0;
      await clock.advanceBy(1000);

      assert.equal(
        posted.some(message => message?.type === 'error' && message?.message === undefined),
        true,
        'visible retry should resend a dropped logs error clear'
      );
    } finally {
      clock.dispose();
    }
  });

  test('retries retained replay after a dropped visible appendLogs update', async () => {
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
      let dropNextAppendLogs = false;
      webview.postMessage = (message: any) => {
        if (dropNextAppendLogs && message?.type === 'appendLogs') {
          dropNextAppendLogs = false;
          return Promise.resolve(false);
        }
        posted.push(message);
        return Promise.resolve(true);
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready', mountSequence: (provider as any).mountSequence });
      await clock.flushMicrotasks();

      const logs = [{ Id: '07L000000000007AA', StartTime: '2026-04-19T00:06:00.000Z' }] as any[];
      posted.length = 0;
      dropNextAppendLogs = true;
      (provider as any).post({ type: 'appendLogs', data: logs, hasMore: false });
      (provider as any).setCurrentLogs(logs);
      await clock.flushMicrotasks();

      assert.equal(
        (provider as any).needsReplayOnVisible,
        true,
        'dropped visible appendLogs should request a retained replay'
      );

      posted.length = 0;
      await clock.advanceBy(1000);

      assert.equal((provider as any).needsReplayOnVisible, false, 'successful logs retry should clear replay request');
      assert.ok(posted.some(message => message?.type === 'init'), 'visible retry should resend logs init');
      assert.ok(
        posted.some(message => message?.type === 'logs' && message?.data?.[0]?.Id === logs[0].Id),
        'visible retry should replay the latest retained logs snapshot'
      );
    } finally {
      clock.dispose();
    }
  });

  test('resets visible replay retry budget after a successful logs retry', async () => {
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
      let dropNextAppendLogs = false;
      webview.postMessage = (message: any) => {
        if (dropNextAppendLogs && message?.type === 'appendLogs') {
          dropNextAppendLogs = false;
          return Promise.resolve(false);
        }
        posted.push(message);
        return Promise.resolve(true);
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready', mountSequence: (provider as any).mountSequence });
      await clock.flushMicrotasks();

      const logs = [{ Id: '07L000000000008AA', StartTime: '2026-04-19T00:07:00.000Z' }] as any[];
      dropNextAppendLogs = true;
      (provider as any).post({ type: 'appendLogs', data: logs, hasMore: false });
      (provider as any).setCurrentLogs(logs);
      await clock.flushMicrotasks();

      assert.equal((provider as any).visibleReplayRetryAttempts, 1, 'dropped logs update should consume retry budget');

      posted.length = 0;
      await clock.advanceBy(1000);

      assert.equal(
        (provider as any).visibleReplayRetryAttempts,
        0,
        'successful logs replay retry should reset the retry budget'
      );
    } finally {
      clock.dispose();
    }
  });

  test('stops retrying visible logs replay after the retry budget is exhausted', async () => {
    const clock = new TestClock();
    try {
      const context = {
        extensionUri: vscode.Uri.file(path.resolve('.')),
        subscriptions: [] as vscode.Disposable[]
      } as unknown as vscode.ExtensionContext;

      const provider = new SfLogsViewProvider(context);
      const webview = new MockWebview();
      const view = new MockWebviewView(webview);
      let dropAppendThenAllReplay = false;
      let dropAllReplay = false;
      webview.postMessage = (message: any) => {
        if (dropAppendThenAllReplay && message?.type === 'appendLogs') {
          dropAppendThenAllReplay = false;
          dropAllReplay = true;
          return Promise.resolve(false);
        }
        if (dropAllReplay) {
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      };

      await provider.resolveWebviewView(view);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready', mountSequence: (provider as any).mountSequence });
      await clock.flushMicrotasks();

      const logs = [{ Id: '07L000000000009AA', StartTime: '2026-04-19T00:08:00.000Z' }] as any[];
      dropAppendThenAllReplay = true;
      (provider as any).post({ type: 'appendLogs', data: logs, hasMore: false });
      (provider as any).setCurrentLogs(logs);
      await clock.flushMicrotasks();

      await clock.advanceBy(1000);

      assert.equal(
        (provider as any).visibleReplayRetryAttempts,
        3,
        'failed logs replay retries should consume the configured retry budget'
      );
      assert.equal(
        (provider as any).visibleReplayRetryTimer,
        undefined,
        'logs replay should stop scheduling immediate retries after the budget is exhausted'
      );
      assert.equal(
        (provider as any).needsReplayOnVisible,
        true,
        'logs replay should remain pending for a future hide/show after immediate retries are exhausted'
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

      (provider as any).post({ type: 'orgs', data: [], selected: undefined });
      (provider as any).setCurrentLogs([]);
      (provider as any).post({ type: 'logs', data: [], hasMore: false });
      (provider as any).orgsBootstrapNeedsRefresh = true;
      (provider as any).sendOrgs = async () => {
        calls.push('sendOrgs');
      };

      provider.resolveWebviewPanel(panel);
      await clock.advanceBy(WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
      webview.emit({ type: 'ready' });
      await clock.flushMicrotasks();

      assert.deepEqual(calls, ['sendOrgs']);
    } finally {
      clock.dispose();
    }
  });
});
