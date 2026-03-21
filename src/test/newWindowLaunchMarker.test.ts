import assert from 'assert/strict';
import * as vscode from 'vscode';
import { LAUNCH_REQUEST_TTL_MS } from '../shared/newWindowLaunch';
import { getLaunchMarkerDeadline, toWorkspaceScopedMarkerUri } from '../utils/newWindowLaunchMarker';

suite('new window launch marker URIs', () => {
  test('keeps local workspaces on file URIs', () => {
    const uri = toWorkspaceScopedMarkerUri({ type: 'folder', uri: 'file:///workspace/project' }, '/tmp/alv-marker');

    assert.equal(uri.scheme, 'file');
    assert.equal(uri.toString(), vscode.Uri.file('/tmp/alv-marker').toString());
  });

  test('preserves remote scheme and authority for marker URIs', () => {
    const uri = toWorkspaceScopedMarkerUri(
      { type: 'folder', uri: 'vscode-remote://wsl+Ubuntu/home/k3/git/Apex-Log-Viewer' },
      '/tmp/alv-marker'
    );

    assert.equal(uri.scheme, 'vscode-remote');
    assert.equal(uri.authority, 'wsl+Ubuntu');
    assert.equal(uri.path, '/tmp/alv-marker');
  });

  test('uses the full launch request TTL when computing the marker wait deadline', () => {
    assert.equal(getLaunchMarkerDeadline(12_345), 12_345 + LAUNCH_REQUEST_TTL_MS);
  });
});
