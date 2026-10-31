import assert from 'assert/strict';
import * as vscode from 'vscode';
import { createRequire } from 'module';

suite('extension deactivate', () => {
  test('disposes logger output channel', async () => {
    const req = createRequire(__filename);
    let disposed = false;
    const original = vscode.window.createOutputChannel;
    (vscode.window as any).createOutputChannel = () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      trace: () => {},
      show: () => {},
      dispose: () => {
        disposed = true;
      }
    });

    const modPath = req.resolve('../../dist/extension');
    delete req.cache[modPath];
    const ext = req('../../dist/extension');

    await ext.deactivate();
    assert.ok(disposed, 'disposeLogger should be invoked');

    (vscode.window as any).createOutputChannel = original;
  });
});
