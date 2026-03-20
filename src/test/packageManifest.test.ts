import assert from 'assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function readPackageManifest(): Promise<any> {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
  return JSON.parse(raw);
}

async function readPackageNls(): Promise<Record<string, string>> {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const raw = await readFile(path.join(repoRoot, 'package.nls.json'), 'utf8');
  return JSON.parse(raw) as Record<string, string>;
}

suite('package manifest', () => {
  test('does not require Apex Replay Debugger as an extension dependency', async () => {
    const manifest = (await readPackageManifest()) as { devDependencies?: unknown; extensionDependencies?: unknown };
    const extensionDependencies = Array.isArray(manifest.extensionDependencies) ? manifest.extensionDependencies : [];

    assert.equal(
      extensionDependencies.includes('salesforce.salesforcedx-vscode-apex-replay-debugger'),
      false,
      'package.json should not hard-require the Apex Replay Debugger at activation time'
    );
  });

  test('declares yaml as a direct devDependency for the dependabot config tests', async () => {
    const manifest = (await readPackageManifest()) as { devDependencies?: unknown };
    const devDependencies =
      manifest.devDependencies && typeof manifest.devDependencies === 'object' ? manifest.devDependencies : {};

    assert.equal(
      Object.hasOwn(devDependencies, 'yaml'),
      true,
      'package.json should declare yaml directly because src/test/dependabotConfig.test.ts imports it'
    );
  });

  test('contributes open-in-new-window commands for each supported surface', async () => {
    const manifest = await readPackageManifest();
    const commands = manifest.contributes?.commands ?? [];

    assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openLogsInNewWindow'));
    assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openTailInNewWindow'));
    assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openDebugFlagsInNewWindow'));
    assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openLogInViewerInNewWindow'));
  });

  test('adds title-menu entry points for logs, tail, and apex log editors', async () => {
    const manifest = await readPackageManifest();
    const menus = manifest.contributes?.menus ?? {};

    assert.ok((menus['view/title'] ?? []).some((entry: any) => entry.command === 'sfLogs.openLogsInNewWindow'));
    assert.ok((menus['view/title'] ?? []).some((entry: any) => entry.command === 'sfLogs.openTailInNewWindow'));
    assert.ok((menus['editor/title'] ?? []).some((entry: any) => entry.command === 'sfLogs.openLogInViewerInNewWindow'));
  });

  test('declares localized titles for all four new-window commands', async () => {
    const nls = await readPackageNls();

    assert.equal(nls['command.openLogsInNewWindow.title'], 'Open Logs in New Window');
    assert.equal(nls['command.openTailInNewWindow.title'], 'Open Tail in New Window');
    assert.equal(nls['command.openDebugFlagsInNewWindow.title'], 'Open Debug Flags in New Window');
    assert.equal(nls['command.openLogInViewerInNewWindow.title'], 'Open Log Viewer in New Window');
  });
});
