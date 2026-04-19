import { mkdtemp, readFile, access, readdir, mkdir, open, stat, unlink, utimes } from 'node:fs/promises';
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
  const normalizedPath = path.normalize(extensionDevelopmentPath);
  const extensionDirName = path.basename(normalizedPath);
  const parentDirName = path.basename(path.dirname(normalizedPath));
  const cacheRoot =
    extensionDirName === 'vscode-extension' && parentDirName === 'apps'
      ? path.dirname(path.dirname(normalizedPath))
      : normalizedPath;
  return process.env.VSCODE_TEST_CACHE_PATH
    ? path.resolve(process.env.VSCODE_TEST_CACHE_PATH)
    : path.join(cacheRoot, '.vscode-test');
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

export function createMissingSupportExtensionsError(missingExtensionIds: string[]): Error {
  return new Error(
    `[e2e] Required VS Code support extensions are missing from the isolated profile: ${missingExtensionIds.join(', ')}`
  );
}

export function resolveCliSpawnInvocation(
  cliPath: string,
  cliArgs: string[] = [],
  targetPlatform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (targetPlatform === 'win32' && /\.cmd$/i.test(cliPath)) {
    // `spawnSync(code.cmd, ...)` can fail with EINVAL on Windows, so route the
    // VS Code CLI through `cmd.exe` when the resolved launcher is a batch file.
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', cliPath, ...cliArgs]
    };
  }

  return { command: cliPath, args: cliArgs };
}

export function resolveWindowSizeArg(windowSize?: Partial<VscodeWindowSize>): string | undefined {
  const width = Number(windowSize?.width);
  const height = Number(windowSize?.height);
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    return undefined;
  }
  return `--window-size=${Math.floor(width)},${Math.floor(height)}`;
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
    const invocation = resolveCliSpawnInvocation(args.cliPath, [
      ...args.cliArgs,
      '--install-extension',
      id,
      '--force',
      '--user-data-dir',
      args.userDataDir,
      '--extensions-dir',
      args.extensionsDir
    ]);
    const res = spawnSync(invocation.command, invocation.args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      encoding: 'utf8',
      input: 'y\n',
      env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' }
    });
    if (res.error || res.status !== 0) {
      const details = [
        typeof res.status === 'number' ? `exit code ${res.status}` : undefined,
        res.error?.message
      ]
        .filter(Boolean)
        .join('; ');
      console.warn(
        `[e2e] Failed to install VS Code support extension: ${id}${details ? ` (${details})` : ''}`
      );
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
  const toInstall = await findMissingExtensionIdsInRoot(args.extensionsDir, deps);
  if (!toInstall.length) {
    return args.extensionsDir;
  }

  if (!cliPath) {
    throw new Error('[e2e] Could not resolve VS Code CLI path to install required support extensions.');
  }

  installExtensions({
    cliPath,
    cliArgs,
    userDataDir: args.userDataDir,
    extensionsDir: args.extensionsDir,
    extensionIds: toInstall
  });

  const stillMissing = await findMissingExtensionIdsInRoot(args.extensionsDir, deps);
  if (stillMissing.length) {
    throw createMissingSupportExtensionsError(stillMissing);
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
  await mkdir(extensionsDir, { recursive: true });

  // The extension is loaded via --extensionDevelopmentPath. Some E2E scenarios still
  // need support extensions in a reusable test cache (for example Replay Debugger),
  // so install manifest references plus scenario-specific ids.
  await timeE2eStep(
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
  };

  return { app, page, userDataDir, extensionsDir, cleanup };
}
