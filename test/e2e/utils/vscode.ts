import { mkdtemp, readFile, cp, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { removePathBestEffort } from './fsCleanup';
import { dismissAllNotifications } from './notifications';
import { timeE2eStep } from './timing';

export type VscodeLaunch = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  extensionsDir: string;
  cleanup: () => Promise<void>;
};

export type VscodeWindowSize = {
  width: number;
  height: number;
};

function getModifierKey(): 'Control' | 'Meta' {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

function getVsCodeVersion(): string {
  const v = String(process.env.VSCODE_TEST_VERSION || 'stable').trim();
  return v || 'stable';
}

function envFlag(name: string): boolean {
  const value = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true';
}

export function resolveSupportExtensionIds(extensionIds: unknown[] = [], extraExtensionIds: string[] = []): string[] {
  return Array.from(
    new Set([...extensionIds, ...extraExtensionIds].map(String).map(value => value.trim()).filter(Boolean))
  );
}

export function shouldAllowLocalExtensionsDirFallback(): boolean {
  return envFlag('ALV_E2E_ALLOW_LOCAL_EXTENSIONS_DIR');
}

export function resolveWindowSizeArg(windowSize?: Partial<VscodeWindowSize>): string | undefined {
  const width = Number(windowSize?.width);
  const height = Number(windowSize?.height);
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    return undefined;
  }
  return `--window-size=${Math.floor(width)},${Math.floor(height)}`;
}

