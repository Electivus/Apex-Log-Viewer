import * as vscode from 'vscode';

export interface BoundWebviewHost {
  readonly webview: vscode.Webview;
  readonly visible: boolean;
  recoverAfterReadyTimeout(remount: () => void): void | Promise<void>;
  onDidDispose(listener: () => void): vscode.Disposable;
  onDidChangeVisibility(listener: (visible: boolean) => void): vscode.Disposable;
}

export function createWebviewViewHost(
  view: vscode.WebviewView,
  prepareForRemount: () => void = () => undefined
): BoundWebviewHost {
  return {
    get webview() {
      return view.webview;
    },
    get visible() {
      return view.visible;
    },
    recoverAfterReadyTimeout(remount): void {
      prepareForRemount();
      remount();
    },
    onDidDispose(listener: () => void): vscode.Disposable {
      return view.onDidDispose(listener);
    },
    onDidChangeVisibility(listener: (visible: boolean) => void): vscode.Disposable {
      return view.onDidChangeVisibility(() => {
        listener(view.visible);
      });
    }
  };
}

export function createWebviewPanelHost(
  panel: vscode.WebviewPanel,
  replaceAfterReadyTimeout: () => void | Promise<void> = () => undefined
): BoundWebviewHost {
  const onVisibilityTransition = (listener: (visible: boolean) => void): vscode.Disposable => {
    let lastVisible = panel.visible;
    return panel.onDidChangeViewState(event => {
      const visible = event.webviewPanel.visible;
      if (visible === lastVisible) {
        return;
      }
      lastVisible = visible;
      listener(visible);
    });
  };

  return {
    get webview() {
      return panel.webview;
    },
    get visible() {
      return panel.visible;
    },
    recoverAfterReadyTimeout(): void | Promise<void> {
      return replaceAfterReadyTimeout();
    },
    onDidDispose(listener: () => void): vscode.Disposable {
      return panel.onDidDispose(listener);
    },
    onDidChangeVisibility(listener: (visible: boolean) => void): vscode.Disposable {
      return onVisibilityTransition(listener);
    }
  };
}
