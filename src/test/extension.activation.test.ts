import assert from 'assert/strict';
import * as vscode from 'vscode';

suite('integration: extension activation and commands', () => {
  test('activates the extension and registers commands', async () => {
    const ext = vscode.extensions.getExtension('electivus.apex-log-viewer');
    assert.ok(ext, 'extension should be discovered by id');

    await ext!.activate();

    const commands = await vscode.commands.getCommands(true);
    console.log('Registered commands count:', commands.length);
    console.log('Has sfLogs.refresh?', commands.includes('sfLogs.refresh'));
    console.log('Has sfLogs.selectOrg?', commands.includes('sfLogs.selectOrg'));
    console.log('Has sfLogs.tail?', commands.includes('sfLogs.tail'));
    assert.ok(commands.includes('sfLogs.refresh'), 'registers sfLogs.refresh');
    assert.ok(commands.includes('sfLogs.selectOrg'), 'registers sfLogs.selectOrg');
    assert.ok(commands.includes('sfLogs.tail'), 'registers sfLogs.tail');

    // Executing refresh should be a no-op (no view resolved yet) and not throw.
    await vscode.commands.executeCommand('sfLogs.refresh');
    // Don't execute tail here to avoid terminal side-effects in CI.
  });
});
