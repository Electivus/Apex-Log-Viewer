import assert from 'assert/strict';
import * as vscode from 'vscode';
import { createRequire } from 'module';

suite('logger showOutput', () => {
  test('reveals output channel', () => {
    const req = createRequire(__filename);
    let preserve: boolean | undefined;
    const original = vscode.window.createOutputChannel;
    (vscode.window as any).createOutputChannel = () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      trace: () => {},
      show: (p?: boolean) => {
        preserve = p;
      },
      dispose: () => {}
    });

    const modPath = req.resolve('../utils/logger');
    delete req.cache[modPath];
    const { showOutput } = req('../utils/logger');
    showOutput(true);
    assert.strictEqual(preserve, true, 'channel.show should be invoked');

    (vscode.window as any).createOutputChannel = original;
  });
});
