import assert from 'assert/strict';
import * as vscode from 'vscode';

suite('integration: dependencies', () => {
  test('Salesforce extension is installed', async function () {
    // Ensure our extension is discoverable
    const self = vscode.extensions.getExtension('electivus.apex-log-viewer');
    assert.ok(self, 'apex-log-viewer extension should be found');

    // Only enforce dependency when the test runner opted-in to installs
    const shouldInstall = /^1|true$/i.test(String(process.env.VSCODE_TEST_INSTALL_DEPS || ''));
    const dep = vscode.extensions.getExtension('salesforce.salesforcedx-vscode');
    if (!dep && !shouldInstall) {
      // Skip gracefully to avoid hanging on Marketplace installs offline
      this.skip();
      return;
    }
    assert.ok(dep, 'salesforce.salesforcedx-vscode should be installed for tests');
  });
});
