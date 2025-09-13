import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../shared/messages';
import { warmUpReplayDebugger } from '../utils/warmup';
import { logInfo, logWarn } from '../utils/logger';
import { getErrorMessage } from '../utils/error';

/**
 * Shared base class for WebviewView providers with common warm-up and
 * disposal behavior.
 */
export abstract class BaseWebviewViewProvider implements vscode.WebviewViewProvider {
  protected view?: vscode.WebviewView;
  protected disposed = false;

  protected constructor(protected readonly context: vscode.ExtensionContext, private readonly name: string) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.disposed = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    logInfo(`${this.name} webview resolved.`);

    try {
      setTimeout(() => void warmUpReplayDebugger(), 0);
    } catch (e) {
      logWarn(`${this.name}: warm-up of Apex Replay Debugger failed ->`, getErrorMessage(e));
    }

    this.subscribe(
      webviewView.onDidDispose(() => {
        this.disposed = true;
        this.view = undefined;
        this.onDisposed();
        logInfo(`${this.name} webview disposed.`);
      })
    );

    this.onResolve(webviewView);
  }

  protected abstract getHtmlForWebview(webview: vscode.Webview): string;

  /** Hooks for subclasses to wire up additional behavior once the view is resolved. */
  protected onResolve(_webviewView: vscode.WebviewView): void {}

  /** Called when the view is disposed. */
  protected onDisposed(): void {}

  protected post(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  protected subscribe(disposable: vscode.Disposable): void {
    this.context.subscriptions.push(disposable);
  }
}

