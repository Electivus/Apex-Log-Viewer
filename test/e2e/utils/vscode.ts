import {
  mkdtemp,
  readFile,
  access,
  readdir,
  mkdir,
  open,
  stat,
  lstat,
  realpath,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { envFlag } from './envFlag';
import { removePathBestEffort } from './fsCleanup';
import { dismissAllNotifications } from './notifications';
import { applyE2eNetworkEnvironment, resolveVsCodeProxyLaunchArgs, resolveVsCodeUserProxySettings } from './proxy';
import { timeE2eStep } from './timing';

const crossSpawn = require('cross-spawn');

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
const DEFAULT_VSCODE_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_VSCODE_CLOSE_TIMEOUT_MS = 30_000;
/** How long a launch waits for its extension host to log that it started before VS Code is launched again. */
export const DEFAULT_EXTENSION_HOST_START_TIMEOUT_MS = 60_000;
const EXTENSION_HOST_START_POLL_MS = 250;
const EXTENSION_HOST_LAUNCH_ATTEMPTS = 2;
/** The line VS Code's extension host writes to its own log once it has started. */
const EXTENSION_HOST_STARTED = /\bExtension host with pid \d+ started\b/;
const REDACTED_SETTING_VALUE = '[redacted]';

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

export function resolveVscodeDownloadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawTimeoutMs = env.VSCODE_TEST_DOWNLOAD_TIMEOUT_MS?.trim();
  if (!rawTimeoutMs) {
    return DEFAULT_VSCODE_DOWNLOAD_TIMEOUT_MS;
  }

  const timeoutMs = Number(rawTimeoutMs);
  return Number.isFinite(timeoutMs) && Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_VSCODE_DOWNLOAD_TIMEOUT_MS;
}

export type VscodeCloseResult = 'closed' | 'failed' | 'timeout';

