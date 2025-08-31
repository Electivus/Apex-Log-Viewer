import assert from 'assert/strict';
import * as vscode from 'vscode';
import { createRequire } from 'module';

suite('extension deactivate', () => {
  test('disposes logger output channel', () => {
    const req = createRequire(__filename);
    let disposed = false;
    const original = vscode.window.createOutputChannel;
    (vscode.window as any).createOutputChannel = () => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {
        disposed = true;
      }
    });

    const modPath = req.resolve('../../dist/extension');
    const loggerPath = req.resolve('../../dist/utils/logger');
    delete req.cache[modPath];
    delete req.cache[loggerPath];
    const ext = req('../../dist/extension');

    ext.deactivate();
    assert.ok(disposed, 'disposeLogger should be invoked');

    (vscode.window as any).createOutputChannel = original;
  });
});
