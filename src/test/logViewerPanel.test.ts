import assert from 'assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import proxyquire from 'proxyquire';
import * as vscode from 'vscode';
import type { LogViewerToWebviewMessage } from '../shared/logViewerMessages';

type InitMessage = Extract<LogViewerToWebviewMessage, { type: 'logViewerInit' }>;
type TriageUpdateMessage = Extract<LogViewerToWebviewMessage, { type: 'logViewerTriageUpdate' }>;

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

class MockDisposable implements vscode.Disposable {
  dispose(): void {
    /* noop */
  }
}

class MockWebview implements vscode.Webview {
  html = '';
  options: vscode.WebviewOptions = {};
  cspSource = 'vscode-resource://test';
  private messageListener: ((message: any) => void) | undefined;
  postedMessages: LogViewerToWebviewMessage[] = [];

  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri;
  }

  postMessage(message: unknown): Thenable<boolean> {
    this.postedMessages.push(message as LogViewerToWebviewMessage);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(listener: (e: any) => any): vscode.Disposable {
    this.messageListener = listener;
    return new MockDisposable();
  }

  emitMessage(message: unknown): void {
    this.messageListener?.(message);
  }
}

class MockWebviewPanel implements vscode.WebviewPanel {
  readonly active = true;
  readonly visible = true;
  readonly options: vscode.WebviewPanelOptions = {};
  public viewType: string;
  public title = 'Apex Log Viewer';
  public viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active;
  public webview: MockWebview;
  private onDispose: (() => void) | undefined;
  private onChangeViewState:
    | ((e: vscode.WebviewPanelOnDidChangeViewStateEvent) => void)
    | undefined;

  constructor(viewType: string, webview: MockWebview) {
    this.viewType = viewType;
    this.webview = webview;
  }

  onDidDispose(_listener: () => void, _thisArg?: unknown, _disposables?: unknown): vscode.Disposable {
    this.onDispose = _listener;
    return new MockDisposable();
  }

  onDidChangeViewState(
    listener: (e: vscode.WebviewPanelOnDidChangeViewStateEvent) => void,
    _thisArg?: unknown,
    _disposables?: unknown
  ): vscode.Disposable {
    this.onChangeViewState = listener;
    return new MockDisposable();
  }

  reveal(_viewColumn?: vscode.ViewColumn, _preserveFocus?: boolean): void {
    this.onChangeViewState?.({ webviewPanel: this });
  }

  dispose(): void {
    this.onDispose?.();
  }
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createPanelHarness(stubs: { summarizeLogFile: () => Promise<unknown> }) {
  const webview = new MockWebview();
  const panel = new MockWebviewPanel('sfLogViewer.logPanel', webview);
  const ExtensionContext = {
    extensionUri: vscode.Uri.file(process.cwd()),
    subscriptions: [] as vscode.Disposable[]
  } as vscode.ExtensionContext;

  const vscodeMock = {
    ...vscode,
    Uri: vscode.Uri,
    window: {
      activeTextEditor: undefined,
      createWebviewPanel: () => panel
    },
    workspace: {
      openTextDocument: async () => ({})
    },
    env: {
      language: 'en-US'
    }
  };

  const { LogViewerPanel } = proxyquireStrict('../panel/LogViewerPanel', {
    vscode: vscodeMock,
    '../services/logTriage': {
      summarizeLogFile: stubs.summarizeLogFile
    },
    '../utils/webviewHtml': { buildWebviewHtml: () => '<html />' },
    '../utils/logger': {
      logInfo: () => undefined,
      logWarn: () => undefined,
      logError: () => undefined,
      showOutput: () => undefined,
      setTraceEnabled: () => undefined,
      disposeLogger: () => undefined
    }
  });
  (LogViewerPanel as any).initialize(ExtensionContext);

  return { LogViewerPanel, panel, webview, context: ExtensionContext };
}

async function createLogFile(): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'logViewerPanel-'));
  const filePath = path.join(dir, 'sample.log');
  await fs.writeFile(filePath, 'INFO start');
  return {
    filePath,
    cleanup: () => fs.rm(dir, { recursive: true, force: true })
  };
}

suite('LogViewerPanel', () => {
  test('posts logViewerInit immediately after logViewerReady with no triage payload', async () => {
    const summary = createDeferred<unknown>();
    const { LogViewerPanel, webview } = createPanelHarness({
      summarizeLogFile: () => summary.promise
    });
    const { filePath, cleanup } = await createLogFile();

    try {
      await LogViewerPanel.show({ logId: 'LOG-001', filePath });
      webview.emitMessage({ type: 'logViewerReady' });

      assert.equal(webview.postedMessages.length, 1, 'expected exactly one message from initial init');
      const initMessage = webview.postedMessages[0] as InitMessage;
      assert.equal(initMessage.type, 'logViewerInit');
      assert.equal(initMessage.logId, 'LOG-001');
      assert.equal(initMessage.fileName, 'sample.log');
      assert.equal(initMessage.locale, 'en-US');
      assert.ok(!('triage' in initMessage), 'triage should remain optional on logViewerInit');
    } finally {
      await cleanup();
    }
  });

  test('posts logViewerTriageUpdate after async summarizeLogFile resolves', async () => {
    const summary = createDeferred<unknown>();
    const { LogViewerPanel, webview } = createPanelHarness({
      summarizeLogFile: () => summary.promise
    });
    const { filePath, cleanup } = await createLogFile();

    try {
      await LogViewerPanel.show({ logId: 'LOG-002', filePath });
      webview.emitMessage({ type: 'logViewerReady' });

      summary.resolve({
        hasErrors: true,
        primaryReason: 'Fatal exception',
        reasons: [
          {
            code: 'fatal_exception',
            severity: 'error',
            summary: 'Fatal exception',
            line: 2,
            eventType: 'EXCEPTION_THROWN'
          },
          {
            code: 'invalid_code',
            severity: 'other',
            summary: 'Invalid entry should be removed by normalization',
            line: 3
          } as unknown
        ]
      } as unknown);

      await new Promise(resolve => setTimeout(resolve, 0));

      const updateMessage = webview.postedMessages.find(
        (msg): msg is TriageUpdateMessage => msg.type === 'logViewerTriageUpdate'
      );
      assert.ok(updateMessage);
      assert.equal(updateMessage.logId, 'LOG-002');
      assert.equal(updateMessage.triage?.hasErrors, true);
      assert.equal(updateMessage.triage?.primaryReason, 'Fatal exception');
      assert.equal(updateMessage.triage?.reasons.length, 1, 'invalid reasons should be normalized away');
    } finally {
      await cleanup();
    }
  });

  test('still posts initial init payload when triage is unavailable or slow', async () => {
    const { LogViewerPanel, webview } = createPanelHarness({
      summarizeLogFile: () => Promise.reject(new Error('triage unavailable'))
    });
    const { filePath, cleanup } = await createLogFile();

    try {
      await LogViewerPanel.show({ logId: 'LOG-003', filePath });
      webview.emitMessage({ type: 'logViewerReady' });

      assert.equal(webview.postedMessages.length >= 1, true);
      const initMessage = webview.postedMessages[0] as InitMessage;
      assert.equal(initMessage.type, 'logViewerInit');
      assert.equal(initMessage.logId, 'LOG-003');
      assert.ok(!('triage' in initMessage), 'triage should be optional until async resolution');

      await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(!webview.postedMessages.some(msg => msg.type === 'logViewerTriageUpdate'), 'triage updates should not block initial payload');
    } finally {
      await cleanup();
    }
  });
});