export async function closeVsCodeApp(
  app: Pick<ElectronApplication, 'close' | 'process'>,
  options: { timeoutMs?: number } = {}
): Promise<VscodeCloseResult> {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : DEFAULT_VSCODE_CLOSE_TIMEOUT_MS;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;

  const closePromise = app
    .close()
    .then((): VscodeCloseResult => 'closed')
    .catch(error => {
      if (!timedOut) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[e2e] VS Code close failed: ${detail}`);
      }
      return 'failed' as const;
    });

  const timeoutPromise = new Promise<VscodeCloseResult>(resolve => {
    timeout = setTimeout(() => {
      timedOut = true;
      resolve('timeout');
    }, timeoutMs);
    timeout.unref?.();
  });

  const result = await Promise.race([closePromise, timeoutPromise]);
  if (timeout) {
    clearTimeout(timeout);
  }

  if (result === 'timeout') {
    let pid = '';
    try {
      const child = app.process();
      pid = typeof child.pid === 'number' ? ` ${child.pid}` : '';
      try {
        child.kill();
      } catch {}
    } catch {}
    console.warn(`[e2e] VS Code close did not finish within ${timeoutMs}ms; sent kill to process${pid}.`);
  }

  return result;
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

const MARKETPLACE_EXTENSION_ID_REGEX = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;

function normalizeMarketplaceExtensionId(value: unknown): string | undefined {
  const id = String(value).trim();
  if (!id) {
    return undefined;
  }
  if (!MARKETPLACE_EXTENSION_ID_REGEX.test(id)) {
    throw new Error(`[e2e] Invalid VS Code Marketplace extension id: ${JSON.stringify(id)}`);
  }
  return id;
}

export function resolveSupportExtensionIds(extensionIds: unknown[] = [], extraExtensionIds: string[] = []): string[] {
  return Array.from(
    new Set(
      [...extensionIds, ...extraExtensionIds]
        .map(normalizeMarketplaceExtensionId)
        .filter((value): value is string => Boolean(value))
    )
  ).sort((a, b) => a.localeCompare(b));
}

export function createMissingSupportExtensionsError(missingExtensionIds: string[]): Error {
  return new Error(
    `[e2e] Required VS Code support extensions are missing from the isolated profile: ${missingExtensionIds.join(', ')}`
  );
}

const VSCODE_LOCALE_REGEX = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/;

/**
 * The display language for a launch, as `--locale` takes it (`pt-br`, `de`, `zh-cn`). Empty, `en` and `en-us`
 * mean VS Code's own English, which needs no language pack.
 */
export function resolveVsCodeLocale(value: unknown): string | undefined {
  const locale = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!locale || locale === 'en' || locale === 'en-us') {
    return undefined;
  }
  if (!VSCODE_LOCALE_REGEX.test(locale)) {
    throw new Error(`[e2e] Invalid VS Code locale: ${JSON.stringify(value)}. Use a value such as pt-br, de or zh-cn.`);
  }
  return locale;
}

// Chinese language packs are named after the script, not the region.
const LANGUAGE_PACK_NAMES: Record<string, string> = { 'zh-cn': 'zh-hans', 'zh-tw': 'zh-hant' };

/** The Marketplace id of Microsoft's language pack for `locale`, for example `ms-ceintl.vscode-language-pack-pt-br`. */
export function resolveLanguagePackExtensionId(locale: string): string {
  return `ms-ceintl.vscode-language-pack-${LANGUAGE_PACK_NAMES[locale] ?? locale}`;
}

/** True once VS Code has listed a language pack for `locale` in the profile's `languagepacks.json`. */
export async function hasLanguagePackFor(userDataDir: string, locale: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(userDataDir, 'languagepacks.json'), 'utf8');
    const packs = JSON.parse(raw) as Record<string, unknown>;
    return Boolean(packs && typeof packs === 'object' && packs[locale]);
  } catch {
    return false;
  }
}

export function resolveCliSpawnInvocation(
  cliPath: string,
  cliArgs: string[] = [],
  targetPlatform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  void targetPlatform;
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

// Linux CI runners and the proxy-lab container have no GPU, so Chromium falls back to
// software compositing. Since VS Code 1.139 (Electron 43), webview renderers on that path
// intermittently abort in cc's software zero-copy tile raster (an FD ownership CHECK),
// which Playwright reports as "Target crashed"/"Page crashed". SwiftShader keeps GPU
// compositing enabled without hardware, like a Linux desktop with a GPU.
export function resolveVsCodeCompositingLaunchArgs(targetPlatform: NodeJS.Platform = process.platform): string[] {
  return targetPlatform === 'linux' ? ['--use-gl=angle', '--use-angle=swiftshader'] : [];
}

/**
 * Applies `ALV_E2E_VSCODE_ENV`, a JSON object of variables for the VS Code process alone, to its launch environment.
 * A `null` value removes the variable. The harness keeps its own environment, so a run can start VS Code without the
 * proxy variables the harness itself needs to reach the org.
 */
export function applyVsCodeEnvOverrides<T extends NodeJS.ProcessEnv>(
  launchEnv: T,
  rawOverrides: string | undefined = process.env.ALV_E2E_VSCODE_ENV
): T {
  const raw = (rawOverrides ?? '').trim();
  if (!raw) {
    return launchEnv;
  }
  let overrides: unknown;
  try {
    overrides = JSON.parse(raw);
  } catch {
    overrides = undefined;
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('ALV_E2E_VSCODE_ENV must be a JSON object of strings or nulls.');
  }
  const next: Record<string, string | undefined> = { ...launchEnv };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) {
      delete next[name];
    } else if (typeof value === 'string') {
      next[name] = value;
    } else {
      throw new Error(`ALV_E2E_VSCODE_ENV.${name} must be a string or null.`);
    }
  }
  return next as T;
}

// E2E keeps VS Code out of sight unless ALV_E2E_SHOW_VSCODE=1. Linux runners provide
// a private Xvfb display (scripts/e2e-display.js). macOS and Windows have no virtual
// display, so their native window is concealed instead.
export function shouldConcealVsCodeWindow(
  env: NodeJS.ProcessEnv = process.env,
  targetPlatform: NodeJS.Platform = process.platform
): boolean {
  if (targetPlatform !== 'darwin' && targetPlatform !== 'win32') {
    return false;
  }
  return !/^(1|true)$/i.test(String(env.ALV_E2E_SHOW_VSCODE || '').trim());
}

type ConcealableWindow = {
  isDestroyed(): boolean;
  setOpacity(opacity: number): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setFocusable(focusable: boolean): void;
  setSkipTaskbar(skip: boolean): void;
};

// Conceals VS Code's windows from the Electron main process right after launch. The
// listener is usually in place before VS Code opens its first window; a window that
// already exists shows for a moment before it is concealed. A concealed window is
// transparent, lets clicks through, cannot take keyboard focus and stays off the
// taskbar. It keeps rendering, because Playwright launches Electron with
// --disable-backgrounding-occluded-windows and drives it over CDP, which needs neither
// OS focus nor a visible window. Hiding the window outright would stop rendering.
export async function concealVsCodeWindows(app: Pick<ElectronApplication, 'evaluate'>, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await app.evaluate(concealElectronWindows);
      return;
    } catch (error) {
      // While VS Code starts, the main process occasionally drops an evaluation
      // ("Resulting promise was garbage collected"). Concealing twice is harmless.
      if (attempt >= attempts) {
        throw error;
      }
    }
  }
}

// Serialized into the Electron main process, so it must not use anything from this module.
function concealElectronWindows(electronModule: unknown): void {
  const { app, BrowserWindow } = electronModule as {
    app: { on(event: 'browser-window-created', listener: (event: unknown, win: ConcealableWindow) => void): void };
    BrowserWindow: { getAllWindows(): ConcealableWindow[] };
  };
  const conceal = (win: ConcealableWindow): void => {
    if (win.isDestroyed()) {
      return;
    }
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.setFocusable(false);
    win.setSkipTaskbar(true);
  };
  app.on('browser-window-created', (_event, win) => conceal(win));
  for (const win of BrowserWindow.getAllWindows()) {
    conceal(win);
  }
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

function resolveVsCodeUserSettingsPath(userDataDir: string): string {
  return path.join(userDataDir, 'User', 'settings.json');
}

async function writeVsCodeUserSettings(userDataDir: string, settings: Record<string, unknown>): Promise<void> {
  const settingsPath = resolveVsCodeUserSettingsPath(userDataDir);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * A webview that loads or gets activated takes the focus late, which by default closes a palette opened meanwhile,
 * and the next `fill` then waits on a hidden input.
 */
const PALETTE_USER_SETTINGS = { 'workbench.quickOpen.closeOnFocusLost': false };

export async function createVsCodeUserDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'alv-e2e-user-'));
  await writeVsCodeUserSettings(dir, { ...PALETTE_USER_SETTINGS, ...resolveVsCodeUserProxySettings() });
  return dir;
}

function redactProxyUrlCredentials(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) {
      return value;
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return value.includes('@') ? REDACTED_SETTING_VALUE : value;
  }
}

function redactVsCodeUserSettingsForPreservation(settings: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...settings };

  if (Object.prototype.hasOwnProperty.call(redacted, 'http.proxy')) {
    redacted['http.proxy'] = redactProxyUrlCredentials(redacted['http.proxy']);
  }
  if (Object.prototype.hasOwnProperty.call(redacted, 'http.proxyAuthorization')) {
    redacted['http.proxyAuthorization'] = REDACTED_SETTING_VALUE;
  }

  return redacted;
}

export async function redactPreservedVsCodeUserData(userDataDir: string): Promise<void> {
  const settingsPath = resolveVsCodeUserSettingsPath(userDataDir);
  let settings: Record<string, unknown>;
  try {
    const rawSettings = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(rawSettings);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    settings = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  const redacted = redactVsCodeUserSettingsForPreservation(settings);
  if (JSON.stringify(redacted) !== JSON.stringify(settings)) {
    await writeFile(settingsPath, JSON.stringify(redacted, null, 2), 'utf8');
  }
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
    const extensionId = normalizeMarketplaceExtensionId(id);
    if (!extensionId) {
      continue;
    }
    console.log(`[e2e] Installing VS Code support extension: ${extensionId}`);
    const invocation = resolveCliSpawnInvocation(args.cliPath, [
      ...args.cliArgs,
      '--install-extension',
      extensionId,
      '--force',
      '--user-data-dir',
      args.userDataDir,
      '--extensions-dir',
      args.extensionsDir
    ]);
    const res = crossSpawn.sync(invocation.command, invocation.args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      encoding: 'utf8',
      input: 'y\n',
      env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' }
    });
    if (res.error || res.status !== 0) {
      const details = [typeof res.status === 'number' ? `exit code ${res.status}` : undefined, res.error?.message]
        .filter(Boolean)
        .join('; ');
      console.warn(
        `[e2e] Failed to install VS Code support extension: ${extensionId}${details ? ` (${details})` : ''}`
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

export async function resolveVsCodeAuthLaunch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<{ env: NodeJS.ProcessEnv; args: string[] }> {
  if (platform !== 'darwin' || env.GITHUB_ACTIONS !== 'true' || (!env.ALV_CI_AUTH_HOME && !env.ALV_E2E_DESKTOP_HOME))
    return { env: {}, args: [] };
  const authHome = env.ALV_CI_AUTH_HOME ?? '';
  const desktopHome = env.ALV_E2E_DESKTOP_HOME ?? '';
  const runnerTemp = env.RUNNER_TEMP ?? '';
  try {
    if (
      env.RUNNER_OS !== 'macOS' ||
      env.HOME !== authHome ||
      authHome === desktopHome ||
      path.dirname(authHome) !== runnerTemp ||
      !/^alv-sf-home\..+$/.test(path.basename(authHome))
    )
      throw new Error();
    for (const dir of [runnerTemp, authHome, desktopHome]) {
      if (!path.isAbsolute(dir) || !(await lstat(dir)).isDirectory() || (await realpath(dir)) !== dir)
        throw new Error();
    }
  } catch {
    throw new Error('Invalid macOS CI authentication homes');
  }
  // Native @salesforce/core reads auth inside the Extension Host without spawning
  // the CLI. VS Code's launch contract isolates that process before SDK loading.
  return {
    env: { HOME: desktopHome },
    args: [`--extensionEnvironment=${JSON.stringify({ HOME: authHome })}`]
  };
}

const LANGUAGE_PACK_PRIME_TIMEOUT_MS = 90_000;

/**
 * VS Code applies `--locale` at startup only when the profile's `languagepacks.json` lists that language, and only a
 * running VS Code writes that file. A fresh profile therefore needs one launch to write it before the real one.
 */
/** The log sessions VS Code has written under a user-data-dir: one folder per start, named by its start time. */
export async function listVsCodeLogSessions(userDataDir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(userDataDir, 'logs'), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

async function readWindowLogs(
  userDataDir: string,
  earlierSessions: ReadonlySet<string>,
  relativePath: string[]
): Promise<string[]> {
  const logsDir = path.join(userDataDir, 'logs');
  const texts: string[] = [];
  for (const session of await listVsCodeLogSessions(userDataDir)) {
    if (earlierSessions.has(session)) {
      continue;
    }
    let windows: string[] = [];
    try {
      windows = (await readdir(path.join(logsDir, session))).filter(name => /^window\d+$/.test(name));
    } catch {}
    for (const windowDir of windows) {
      try {
        texts.push(await readFile(path.join(logsDir, session, windowDir, ...relativePath), 'utf8'));
      } catch {}
    }
  }
  return texts;
}

/**
 * Whether the extension host of a VS Code started after `earlierSessions` were listed has logged its start.
 * Each window's extension host writes it to `logs/<session>/window<n>/exthost/exthost.log`.
 */
export async function hasExtensionHostStarted(
  userDataDir: string,
  earlierSessions: ReadonlySet<string> = new Set()
): Promise<boolean> {
  const logs = await readWindowLogs(userDataDir, earlierSessions, ['exthost', 'exthost.log']);
  return logs.some(text => EXTENSION_HOST_STARTED.test(text));
}

export async function waitForExtensionHostStart(args: {
  userDataDir: string;
  earlierSessions?: ReadonlySet<string>;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (args.timeoutMs ?? DEFAULT_EXTENSION_HOST_START_TIMEOUT_MS);
  for (;;) {
    if (await hasExtensionHostStarted(args.userDataDir, args.earlierSessions)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(args.pollMs ?? EXTENSION_HOST_START_POLL_MS);
  }
}

/** The window log lines about the extension host, such as VS Code's "did not start in 10 seconds", for the run's output. */
async function readExtensionHostRendererLines(
  userDataDir: string,
  earlierSessions: ReadonlySet<string>
): Promise<string[]> {
  const logs = await readWindowLogs(userDataDir, earlierSessions, ['renderer.log']);
  return logs
    .flatMap(text => text.split(/\r?\n/))
    .filter(line => /extension host/i.test(line))
    .slice(-20);
}

/**
 * Launches VS Code until the extension host of a launch starts, at most `attempts` times. When it does not start,
 * VS Code shows "Extension host did not start in 10 seconds" and never activates the extension, so every webview
 * wait of the test times out. That launch is discarded, and the next one starts from a fresh user-data-dir.
 */
export async function launchUntilExtensionHostStarts<T>(args: {
  launch: () => Promise<T>;
  extensionHostStarted: (launched: T) => Promise<boolean>;
  discard: (launched: T) => Promise<void>;
  attempts?: number;
  warn?: (message: string) => void;
}): Promise<T> {
  const attempts = Math.max(1, args.attempts ?? EXTENSION_HOST_LAUNCH_ATTEMPTS);
  const warn = args.warn ?? ((message: string) => console.warn(message));
  for (let attempt = 1; ; attempt++) {
    const launched = await args.launch();
    let started: boolean;
    try {
      started = await args.extensionHostStarted(launched);
    } catch (error) {
      await args.discard(launched);
      throw error;
    }
    if (started) {
      return launched;
    }
    await args.discard(launched);
    if (attempt >= attempts) {
      throw new Error(`[e2e] The VS Code extension host did not start in ${attempts} launch(es).`);
    }
    warn('[e2e] extension host did not start; relaunching VS Code');
  }
}

async function releaseUserDataDir(userDataDir: string, keep = false): Promise<void> {
  if (keep || shouldKeepUserDataDir()) {
    await redactPreservedVsCodeUserData(userDataDir);
    console.warn(`[e2e] Preserving VS Code user-data-dir at ${userDataDir}`);
  } else {
    await removePathBestEffort(userDataDir);
  }
}

async function primeLanguagePack(args: {
  vscodeExecutablePath: string;
  userDataDir: string;
  extensionsDir: string;
  locale: string;
  env: { [key: string]: string };
}): Promise<void> {
  const app = await electron.launch({
    executablePath: args.vscodeExecutablePath,
    args: [
      `--user-data-dir=${args.userDataDir}`,
      `--extensions-dir=${args.extensionsDir}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--no-sandbox',
      ...resolveVsCodeCompositingLaunchArgs()
    ],
    env: args.env
  });
  try {
    if (shouldConcealVsCodeWindow()) {
      await concealVsCodeWindows(app).catch(() => {});
    }
    const deadline = Date.now() + LANGUAGE_PACK_PRIME_TIMEOUT_MS;
    while (!(await hasLanguagePackFor(args.userDataDir, args.locale))) {
      if (Date.now() > deadline) {
        throw new Error(
          `[e2e] VS Code did not register the ${args.locale} language pack in ${args.userDataDir} within ` +
            `${LANGUAGE_PACK_PRIME_TIMEOUT_MS / 1000}s.`
        );
      }
      await sleep(250);
    }
  } finally {
    await closeVsCodeApp(app);
  }
}

