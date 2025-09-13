import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';

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
  posts: any[] = [];
  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri;
  }
  postMessage(message: any): Thenable<boolean> {
    this.posts.push(message);
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
  show(_preserveFocus?: boolean | undefined): void {
    /* noop */
  }
  onDidChangeVisibility: vscode.Event<void> = () => new MockDisposable();
  onDidDispose: vscode.Event<void> = () => new MockDisposable();
}

suite('SfLogTailViewProvider tail messages', () => {
  const origOnDidChangeWindowState = vscode.window.onDidChangeWindowState;
  const origStateDescriptor = Object.getOwnPropertyDescriptor(vscode.window, 'state');
  setup(() => {
    Object.defineProperty(vscode.window, 'state', { value: { active: true }, configurable: true });
    (vscode.window as any).onDidChangeWindowState = () => new MockDisposable();
  });
  teardown(() => {
    if (origStateDescriptor) {
      Object.defineProperty(vscode.window, 'state', origStateDescriptor);
    }
    (vscode.window as any).onDidChangeWindowState = origOnDidChangeWindowState;
  });

  function makeProvider() {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[],
      globalState: {
        get: () => undefined,
        update: async () => {}
      }
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const started: (string | undefined)[] = [];
    let stopped = false;
    let cleared = false;
    (provider as any).tailService = {
      start: async (level?: string) => {
        started.push(level);
      },
      stop: () => {
        stopped = true;
      },
      clearLogPaths: () => {
        cleared = true;
      },
      setOrg: () => {},
      setWindowActive: () => {},
      isRunning: () => false,
      promptPoll: () => {},
    };
    const webview = new MockWebview();
    const view = new MockWebviewView(webview);
    provider.resolveWebviewView(view);
    return { webview, started, isStopped: () => stopped, isCleared: () => cleared };
  }

  test('tailStart starts tail service and toggles loading', async () => {
    const { webview, started } = makeProvider();
    await (webview as any).emit({ type: 'tailStart', debugLevel: 'FINE' });
    assert.deepStrictEqual(started, ['FINE']);
    const loading = (webview as MockWebview).posts.filter(p => p.type === 'loading').map(p => p.value);
    assert.deepStrictEqual(loading, [true, false]);
  });

  test('tailStop stops tail service', async () => {
    const { webview, isStopped } = makeProvider();
    await (webview as any).emit({ type: 'tailStop' });
    assert.equal(isStopped(), true);
  });

  test('tailClear clears paths and posts reset', async () => {
    const { webview, isCleared } = makeProvider();
    await (webview as any).emit({ type: 'tailClear' });
    assert.equal(isCleared(), true);
    assert.ok((webview as MockWebview).posts.find(p => p.type === 'tailReset'));
  });
});
