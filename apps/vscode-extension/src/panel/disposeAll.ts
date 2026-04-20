import * as vscode from 'vscode';

export function disposeAll(disposables: vscode.Disposable[]): void {
  for (const disposable of disposables.splice(0, disposables.length)) {
    try {
      disposable.dispose();
    } catch {}
  }
}
