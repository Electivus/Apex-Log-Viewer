import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import type { ApexLogRow, OrgItem } from '../shared/types';

class MockDisposable implements vscode.Disposable {
  dispose(): void {
    /* noop */
  }
}

class MockWebview implements vscode.Webview {
  html = '';
  options: vscode.WebviewOptions = {};
  cspSource = 'vscode-resource://test';
  postedMessages: any[] = [];
  private messageHandler: ((e: any) => void) | undefined;
  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri;
  }
  postMessage(message: any): Thenable<boolean> {
    this.postedMessages.push(message);
    return Promise.resolve(true);
  }
  onDidReceiveMessage(listener: (e: any) => any): vscode.Disposable {
    this.messageHandler = listener;
    return new MockDisposable();
  }
  // helper for tests (not part of interface)
  emit(message: any) {
    return this.messageHandler?.(message);
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

class FakeLogService {
  setHeadConcurrency(_value: number): void {
    /* noop */
  }
}

class FakeOrgManager {
  public listCalls = 0;

  constructor(
    private selectedOrg: string | undefined,
    private readonly orgs: OrgItem[]
  ) {}

  getSelectedOrg(): string | undefined {
    return this.selectedOrg;
  }

  setSelectedOrg(org?: string): void {
    this.selectedOrg = org;
  }

  async list(): Promise<{ orgs: OrgItem[]; selected?: string }> {
    this.listCalls += 1;
    return { orgs: this.orgs, selected: this.selectedOrg };
  }

  async ensureProjectDefaultSelected(): Promise<void> {
    /* noop */
  }
}

class FakeConfigManager {
  getHeadConcurrency(): number {
    return 5;
  }

  shouldLoadFullLogBodies(): boolean {
    return false;
  }

  getPageLimit(): number {
    return 100;
  }

  handleChange(): void {
    /* noop */
  }
}

function createSampleLogs(): ApexLogRow[] {
  return [
    {
      Id: '07L000000000001AA',
      StartTime: '2025-09-21T18:40:00.000Z',
      Operation: 'ExecuteAnonymous',
      Application: 'Developer Console',
      DurationMilliseconds: 125,
      Status: 'Success',
      Request: 'XYZ',
      LogLength: 2048,
      LogUser: { Name: 'Alice' }
    },
    {
      Id: '07L000000000002AA',
      StartTime: '2025-09-21T18:45:00.000Z',
      Operation: 'Test.run',
      Application: 'VS Code',
      DurationMilliseconds: 220,
      Status: 'Success',
      Request: 'ABC',
      LogLength: 512,
      LogUser: { Name: 'Bob' }
    }
  ];
}

async function flushAsyncMessages(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
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

  test('selectOrg republishes org metadata so the sidebar and editor stay in sync', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const fakeOrgManager = new FakeOrgManager('logs@example.com', [
      { username: 'logs@example.com', alias: 'Logs' },
      { username: 'tail@example.com', alias: 'Tail' }
    ]);

    const provider = new SfLogsViewProvider(
      context,
      new FakeLogService() as any,
      fakeOrgManager as any,
      new FakeConfigManager() as any
    );
    const sidebarWebview = new MockWebview();
    const editorWebview = new MockWebview();
    const view = new MockWebviewView(sidebarWebview);
    const panel = new MockWebviewPanel(editorWebview);
    const refreshCalls: string[] = [];

    await provider.resolveWebviewView(view);
    await (provider as any).restoreEditorPanel(panel);
    (provider as any).availableOrgs = [
      { username: 'logs@example.com', alias: 'Logs' },
      { username: 'tail@example.com', alias: 'Tail' }
    ];
    (provider as any).refresh = async () => {
      refreshCalls.push(provider.getSelectedOrg() ?? '');
    };

    editorWebview.emit({ type: 'selectOrg', target: 'tail@example.com' });
    await flushAsyncMessages();

    assert.equal(fakeOrgManager.listCalls, 0, 'should reuse cached orgs instead of relisting');
    assert.deepEqual(refreshCalls, ['tail@example.com']);
    assert.equal(provider.getSelectedOrg(), 'tail@example.com');
    assert.deepEqual(
      sidebarWebview.postedMessages.filter(message => message.type === 'orgs').at(-1),
      {
        type: 'orgs',
        data: [
          { username: 'logs@example.com', alias: 'Logs' },
          { username: 'tail@example.com', alias: 'Tail' }
        ],
        selected: 'tail@example.com'
      }
    );
    assert.deepEqual(
      editorWebview.postedMessages.filter(message => message.type === 'orgs').at(-1),
      {
        type: 'orgs',
        data: [
          { username: 'logs@example.com', alias: 'Logs' },
          { username: 'tail@example.com', alias: 'Tail' }
        ],
        selected: 'tail@example.com'
      }
    );
  });

  test('ready reuses the current logs state instead of resetting pagination for another surface', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const fakeOrgManager = new FakeOrgManager('logs@example.com', [
      { username: 'logs@example.com', alias: 'Logs' },
      { username: 'tail@example.com', alias: 'Tail' }
    ]);

    const provider = new SfLogsViewProvider(
      context,
      new FakeLogService() as any,
      fakeOrgManager as any,
      new FakeConfigManager() as any
    );
    const sidebarWebview = new MockWebview();
    const editorWebview = new MockWebview();
    const view = new MockWebviewView(sidebarWebview);
    const panel = new MockWebviewPanel(editorWebview);
    const sampleLogs = createSampleLogs();

    await provider.resolveWebviewView(view);
    await (provider as any).restoreEditorPanel(panel);
    (provider as any).currentLogs = sampleLogs;
    (provider as any).currentLogIds = new Set(sampleLogs.map(log => log.Id));
    (provider as any).currentHasMore = true;
    (provider as any).hasHydratedLogsState = true;
    (provider as any).logHeadById.set('07L000000000001AA', { codeUnitStarted: 'AccountService.handle' });
    (provider as any).refresh = async () => {
      throw new Error('ready should not trigger a full refresh when logs are already hydrated');
    };

    editorWebview.emit({ type: 'ready' });
    await flushAsyncMessages();

    assert.equal(fakeOrgManager.listCalls, 1, 'should still send org choices to the new surface');
    assert.deepEqual(
      editorWebview.postedMessages.find(message => message.type === 'logs'),
      { type: 'logs', data: sampleLogs, hasMore: true }
    );
    assert.deepEqual(
      sidebarWebview.postedMessages.find(message => message.type === 'logs'),
      { type: 'logs', data: sampleLogs, hasMore: true }
    );
    assert.deepEqual(
      editorWebview.postedMessages.find(message => message.type === 'logHead'),
      {
        type: 'logHead',
        logId: '07L000000000001AA',
        codeUnitStarted: 'AccountService.handle'
      }
    );
  });
});
