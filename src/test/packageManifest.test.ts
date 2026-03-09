import assert from 'assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

suite('package manifest', () => {
  test('does not require Apex Replay Debugger as an extension dependency', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { extensionDependencies?: unknown };
    const extensionDependencies = Array.isArray(manifest.extensionDependencies) ? manifest.extensionDependencies : [];

    assert.equal(
      extensionDependencies.includes('salesforce.salesforcedx-vscode-apex-replay-debugger'),
      false,
      'package.json should not hard-require the Apex Replay Debugger at activation time'
    );
  });
});
