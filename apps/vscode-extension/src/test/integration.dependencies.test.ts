import assert from 'assert/strict';
import * as vscode from 'vscode';

suite('integration: dependencies', () => {
  test('Salesforce extension is installed', async function () {
    // Ensure our extension is discoverable
    const self = vscode.extensions.getExtension('electivus.apex-log-viewer');
    assert.ok(self, 'apex-log-viewer extension should be found');

    // Enforce dependency presence; if not installed, fail with guidance
    // Extension pack ID (older check) or any of the core modules
    const pack = vscode.extensions.getExtension('salesforce.salesforcedx-vscode');
    const core = vscode.extensions.getExtension('salesforce.salesforcedx-vscode-core');
    const apex = vscode.extensions.getExtension('salesforce.salesforcedx-vscode-apex');
    const viaEnv = process.env.SF_EXT_PRESENT === '1';
    assert.ok(
      pack || core || apex || viaEnv,
      'Salesforce extension not detected. Ensure the Salesforce extension pack (or core/apex modules) is installed. Use `npm run test:integration` to auto-install.'
    );
  });
});
