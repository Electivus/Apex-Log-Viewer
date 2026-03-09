import assert from 'assert/strict';
import * as vscode from 'vscode';

suite('integration: dependencies', () => {
  test('extension manifest does not hard-require Apex Replay Debugger', async function () {
    const self = vscode.extensions.getExtension('electivus.apex-log-viewer');
    assert.ok(self, 'apex-log-viewer extension should be found');

    const packageJson = self.packageJSON as { extensionDependencies?: unknown };
    const extensionDependencies = Array.isArray(packageJson.extensionDependencies) ? packageJson.extensionDependencies : [];
    assert.equal(
      extensionDependencies.includes('salesforce.salesforcedx-vscode-apex-replay-debugger'),
      false,
      'Apex Replay Debugger should remain optional until the user starts a replay action'
    );

    await self.activate();
  });
});
