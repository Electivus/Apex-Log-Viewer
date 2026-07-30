import assert from 'assert/strict';
import * as vscode from 'vscode';
import { createWebviewPanelHost, createWebviewViewHost } from '../provider/webviewHost';

function noopDisposable(): vscode.Disposable {
  return { dispose() {} };
}

suite('Webview host recovery capabilities', () => {
  test('sidebar prepares and remounts the current host in place', async () => {
    const view = {
      visible: true,
      webview: {},
      onDidDispose: () => noopDisposable(),
      onDidChangeVisibility: () => noopDisposable()
    } as unknown as vscode.WebviewView;
    const recoverySteps: string[] = [];

    const sidebarHost = createWebviewViewHost(view, () => {
      recoverySteps.push('prepare');
    });
    await sidebarHost.recoverAfterReadyTimeout(() => {
      recoverySteps.push('remount');
    });

    assert.deepEqual(recoverySteps, ['prepare', 'remount']);
    assert.ok(!('kind' in sidebarHost));
    assert.ok(!('readinessTimeoutRecovery' in sidebarHost));
    assert.ok(!('onDidBecomeVisible' in sidebarHost));
  });

  test('editor delegates replacement without remounting the current host', async () => {
    const panel = {
      visible: true,
      webview: {},
      onDidDispose: () => noopDisposable(),
      onDidChangeViewState: () => noopDisposable()
    } as unknown as vscode.WebviewPanel;
    let editorRemounts = 0;
    let editorReplacements = 0;

    const editorHost = createWebviewPanelHost(panel, () => {
      editorReplacements += 1;
    });
    await editorHost.recoverAfterReadyTimeout(() => {
      editorRemounts += 1;
    });

    assert.equal(editorRemounts, 0);
    assert.equal(editorReplacements, 1);
    assert.ok(!('kind' in editorHost));
    assert.ok(!('readinessTimeoutRecovery' in editorHost));
    assert.ok(!('onDidBecomeVisible' in editorHost));
  });
});
