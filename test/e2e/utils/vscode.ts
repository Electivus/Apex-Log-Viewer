import { mkdtemp, readFile, cp, access, readdir, mkdir, open, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { envFlag } from './envFlag';
import { removePathBestEffort } from './fsCleanup';
import { dismissAllNotifications } from './notifications';
import { timeE2eStep } from './timing';

export type VscodeLaunch = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  extensionsDir: string;
  cleanup: (options?: { keep?: boolean }) => Promise<void>;
};

function shouldKeepUserDataDir(): boolean {
  return envFlag('ALV_E2E_KEEP_USER_DATA');
}

export type VscodeWindowSize = {
  width: number;
  height: number;
};

const VSCODE_DOWNLOAD_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const VSCODE_DOWNLOAD_LOCK_POLL_MS = 250;
const VSCODE_DOWNLOAD_LOCK_REFRESH_MS = 30 * 1000;

function getModifierKey(): 'Control' | 'Meta' {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

function getVsCodeVersion(): string {
  const v = String(process.env.VSCODE_TEST_VERSION || 'stable').trim();
  return v || 'stable';
}

export function resolveExtensionDevelopmentPath(repoRoot: string): string {
  return path.join(repoRoot, 'apps', 'vscode-extension');
}

export function resolveVscodeCachePath(extensionDevelopmentPath: string): string {
  return process.env.VSCODE_TEST_CACHE_PATH
    ? path.resolve(process.env.VSCODE_TEST_CACHE_PATH)
    : path.join(extensionDevelopmentPath, '.vscode-test');
}

function getSupportExtensionsCacheKey(vscodeVersion: string, extensionIds: string[]): string {
  const normalizedIds = resolveSupportExtensionIds(extensionIds);
  return createHash('sha1')
    .update(
      JSON.stringify({
        vscodeVersion: String(vscodeVersion || 'stable').trim() || 'stable',
        extensionIds: normalizedIds
      })
    )
    .digest('hex')
    .slice(0, 12);
}

export function resolveCachedSupportExtensionsDir(
  vscodeCachePath: string,
  vscodeVersion: string,
  extensionIds: string[] = []
): string {
  return path.join(
    vscodeCachePath,
    'extensions',
    sanitizeLockNamePart(vscodeVersion || 'stable'),
    getSupportExtensionsCacheKey(vscodeVersion, extensionIds)
  );
}

export function resolveSupportExtensionsLockPath(extensionsDir: string): string {
  return path.join(extensionsDir, '.install.lock');
}

export function resolveSupportExtensionIds(extensionIds: unknown[] = [], extraExtensionIds: string[] = []): string[] {
  return Array.from(
    new Set(
      [...extensionIds, ...extraExtensionIds]
        .map(String)
        .map(value => value.trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
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

async function readExtensionReferences(
  extensionDevelopmentPath: string,
  extraExtensionIds: string[] = []
): Promise<string[]> {
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

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeLockNamePart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-');
}

async function removeFileBestEffort(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
  } catch {}
}

async function getFileAgeMs(targetPath: string): Promise<number | undefined> {
  try {
    const info = await stat(targetPath);
    return Date.now() - info.mtimeMs;
  } catch {
    return undefined;
  }
}

async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      let refreshTimer: NodeJS.Timeout | undefined;
      try {
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
        refreshTimer = setInterval(() => {
          const now = new Date();
          void utimes(lockPath, now, now).catch(() => {});
        }, VSCODE_DOWNLOAD_LOCK_REFRESH_MS);
        refreshTimer.unref?.();
        return await action();
      } finally {
        if (refreshTimer) {
          clearInterval(refreshTimer);
        }
        await handle.close().catch(() => {});
        await removeFileBestEffort(lockPath);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') {
        throw error;
      }

      const ageMs = await getFileAgeMs(lockPath);
      if (ageMs !== undefined && ageMs > VSCODE_DOWNLOAD_LOCK_TIMEOUT_MS) {
        await removeFileBestEffort(lockPath);
        continue;
      }

      if (Date.now() - startedAt > VSCODE_DOWNLOAD_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for VS Code download lock: ${lockPath}`);
      }

      await sleep(VSCODE_DOWNLOAD_LOCK_POLL_MS);
    }
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
  userDataDir: string;
  extensionsDir: string;
  extensionIds: string[];
}): Promise<string> {
  const deps = resolveSupportExtensionIds(args.extensionIds);
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
  const vscodeVersion = getVsCodeVersion();
  const vscodeCachePath = resolveVscodeCachePath(options.extensionDevelopmentPath);
  const supportExtensionIds = await readExtensionReferences(
    options.extensionDevelopmentPath,
    options.extensionIds ?? []
  );
  const vscodeDownloadLockPath = path.join(vscodeCachePath, `.download-${sanitizeLockNamePart(vscodeVersion)}.lock`);
  const vscodeExecutablePath = await timeE2eStep(
    'vscode.download',
    async () =>
      await withFileLock(
        vscodeDownloadLockPath,
        async () => await downloadAndUnzipVSCode({ version: vscodeVersion, cachePath: vscodeCachePath })
      )
  );

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-user-'));
  let extensionsDir = resolveCachedSupportExtensionsDir(vscodeCachePath, vscodeVersion, supportExtensionIds);
  const supportExtensionsLockPath = resolveSupportExtensionsLockPath(extensionsDir);
  let shouldCleanupExtensionsDir = false;
  await mkdir(extensionsDir, { recursive: true });

  // The extension is loaded via --extensionDevelopmentPath. Some E2E scenarios still
  // need support extensions in a reusable test cache (for example Replay Debugger),
  // so install manifest references plus scenario-specific ids.
  try {
    const resolvedExtensionsDir = await timeE2eStep(
      'vscode.ensureSupportExtensions',
      async () =>
        await withFileLock(
          supportExtensionsLockPath,
          async () =>
            await ensureExtensionDependenciesInstalled({
              vscodeExecutablePath,
              userDataDir,
              extensionsDir,
              extensionIds: supportExtensionIds
            })
        )
    );
    if (resolvedExtensionsDir !== extensionsDir) {
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

  const app = await timeE2eStep(
    'vscode.launch',
    async () =>
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

  const cleanup = async (cleanupOptions?: { keep?: boolean }) => {
    try {
      await app.close();
    } catch {}
    if (cleanupOptions?.keep || shouldKeepUserDataDir()) {
      console.warn(`[e2e] Preserving VS Code user-data-dir at ${userDataDir}`);
    } else {
      await removePathBestEffort(userDataDir);
    }
    if (shouldCleanupExtensionsDir) {
      await removePathBestEffort(extensionsDir);
    }
  };

  return { app, page, userDataDir, extensionsDir, cleanup };
}
