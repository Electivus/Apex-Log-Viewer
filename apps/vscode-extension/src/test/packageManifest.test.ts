import assert from 'assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

suite('package manifest', () => {
  test('does not require Apex Replay Debugger as an extension dependency', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { devDependencies?: unknown; extensionDependencies?: unknown };
    const extensionDependencies = Array.isArray(manifest.extensionDependencies) ? manifest.extensionDependencies : [];

    assert.equal(
      extensionDependencies.includes('salesforce.salesforcedx-vscode-apex-replay-debugger'),
      false,
      'package.json should not hard-require the Apex Replay Debugger at activation time'
    );
  });

  test('declares yaml as a direct devDependency for the dependabot config tests', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { devDependencies?: unknown };
    const devDependencies =
      manifest.devDependencies && typeof manifest.devDependencies === 'object' ? manifest.devDependencies : {};

    assert.equal(
      Object.hasOwn(devDependencies, 'yaml'),
      true,
      'package.json should declare yaml directly because apps/vscode-extension/src/test/dependabotConfig.test.ts imports it'
    );
  });
});
