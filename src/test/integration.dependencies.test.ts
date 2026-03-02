import assert from 'assert/strict';
import * as vscode from 'vscode';

suite('integration: dependencies', () => {
  test('Apex Replay Debugger extension is installed', async function () {
    // Ensure our extension is discoverable
    const self = vscode.extensions.getExtension('electivus.apex-log-viewer');
    assert.ok(self, 'apex-log-viewer extension should be found');

    // Enforce Replay Debugger dependency presence; if not installed, fail with guidance.
    // The VS Code extension dependency is the Apex Replay Debugger module. Users can also
    // satisfy this by installing the Salesforce Extension Pack (which includes it).
    const replay = vscode.extensions.getExtension('salesforce.salesforcedx-vscode-apex-replay-debugger');
    const pack = vscode.extensions.getExtension('salesforce.salesforcedx-vscode');
    const viaEnv = process.env.SF_EXT_PRESENT === '1';
    assert.ok(
      replay || pack || viaEnv,
      'Apex Replay Debugger extension not detected. Ensure salesforce.salesforcedx-vscode-apex-replay-debugger (or the Salesforce extension pack) is installed. Use `npm run test:integration` to auto-install.'
    );
  });
});
