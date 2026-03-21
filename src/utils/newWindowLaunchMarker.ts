import * as vscode from 'vscode';
import type { WorkspaceTarget } from '../shared/newWindowLaunch';

export function toWorkspaceScopedMarkerUri(workspaceTarget: WorkspaceTarget, markerFilePath: string): vscode.Uri {
  const workspaceUri = vscode.Uri.parse(workspaceTarget.uri);
  if (workspaceUri.scheme === 'file') {
    return vscode.Uri.file(markerFilePath);
  }
  return workspaceUri.with({ path: markerFilePath, query: '', fragment: '' });
}
