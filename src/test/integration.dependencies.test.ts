import assert from 'assert/strict';
import * as vscode from 'vscode';

suite('integration: dependencies', () => {
  test('Salesforce extension is installed', async () => {
    // Ensure our extension is discoverable
    const self = vscode.extensions.getExtension('electivus.apex-log-viewer');
    assert.ok(self, 'apex-log-viewer extension should be found');

    // Ensure required dependency is installed (installed by test runner)
    const dep = vscode.extensions.getExtension('salesforce.salesforcedx-vscode');
    assert.ok(dep, 'salesforce.salesforcedx-vscode should be installed for tests');
  });
});
