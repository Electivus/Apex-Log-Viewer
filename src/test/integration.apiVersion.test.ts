import assert from 'assert/strict';
import * as vscode from 'vscode';

suite('integration: API version from workspace', () => {
  test('reads sourceApiVersion from sfdx-project.json', async function () {
    // Opening with sample workspace is configured in .vscode-test.mjs
    const ext = vscode.extensions.getExtension('electivus.apex-log-viewer');
    assert.ok(ext, 'extension should be discoverable by id');

    const exports = await ext!.activate();
    const version = exports && typeof exports.getApiVersion === 'function' ? exports.getApiVersion() : undefined;
    // Expect our activation to have read sample-workspace/sfdx-project.json
    assert.equal(version, '60.0');
  });
});
