import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
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

async function readExtensionDependencies(extensionDevelopmentPath: string): Promise<string[]> {
  try {
    const pkgPath = path.join(extensionDevelopmentPath, 'package.json');
    const raw = await readFile(pkgPath, 'utf8');
    const json = JSON.parse(raw) as { extensionDependencies?: unknown };
    if (!Array.isArray(json.extensionDependencies)) {
      return [];
    }
    return json.extensionDependencies.map(String).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function listInstalledExtensions(args: {
  cliPath: string;
  cliArgs: string[];
  userDataDir: string;
  extensionsDir: string;
}): Set<string> {
  try {
    const res = spawnSync(
      args.cliPath,
      [
        ...args.cliArgs,
        '--list-extensions',
        '--show-versions',
        '--user-data-dir',
        args.userDataDir,
        '--extensions-dir',
        args.extensionsDir
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
        input: 'y\n',
        env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' }
      }
    );
    const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
    const installed = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const trimmed = (line || '').trim();
      if (!trimmed) continue;
      const id = trimmed.split('@')[0]?.trim().toLowerCase();
      if (id) installed.add(id);
    }
    return installed;
  } catch {
    return new Set();
  }
}

function installExtensions(args: {
  cliPath: string;
  cliArgs: string[];
  userDataDir: string;
  extensionsDir: string;
  extensionIds: string[];
}): void {
  for (const id of args.extensionIds) {
    console.log(`[e2e] Installing VS Code extension dependency: ${id}`);
    const res = spawnSync(
      args.cliPath,
      [
        ...args.cliArgs,
        '--install-extension',
        id,
        '--force',
        '--user-data-dir',
        args.userDataDir,
        '--extensions-dir',
        args.extensionsDir
      ],
      {
        stdio: ['pipe', 'inherit', 'inherit'],
        encoding: 'utf8',
        input: 'y\n',
        env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' }
      }
    );
    if (res.status !== 0) {
      console.warn(`[e2e] Failed to install VS Code extension dependency: ${id}`);
    }
  }
}

async function ensureExtensionDependenciesInstalled(args: {
  vscodeExecutablePath: string;
  extensionDevelopmentPath: string;
  userDataDir: string;
  extensionsDir: string;
}): Promise<void> {
  const deps = await readExtensionDependencies(args.extensionDevelopmentPath);
  if (!deps.length) {
    return;
  }

  const cli = resolveCliArgsFromVSCodeExecutablePath(args.vscodeExecutablePath, { reuseMachineInstall: true });
  const cliPath = cli[0];
  const cliArgs = cli.slice(1);
  if (!cliPath) {
    console.warn('[e2e] Could not resolve VS Code CLI path; skipping dependency install.');
    return;
  }

  const installed = listInstalledExtensions({
    cliPath,
    cliArgs,
    userDataDir: args.userDataDir,
    extensionsDir: args.extensionsDir
  });

  const toInstall = deps.filter(id => !installed.has(String(id).toLowerCase()));
  if (!toInstall.length) {
    return;
  }

  installExtensions({
    cliPath,
    cliArgs,
    userDataDir: args.userDataDir,
    extensionsDir: args.extensionsDir,
    extensionIds: toInstall
  });
}

async function isAuxiliaryBarOpen(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const selectors = ['#workbench\\.parts\\.auxiliarybar', '.part.auxiliarybar', '.auxiliarybar'];
      for (const selector of selectors) {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

export async function launchVsCode(options: { workspacePath: string; extensionDevelopmentPath: string }): Promise<VscodeLaunch> {
  const vscodeCachePath = process.env.VSCODE_TEST_CACHE_PATH
    ? path.resolve(process.env.VSCODE_TEST_CACHE_PATH)
    : path.join(options.extensionDevelopmentPath, '.vscode-test');
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: getVsCodeVersion(), cachePath: vscodeCachePath });

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-user-'));
  const extensionsDir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-exts-'));

  // The extension is loaded via --extensionDevelopmentPath, but VS Code still enforces
  // `extensionDependencies` at activation time. Install those dependencies into the
  // isolated extensions dir so contributed commands can activate the extension.
  try {
    await ensureExtensionDependenciesInstalled({
      vscodeExecutablePath,
      extensionDevelopmentPath: options.extensionDevelopmentPath,
      userDataDir,
      extensionsDir
    });
  } catch (e) {
    console.warn('[e2e] Failed to ensure VS Code extension dependencies are installed:', e);
  }

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
    if (await isAuxiliaryBarOpen(page)) {
      const modifier = getModifierKey();
      await page.keyboard.press(`${modifier}+Alt+B`);
    }
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
