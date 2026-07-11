import assert from 'assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

suite('package manifest', () => {
  test('uses literal extension marketplace metadata for Open VSX compatibility', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, 'apps', 'vscode-extension', 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { displayName?: string; description?: string };

    assert.equal(manifest.displayName, 'Electivus Apex Log Viewer');
    assert.equal(manifest.description?.startsWith('%'), false);
    assert.equal(manifest.description?.endsWith('%'), false);
  });

  test('uses schema-valid view container ids and connects every container to its views', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, 'apps', 'vscode-extension', 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as {
      contributes?: {
        views?: Record<string, unknown>;
        viewsContainers?: Record<string, Array<{ id?: string }>>;
      };
    };
    const containerIds = Object.values(manifest.contributes?.viewsContainers ?? {})
      .flat()
      .map(container => container.id ?? '');

    assert.ok(containerIds.length > 0);
    for (const id of containerIds) {
      assert.match(id, /^[A-Za-z0-9_-]+$/);
      assert.ok(Object.hasOwn(manifest.contributes?.views ?? {}, id));
    }
  });

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

  test('generates VS Code l10n runtime bundles for packaged extension output', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { scripts?: Record<string, string> };

    assert.equal(
      manifest.scripts?.['l10n:write'],
      'node scripts/gen-l10n.cjs',
      'package.json should generate VS Code l10n bundles through the repository script'
    );
  });

  test('includes node-only extension tests in the all-tests entrypoint', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { scripts?: Record<string, string> };
    const allTestsScript = manifest.scripts?.['test:all'] ?? '';

    assert.match(
      allTestsScript,
      /\bpnpm run test:extension:node\b/,
      'package.json should keep test:all aligned with the node-only extension test lane'
    );
  });
});
