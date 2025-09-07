import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { getApexLogsDir } from '../utils/workspace';

suite('getApexLogsDir saveDirName', () => {
  const originalGetConfiguration = vscode.workspace.getConfiguration;
  let workspaceFoldersDescriptor: PropertyDescriptor | undefined;

  setup(() => {
    workspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  });

  teardown(() => {
    (vscode.workspace.getConfiguration as any) = originalGetConfiguration;
    if (workspaceFoldersDescriptor) {
      Object.defineProperty(vscode.workspace, 'workspaceFolders', workspaceFoldersDescriptor);
    } else {
      delete (vscode.workspace as any).workspaceFolders;
    }
  });

  test('custom saveDirName alters output directory', () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: [{ uri: vscode.Uri.file('/w') }],
      configurable: true
    });
    (vscode.workspace.getConfiguration as any) = () => ({ get: () => undefined });
    const defDir = getApexLogsDir();
    (vscode.workspace.getConfiguration as any) = () => ({
      get: (key: string) => (key.endsWith('saveDirName') ? 'custom' : undefined)
    });
    const customDir = getApexLogsDir();
    assert.equal(defDir, path.join('/w', '.sflogs', 'apexlogs'));
    assert.equal(customDir, path.join('/w', '.sflogs', 'custom'));
  });
});