export function resolveExtensionsDirForMissingDependencies(options: {
  isolatedExtensionsDir: string;
  missingExtensionIds: string[];
  localExtensionsRoot?: string;
}): { extensionsDir: string; warning?: string } {
  if (!options.missingExtensionIds.length) {
    return { extensionsDir: options.isolatedExtensionsDir };
  }

  const missingList = options.missingExtensionIds.join(', ');
  if (options.localExtensionsRoot && shouldAllowLocalExtensionsDirFallback()) {
    return {
      extensionsDir: options.localExtensionsRoot,
      warning: `[e2e] Falling back to local VS Code extensions dir: ${options.localExtensionsRoot}`
    };
  }

  return {
    extensionsDir: options.isolatedExtensionsDir,
    warning:
      `[e2e] Support extensions still missing in isolated profile: ${missingList}.` +
      (options.localExtensionsRoot
        ? ' Set ALV_E2E_ALLOW_LOCAL_EXTENSIONS_DIR=1 to opt into using the local VS Code extensions dir.'
        : '')
  };
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

async function findMissingExtensionIdsInRoot(root: string, extensionIds: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const extensionId of extensionIds) {
    const match = await findExtensionDirectoryInRoot(root, extensionId);
    if (!match) {
      missing.push(extensionId);
    }
  }
  return missing;
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
  const missingAfterInitialCheck = await findMissingExtensionIdsInRoot(args.extensionsDir, deps);
  for (const dep of missingAfterInitialCheck) {
    await copyLocalExtensionWithDependencies(dep, args.extensionsDir);
  }

  let toInstall = await findMissingExtensionIdsInRoot(args.extensionsDir, deps);
  if (!cliPath) {
    console.warn('[e2e] Could not resolve VS Code CLI path; skipping support extension install into isolated profile.');
    const localRoot = await findLocalExtensionsRootForDependencies(deps);
    const decision = resolveExtensionsDirForMissingDependencies({
      isolatedExtensionsDir: args.extensionsDir,
      missingExtensionIds: toInstall,
      localExtensionsRoot: localRoot
    });
    if (decision.warning) {
      console.warn(decision.warning);
    }
    return decision.extensionsDir;
  }

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

  const stillMissing = await findMissingExtensionIdsInRoot(args.extensionsDir, deps);
  const localRoot = await findLocalExtensionsRootForDependencies(deps);
  const decision = resolveExtensionsDirForMissingDependencies({
    isolatedExtensionsDir: args.extensionsDir,
    missingExtensionIds: stillMissing,
    localExtensionsRoot: localRoot
  });
  if (decision.warning) {
    console.warn(decision.warning);
  }
  return decision.extensionsDir;
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

export async function ensureAuxiliaryBarClosed(page: Page): Promise<void> {
  try {
    if (!(await isAuxiliaryBarOpen(page))) {
      return;
    }

    const modifier = getModifierKey();
    await page.keyboard.press(`${modifier}+Alt+B`);
    await page
      .waitForFunction(
        () => {
          const selectors = ['#workbench\\.parts\\.auxiliarybar', '.part.auxiliarybar', '.auxiliarybar'];
          return selectors.every(selector => {
            const el = document.querySelector(selector) as HTMLElement | null;
            if (!el) {
              return true;
            }
            const rect = el.getBoundingClientRect();
            return rect.width === 0 || rect.height === 0;
          });
        },
        { timeout: 2_000 }
      )
      .catch(() => {});
  } catch {
    // best-effort
  }
}

export async function launchVsCode(options: {
  workspacePath: string;
  extensionDevelopmentPath: string;
  extensionIds?: string[];
  windowSize?: Partial<VscodeWindowSize>;
}): Promise<VscodeLaunch> {
  const vscodeCachePath = process.env.VSCODE_TEST_CACHE_PATH
    ? path.resolve(process.env.VSCODE_TEST_CACHE_PATH)
    : path.join(options.extensionDevelopmentPath, '.vscode-test');
  const vscodeExecutablePath = await timeE2eStep('vscode.download', async () =>
    await downloadAndUnzipVSCode({ version: getVsCodeVersion(), cachePath: vscodeCachePath })
  );

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-user-'));
  let extensionsDir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-exts-'));
  let shouldCleanupExtensionsDir = true;

  // The extension is loaded via --extensionDevelopmentPath. Some E2E scenarios still
  // need support extensions in the isolated profile (for example Replay Debugger),
  // so install manifest references plus scenario-specific ids.
  try {
    const resolvedExtensionsDir = await timeE2eStep('vscode.ensureSupportExtensions', async () =>
      await ensureExtensionDependenciesInstalled({
        vscodeExecutablePath,
        extensionDevelopmentPath: options.extensionDevelopmentPath,
        userDataDir,
        extensionsDir,
        extraExtensionIds: options.extensionIds
      })
    );
    if (resolvedExtensionsDir !== extensionsDir) {
      await removePathBestEffort(extensionsDir);
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
  const windowSizeArg = resolveWindowSizeArg(options.windowSize);
  if (windowSizeArg) {
    args.push(windowSizeArg);
  }

  const app = await timeE2eStep('vscode.launch', async () =>
    await electron.launch({
      executablePath: vscodeExecutablePath,
      args,
      env: {
        ...process.env,
        ELECTRON_DISABLE_GPU: process.env.ELECTRON_DISABLE_GPU || '1',
        LC_ALL: process.env.LC_ALL || 'C.UTF-8',
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null',
        NO_AT_BRIDGE: process.env.NO_AT_BRIDGE || '1'
      }
    })
  );

  const page = await timeE2eStep('vscode.firstWindow', async () => await app.firstWindow());
  await timeE2eStep('vscode.workbenchReady', async () => {
    await page.locator('.monaco-workbench').waitFor({ timeout: 120_000 });
  });

  // Close the auxiliary (right) sidebar if it opens by default (e.g., Copilot Chat),
  // as it can overlap/push custom panels and introduce E2E flakiness.
  await ensureAuxiliaryBarClosed(page);

  try {
    await dismissAllNotifications(page);
  } catch {
    // best-effort
  }

  const cleanup = async () => {
    try {
      await app.close();
    } catch {}
    await removePathBestEffort(userDataDir);
    if (shouldCleanupExtensionsDir) {
      await removePathBestEffort(extensionsDir);
    }
  };

  return { app, page, userDataDir, extensionsDir, cleanup };
}
