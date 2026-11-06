import assert from 'assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

const APEX_LOG = [
  '64.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;CALLOUT,INFO;DB,INFO;SYSTEM,DEBUG;VALIDATION,INFO;WORKFLOW,INFO',
  '12:00:00.0 (1000)|USER_INFO|[EXTERNAL]|005000000000001|user@example.com|(GMT+00:00) UTC|GMT+00:00',
  '12:00:00.0 (2000)|EXECUTION_STARTED',
  ''
].join('\n');

async function codeLensCommands(uri: vscode.Uri): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const lenses =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? [];
    const commands = lenses.map(lens => lens.command?.command ?? '').filter(Boolean);
    if (commands.length > 0) {
      return commands;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return [];
}

suite('Apex log language', () => {
  let dir: string;

  suiteSetup(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'alv-apexlog-language-'));
    await vscode.extensions.getExtension('electivus.apex-log-viewer')?.activate();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await rm(dir, { recursive: true, force: true });
  });

  test('detects ApexLog from the header line when the file name says nothing', async () => {
    const file = path.join(dir, 'apex-log-without-extension');
    await writeFile(file, APEX_LOG, 'utf8');

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));

    assert.equal(document.languageId, 'apexlog');
  });

  test('offers Open in Apex Log Viewer for a .log Apex log that opens in the Log language mode', async () => {
    const file = path.join(dir, '07L000000000001AAA.log');
    await writeFile(file, APEX_LOG, 'utf8');
    const uri = vscode.Uri.file(file);

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    assert.ok(
      document.languageId === 'log' || document.languageId === 'apexlog',
      `unexpected language ${document.languageId}`
    );
    assert.deepEqual(await codeLensCommands(uri), ['electivus.apexLogViewer.log.openViewer']);
  });
});
