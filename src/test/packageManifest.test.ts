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
  test('requires a VS Code engine version that supports openFolder filesToOpen', async () => {
    const manifest = await readPackageManifest();

    assert.equal(
      manifest.engines?.vscode,
      '^1.102.0',
      'package.json should require VS Code 1.102+ because the new-window handoff depends on vscode.openFolder filesToOpen'
    );
  });

  test('activates when the floated logs editor panel is restored', async () => {
    const manifest = await readPackageManifest();
    const activationEvents = Array.isArray(manifest.activationEvents) ? manifest.activationEvents : [];

    assert.ok(
      activationEvents.includes('onWebviewPanel:sfLogViewer.logsEditor'),
      'package.json should activate the extension when the floated logs editor panel is restored'
    );
  });

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
    assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openLogsInNewWindowFromLogsView'));
    assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openTailInNewWindow'));
    assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openDebugFlagsInNewWindow'));
    assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openLogInViewerInNewWindow'));
  });

  test('keeps logs and tail title actions in the secondary overflow menu', async () => {
    const manifest = await readPackageManifest();
    const menus = manifest.contributes?.menus ?? {};
    const viewTitleEntries = menus['view/title'] ?? [];
    const editorTitleEntries = menus['editor/title'] ?? [];
    const findViewTitleEntry = (command: string) => viewTitleEntries.find((entry: any) => entry.command === command);

    assert.ok(findViewTitleEntry('sfLogs.openLogsInNewWindowFromLogsView'));
    assert.ok(findViewTitleEntry('sfLogs.openTailInNewWindow'));
    assert.ok(findViewTitleEntry('sfLogs.troubleshootWebview'));
    assert.ok(findViewTitleEntry('sfLogs.resetCliCache'));
    assert.ok(findViewTitleEntry('sfLogs.showOutput'));

    for (const command of [
      'sfLogs.openLogsInNewWindowFromLogsView',
      'sfLogs.openTailInNewWindow',
      'sfLogs.troubleshootWebview',
      'sfLogs.resetCliCache',
      'sfLogs.showOutput'
    ]) {
      const entry = findViewTitleEntry(command);
      assert.ok(entry, `expected ${command} in view/title`);
      assert.equal(
        String(entry.group ?? '').startsWith('navigation'),
        false,
        `${command} should use a non-navigation group so it appears under the overflow menu`
      );
    }

    const logViewerNewWindowEntry = editorTitleEntries.find(
      (entry: any) => entry.command === 'sfLogs.openLogInViewerInNewWindow'
    );
    assert.ok(logViewerNewWindowEntry, 'expected sfLogs.openLogInViewerInNewWindow in editor/title');
    assert.equal(
      logViewerNewWindowEntry.when,
      'resourceLangId == apexlog && sfLogs.canOpenLogViewerInNewWindow',
      'log viewer new-window action should only show in activatable Salesforce workspaces'
    );
  });

  test('hides the logs-toolbar new-window command from the command palette', async () => {
    const manifest = await readPackageManifest();
    const commandPaletteEntries = manifest.contributes?.menus?.commandPalette ?? [];
    const toolbarEntry = commandPaletteEntries.find((entry: any) => entry.command === 'sfLogs.openLogsInNewWindowFromLogsView');

    assert.ok(toolbarEntry, 'expected the logs-toolbar command to be explicitly hidden from the command palette');
    assert.equal(toolbarEntry.when, 'false');
  });

  test('declares localized titles for all four new-window commands', async () => {
    const nls = await readPackageNls();

    assert.equal(nls['command.openLogsInNewWindow.title'], 'Open Logs in New Window');
    assert.equal(nls['command.openTailInNewWindow.title'], 'Open Tail in New Window');
    assert.equal(nls['command.openDebugFlagsInNewWindow.title'], 'Open Debug Flags in New Window');
    assert.equal(nls['command.openLogInViewerInNewWindow.title'], 'Open Log Viewer in New Window');
  });
});
