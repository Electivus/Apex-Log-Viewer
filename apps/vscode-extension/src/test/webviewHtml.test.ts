import assert from 'assert/strict';
import * as vscode from 'vscode';
import { buildWebviewHtml } from '../host/utils/webviewHtml';

suite('buildWebviewHtml', () => {
  test('declares the VS Code display language on the document', () => {
    const webview = {
      cspSource: 'vscode-resource://test',
      asWebviewUri: (uri: vscode.Uri) => uri
    } as unknown as vscode.Webview;

    const html = buildWebviewHtml(webview, vscode.Uri.file('/ext'), 'main.js', 'Title');

    assert.ok(html.includes(`<html lang="${vscode.env.language}">`), html.slice(0, 120));
  });
});
