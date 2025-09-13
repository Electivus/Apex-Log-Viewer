import * as vscode from 'vscode';
import { warmUpReplayDebugger } from '../utils/warmup';
import { logInfo, logWarn } from '../utils/logger';
import { getErrorMessage } from '../utils/error';

export abstract class BaseWebviewProvider implements vscode.WebviewViewProvider {
  protected view?: vscode.WebviewView;
  protected disposed = false;

  constructor(protected readonly context: vscode.ExtensionContext, private readonly name: string) {}

  protected abstract getHtmlForWebview(webview: vscode.Webview): string;

  protected onViewResolved(_webviewView: vscode.WebviewView): void | Thenable<void> {
    // optional hook
  }

  protected onViewDisposed(): string | void {
    // optional hook
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
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
    this.context.subscriptions.push(
      webviewView.onDidDispose(() => {
        this.disposed = true;
        this.view = undefined;
        const msg = this.onViewDisposed() ?? `${this.name} webview disposed.`;
        logInfo(msg);
      })
    );
    return this.onViewResolved(webviewView);
  }
}

