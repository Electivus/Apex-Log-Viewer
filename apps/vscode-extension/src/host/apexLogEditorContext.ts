import * as vscode from 'vscode';
import { isApexLogDocument } from './utils/workspace';

/**
 * True while the active editor shows an Apex log, whatever its language mode. VS Code's built-in Log
 * language claims `.log`, so a downloaded Apex log usually opens as `log`, not `apexlog`, and the
 * editor-title button needs this key to appear.
 */
export const ACTIVE_EDITOR_IS_APEX_LOG = 'electivus.apexLogViewer.activeEditorIsApexLog';

export function registerApexLogEditorContext(): vscode.Disposable {
  let current: boolean | undefined;
  const update = () => {
    const document = vscode.window.activeTextEditor?.document;
    const next = !!document && document.uri.scheme === 'file' && isApexLogDocument(document);
    if (next === current) {
      return;
    }
    current = next;
    void vscode.commands.executeCommand('setContext', ACTIVE_EDITOR_IS_APEX_LOG, next);
  };
  update();
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveTextEditor(update),
    // A log pasted into an empty `.log` file, or a file still loading, becomes an Apex log later.
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        update();
      }
    })
  );
}
