import { mkdtemp, rm, readFile, cp, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { dismissAllNotifications } from './notifications';

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

export function resolveSupportExtensionIds(extensionIds: unknown[] = [], extraExtensionIds: string[] = []): string[] {
  return Array.from(
    new Set([...extensionIds, ...extraExtensionIds].map(String).map(value => value.trim()).filter(Boolean))
  );
}

async function readExtensionReferences(extensionDevelopmentPath: string, extraExtensionIds: string[] = []): Promise<string[]> {
  try {
    const pkgPath = path.join(extensionDevelopmentPath, 'package.json');
    const raw = await readFile(pkgPath, 'utf8');
    const json = JSON.parse(raw) as { extensionDependencies?: unknown; extensionPack?: unknown };
    return resolveSupportExtensionIds(
      [
        ...(Array.isArray(json.extensionDependencies) ? json.extensionDependencies : []),
        ...(Array.isArray(json.extensionPack) ? json.extensionPack : [])
      ],
      extraExtensionIds
    );
  } catch {
    return resolveSupportExtensionIds([], extraExtensionIds);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getExtensionSearchRoots(): string[] {
  const roots = [
    path.join(process.env.USERPROFILE || '', '.vscode', 'extensions'),
    path.join(process.env.HOME || '', '.vscode', 'extensions')
  ];
  return Array.from(new Set(roots.filter(Boolean)));
}

async function findExtensionDirectoryInRoot(root: string, extensionId: string): Promise<string | undefined> {
  const normalizedId = extensionId.toLowerCase();
  const prefix = `${normalizedId}-`;
  const matches: string[] = [];

  if (!(await pathExists(root))) {
    return undefined;
  }

  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const entryName = entry.name.toLowerCase();
      if (entryName === normalizedId || entryName.startsWith(prefix)) {
        matches.push(path.join(root, entry.name));
      }
    }
  } catch {
    // best-effort
  }

  return matches.sort((a, b) => a.localeCompare(b)).at(-1);
}

async function findLocalExtensionDirectory(extensionId: string): Promise<string | undefined> {
  for (const root of getExtensionSearchRoots()) {
    const match = await findExtensionDirectoryInRoot(root, extensionId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

async function findLocalExtensionsRootForDependencies(extensionIds: string[]): Promise<string | undefined> {
  for (const root of getExtensionSearchRoots()) {
    let allPresent = true;
    for (const extensionId of extensionIds) {
      const match = await findExtensionDirectoryInRoot(root, extensionId);
      if (!match) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) {
      return root;
    }
  }
  return undefined;
}

async function copyLocalExtensionWithDependencies(
  extensionId: string,
  extensionsDir: string,
  seen = new Set<string>()
): Promise<boolean> {
  const normalizedId = extensionId.toLowerCase();
  if (seen.has(normalizedId)) {
    return false;
  }
  seen.add(normalizedId);

  const sourceDir = await findLocalExtensionDirectory(extensionId);
  if (!sourceDir) {
    return false;
  }

  const destDir = path.join(extensionsDir, path.basename(sourceDir));
  await cp(sourceDir, destDir, { recursive: true, force: true });
  console.log(`[e2e] Reused locally installed VS Code support extension: ${extensionId}`);

  const nestedDeps = await readExtensionReferences(sourceDir);
  for (const dep of nestedDeps) {
    await copyLocalExtensionWithDependencies(dep, extensionsDir, seen);
  }

  return true;
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
    console.log(`[e2e] Installing VS Code support extension: ${id}`);
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
      console.warn(`[e2e] Failed to install VS Code support extension: ${id}`);
    }
  }
}

async function ensureExtensionDependenciesInstalled(args: {
  vscodeExecutablePath: string;
  extensionDevelopmentPath: string;
  userDataDir: string;
  extensionsDir: string;
  extraExtensionIds?: string[];
}): Promise<string> {
  const deps = await readExtensionReferences(args.extensionDevelopmentPath, args.extraExtensionIds ?? []);
  if (!deps.length) {
    return args.extensionsDir;
  }

  const cli = resolveCliArgsFromVSCodeExecutablePath(args.vscodeExecutablePath, { reuseMachineInstall: true });
  const cliPath = cli[0];
  const cliArgs = cli.slice(1);
  if (!cliPath) {
    console.warn('[e2e] Could not resolve VS Code CLI path; skipping dependency install.');
    return (await findLocalExtensionsRootForDependencies(deps)) || args.extensionsDir;
  }

  let installed = listInstalledExtensions({
    cliPath,
    cliArgs,
    userDataDir: args.userDataDir,
    extensionsDir: args.extensionsDir
  });

  const missingAfterInitialCheck = deps.filter(id => !installed.has(String(id).toLowerCase()));
  for (const dep of missingAfterInitialCheck) {
    await copyLocalExtensionWithDependencies(dep, args.extensionsDir);
  }

  installed = listInstalledExtensions({
    cliPath,
    cliArgs,
    userDataDir: args.userDataDir,
    extensionsDir: args.extensionsDir
  });

  const toInstall = deps.filter(id => !installed.has(String(id).toLowerCase()));
  if (!toInstall.length) {
    return args.extensionsDir;
  }

  installExtensions({
    cliPath,
    cliArgs,
    userDataDir: args.userDataDir,
    extensionsDir: args.extensionsDir,
    extensionIds: toInstall
  });

  installed = listInstalledExtensions({
    cliPath,
    cliArgs,
    userDataDir: args.userDataDir,
    extensionsDir: args.extensionsDir
  });

  const stillMissing = deps.filter(id => !installed.has(String(id).toLowerCase()));
  if (!stillMissing.length) {
    return args.extensionsDir;
  }

  const localRoot = await findLocalExtensionsRootForDependencies(deps);
  if (localRoot) {
    console.warn(`[e2e] Falling back to local VS Code extensions dir: ${localRoot}`);
    return localRoot;
  }

  return args.extensionsDir;
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

export async function launchVsCode(options: {
  workspacePath: string;
  extensionDevelopmentPath: string;
  extensionIds?: string[];
}): Promise<VscodeLaunch> {
  const vscodeCachePath = process.env.VSCODE_TEST_CACHE_PATH
    ? path.resolve(process.env.VSCODE_TEST_CACHE_PATH)
    : path.join(options.extensionDevelopmentPath, '.vscode-test');
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: getVsCodeVersion(), cachePath: vscodeCachePath });

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-user-'));
  let extensionsDir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-exts-'));
  let shouldCleanupExtensionsDir = true;

  // The extension is loaded via --extensionDevelopmentPath. Some E2E scenarios still
  // need support extensions in the isolated profile (for example Replay Debugger),
  // so install manifest references plus scenario-specific ids.
  try {
    const resolvedExtensionsDir = await ensureExtensionDependenciesInstalled({
      vscodeExecutablePath,
      extensionDevelopmentPath: options.extensionDevelopmentPath,
      userDataDir,
      extensionsDir,
      extraExtensionIds: options.extensionIds
    });
    if (resolvedExtensionsDir !== extensionsDir) {
      await rm(extensionsDir, { recursive: true, force: true });
      extensionsDir = resolvedExtensionsDir;
      shouldCleanupExtensionsDir = false;
    }
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

  try {
    await dismissAllNotifications(page);
  } catch {
    // best-effort
  }

  const cleanup = async () => {
    try {
      await app.close();
    } catch {}
    await rm(userDataDir, { recursive: true, force: true });
    if (shouldCleanupExtensionsDir) {
      await rm(extensionsDir, { recursive: true, force: true });
    }
  };

  return { app, page, userDataDir, extensionsDir, cleanup };
}
