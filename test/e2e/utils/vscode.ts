import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

export type VscodeLaunch = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  extensionsDir: string;
  cleanup: () => Promise<void>;
};

function getModifierKey(): 'Control' | 'Meta' {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

function getVsCodeVersion(): string {
  const v = String(process.env.VSCODE_TEST_VERSION || 'stable').trim();
  return v || 'stable';
}

export async function launchVsCode(options: { workspacePath: string; extensionDevelopmentPath: string }): Promise<VscodeLaunch> {
  const vscodeCachePath = process.env.VSCODE_TEST_CACHE_PATH
    ? path.resolve(process.env.VSCODE_TEST_CACHE_PATH)
    : path.join(options.extensionDevelopmentPath, '.vscode-test');
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: getVsCodeVersion(), cachePath: vscodeCachePath });

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-user-'));
  const extensionsDir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-exts-'));

  const args = [
    options.workspacePath,
    `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-updates',
    '--no-sandbox'
  ];

  const app = await electron.launch({
    executablePath: vscodeExecutablePath,
    args,
    env: {
      ...process.env,
      ELECTRON_DISABLE_GPU: process.env.ELECTRON_DISABLE_GPU || '1',
      LC_ALL: process.env.LC_ALL || 'C.UTF-8',
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null',
      NO_AT_BRIDGE: process.env.NO_AT_BRIDGE || '1'
    }
  });

  const page = await app.firstWindow();
  await page.locator('.monaco-workbench').waitFor({ timeout: 120_000 });

  // Close the auxiliary (right) sidebar if it opens by default (e.g., Copilot Chat),
  // as it can overlap/push custom panels and introduce E2E flakiness.
  try {
    const modifier = getModifierKey();
    await page.keyboard.press(`${modifier}+Alt+B`);
  } catch {
    // best-effort
  }

  const cleanup = async () => {
    try {
      await app.close();
    } catch {}
    await rm(userDataDir, { recursive: true, force: true });
    await rm(extensionsDir, { recursive: true, force: true });
  };

  return { app, page, userDataDir, extensionsDir, cleanup };
}
