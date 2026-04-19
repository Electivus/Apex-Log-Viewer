import * as vscode from 'vscode';

export interface BoundWebviewHost {
  readonly kind: 'panel' | 'editor';
  readonly webview: vscode.Webview;
  readonly visible: boolean;
  onDidDispose(listener: () => void): vscode.Disposable;
  onDidChangeVisibility(listener: (visible: boolean) => void): vscode.Disposable;
  onDidBecomeVisible(listener: () => void): vscode.Disposable;
}

export function createWebviewViewHost(view: vscode.WebviewView): BoundWebviewHost {
  return {
    kind: 'panel',
    get webview() {
      return view.webview;
    },
    get visible() {
      return view.visible;
    },
    onDidDispose(listener: () => void): vscode.Disposable {
      return view.onDidDispose(listener);
    },
    onDidChangeVisibility(listener: (visible: boolean) => void): vscode.Disposable {
      return view.onDidChangeVisibility(() => {
        listener(view.visible);
      });
    },
    onDidBecomeVisible(listener: () => void): vscode.Disposable {
      return view.onDidChangeVisibility(() => {
        if (view.visible) {
          listener();
        }
      });
    }
  };
}

export function createWebviewPanelHost(panel: vscode.WebviewPanel): BoundWebviewHost {
  return {
    kind: 'editor',
    get webview() {
      return panel.webview;
    },
    get visible() {
      return panel.visible;
    },
    onDidDispose(listener: () => void): vscode.Disposable {
      return panel.onDidDispose(listener);
    },
    onDidChangeVisibility(listener: (visible: boolean) => void): vscode.Disposable {
      return panel.onDidChangeViewState(event => {
        listener(event.webviewPanel.visible);
      });
    },
    onDidBecomeVisible(listener: () => void): vscode.Disposable {
      return panel.onDidChangeViewState(event => {
        if (event.webviewPanel.visible) {
          listener();
        }
      });
    }
  };
}
