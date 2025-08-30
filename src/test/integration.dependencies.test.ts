import assert from 'assert/strict';
import * as vscode from 'vscode';

suite('integration: dependencies', () => {
  test('Salesforce extension is installed', async function () {
    // Ensure our extension is discoverable
    const self = vscode.extensions.getExtension('electivus.apex-log-viewer');
    assert.ok(self, 'apex-log-viewer extension should be found');

    // Enforce dependency presence; if not installed, fail with guidance
    const dep = vscode.extensions.getExtension('salesforce.salesforcedx-vscode');
    assert.ok(
      dep,
      'salesforce.salesforcedx-vscode must be installed for integration tests. Use `npm run test:integration` to auto-install.'
    );
  });
});