export async function launchVsCode(options: {
  workspacePath: string;
  extensionDevelopmentPath: string;
  extensionIds?: string[];
  windowSize?: Partial<VscodeWindowSize>;
  additionalExtensionDevelopmentPaths?: string[];
  env?: Record<string, string>;
  /** VS Code's display language, such as `pt-br`. Installs Microsoft's language pack for it; English when unset. */
  locale?: string;
}): Promise<VscodeLaunch> {
  const authLaunch = await resolveVsCodeAuthLaunch();
  applyE2eNetworkEnvironment();
  const vscodeVersion = getVsCodeVersion();
  const vscodeCachePath = resolveVscodeCachePath(options.extensionDevelopmentPath);
  const locale = resolveVsCodeLocale(options.locale);
  const supportExtensionIds = await readExtensionReferences(options.extensionDevelopmentPath, [
    ...(options.extensionIds ?? []),
    ...(locale ? [resolveLanguagePackExtensionId(locale)] : [])
  ]);
  const vscodeDownloadLockPath = path.join(vscodeCachePath, `.download-${sanitizeLockNamePart(vscodeVersion)}.lock`);
  const vscodeExecutablePath = await timeE2eStep(
    'vscode.download',
    async () =>
      await withFileLock(
        vscodeDownloadLockPath,
        async () =>
          await downloadAndUnzipVSCode({
            version: vscodeVersion,
            cachePath: vscodeCachePath,
            timeout: resolveVscodeDownloadTimeoutMs()
          })
      )
  );

  const installUserDataDir = await createVsCodeUserDataDir();
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
            userDataDir: installUserDataDir,
            extensionsDir,
            extensionIds: supportExtensionIds
          })
      )
  );
  const launchEnv = applyVsCodeEnvOverrides({
    ...process.env,
    ...options.env,
    ...authLaunch.env,
    LC_ALL: options.env?.LC_ALL || process.env.LC_ALL || 'C.UTF-8',
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null',
    NO_AT_BRIDGE: process.env.NO_AT_BRIDGE || '1'
  });
  const launchArgs = (userDataDir: string): string[] => {
    const args = [
      options.workspacePath,
      `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
      ...(options.additionalExtensionDevelopmentPaths ?? []).map(
        extraPath => `--extensionDevelopmentPath=${extraPath}`
      ),
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--no-sandbox',
      ...(locale ? [`--locale=${locale}`] : [])
    ];
    args.push(...resolveVsCodeCompositingLaunchArgs());
    args.push(...resolveVsCodeProxyLaunchArgs());
    args.push(...authLaunch.args);
    const windowSizeArg = resolveWindowSizeArg(options.windowSize);
    if (windowSizeArg) {
      args.push(windowSizeArg);
    }
    return args;
  };

  let unusedUserDataDir: string | undefined = installUserDataDir;
  const launchWindow = async () => {
    const userDataDir = unusedUserDataDir ?? (await createVsCodeUserDataDir());
    unusedUserDataDir = undefined;
    if (locale) {
      await timeE2eStep(
        'vscode.primeLanguagePack',
        async () =>
          await primeLanguagePack({ vscodeExecutablePath, userDataDir, extensionsDir, locale, env: launchEnv })
      );
    }
    // The language pack priming above and the extension install wrote their own log sessions.
    const earlierSessions = new Set(await listVsCodeLogSessions(userDataDir));
    const app = await timeE2eStep(
      'vscode.launch',
      async () =>
        await electron.launch({
          executablePath: vscodeExecutablePath,
          args: launchArgs(userDataDir),
          env: launchEnv
        })
    );

    if (shouldConcealVsCodeWindow()) {
      await concealVsCodeWindows(app).catch(error => {
        console.warn(`[e2e] Could not hide the VS Code window; it stays visible: ${String(error)}`);
      });
    }

    const page = await timeE2eStep('vscode.firstWindow', async () => await app.firstWindow());
    await timeE2eStep('vscode.workbenchReady', async () => {
      await page.locator('.monaco-workbench').waitFor({ timeout: 120_000 });
    });
    return { app, page, userDataDir, earlierSessions };
  };

  const { app, page, userDataDir } = await launchUntilExtensionHostStarts({
    launch: launchWindow,
    extensionHostStarted: async ({ userDataDir, earlierSessions }) =>
      await timeE2eStep(
        'vscode.extensionHostStarted',
        async () => await waitForExtensionHostStart({ userDataDir, earlierSessions })
      ),
    discard: async ({ app, userDataDir, earlierSessions }) => {
      for (const line of await readExtensionHostRendererLines(userDataDir, earlierSessions)) {
        console.warn(`[e2e] VS Code window log: ${line}`);
      }
      await closeVsCodeApp(app);
      await releaseUserDataDir(userDataDir);
    }
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
      await closeVsCodeApp(app);
    } catch {}
    await releaseUserDataDir(userDataDir, cleanupOptions?.keep);
  };

  return { app, page, userDataDir, extensionsDir, cleanup };
}
