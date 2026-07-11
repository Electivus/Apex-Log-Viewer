import assert from 'assert/strict';
import * as vscode from 'vscode';

suite('integration: extension activation and commands', () => {
  test('activates the extension and registers commands', async () => {
    const ext = vscode.extensions.getExtension('electivus.apex-log-viewer');
    assert.ok(ext, 'extension should be discovered by id');

    await ext!.activate();

    const commands = await vscode.commands.getCommands(true);
    console.log('Registered commands count:', commands.length);
    console.log('Has electivus.apexLogViewer.logs.refresh?', commands.includes('electivus.apexLogViewer.logs.refresh'));
    console.log('Has electivus.apexLogViewer.org.select?', commands.includes('electivus.apexLogViewer.org.select'));
    console.log('Has electivus.apexLogViewer.tail.start?', commands.includes('electivus.apexLogViewer.tail.start'));
    console.log('Has electivus.apexLogViewer.logs.openEditor?', commands.includes('electivus.apexLogViewer.logs.openEditor'));
    console.log('Has electivus.apexLogViewer.tail.openEditor?', commands.includes('electivus.apexLogViewer.tail.openEditor'));
    assert.ok(commands.includes('electivus.apexLogViewer.logs.refresh'), 'registers electivus.apexLogViewer.logs.refresh');
    assert.ok(commands.includes('electivus.apexLogViewer.org.select'), 'registers electivus.apexLogViewer.org.select');
    assert.ok(commands.includes('electivus.apexLogViewer.tail.start'), 'registers electivus.apexLogViewer.tail.start');
    assert.ok(commands.includes('electivus.apexLogViewer.logs.openEditor'), 'registers electivus.apexLogViewer.logs.openEditor');
    assert.ok(commands.includes('electivus.apexLogViewer.tail.openEditor'), 'registers electivus.apexLogViewer.tail.openEditor');

    // Executing refresh should be a no-op (no view resolved yet) and not throw.
    await vscode.commands.executeCommand('electivus.apexLogViewer.logs.refresh');
    // Don't execute tail here to avoid terminal side-effects in CI.
  });
});
