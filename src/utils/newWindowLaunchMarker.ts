import * as vscode from 'vscode';
import { LAUNCH_REQUEST_TTL_MS, type WorkspaceTarget } from '../shared/newWindowLaunch';

function normalizeWorkspaceMarkerPath(markerFilePath: string): string {
  const normalizedPath = markerFilePath.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalizedPath) ? `/${normalizedPath}` : normalizedPath;
}

export function toWorkspaceScopedMarkerUri(workspaceTarget: WorkspaceTarget, markerFilePath: string): vscode.Uri {
  const workspaceUri = vscode.Uri.parse(workspaceTarget.uri);
  if (workspaceUri.scheme === 'file') {
    return vscode.Uri.file(markerFilePath);
  }
  return workspaceUri.with({ path: normalizeWorkspaceMarkerPath(markerFilePath), query: '', fragment: '' });
}

export function getLaunchMarkerDeadline(createdAt: number): number {
  return createdAt + LAUNCH_REQUEST_TTL_MS;
}
