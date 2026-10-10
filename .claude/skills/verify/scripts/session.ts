/**
 * Verification session host. verify.mjs bundles this file with esbuild and starts it detached
 * (under xvfb-run on headless Linux). It holds one real Salesforce org, one temporary workspace and
 * one VS Code window running the extension under development, and serves step modules over a Unix
 * socket so an agent can drive the UI in small increments. Do not run it directly.
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import type { Frame, Locator, Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import {
  runCommand,
  runCommandWhenAvailable,
  executeCommandId,
  openView
} from '../../../../test/e2e/utils/commandPalette';
import { removePathBestEffort } from '../../../../test/e2e/utils/fsCleanup';
import { closeQuickInputIfOpen, dismissAllNotifications } from '../../../../test/e2e/utils/notifications';
import { applyE2eNetworkEnvironment } from '../../../../test/e2e/utils/proxy';
import { ensureScratchOrg, type ScratchOrgResult } from '../../../../test/e2e/utils/scratchOrg';
import { clearOrgApexLogs, seedApexErrorLog, seedApexLog } from '../../../../test/e2e/utils/seedLog';
import { resolveSfCliInvocation } from '../../../../test/e2e/utils/sfCli';
import { createTempWorkspace } from '../../../../test/e2e/utils/tempWorkspace';
import * as tooling from '../../../../test/e2e/utils/tooling';
import {
  closeVsCodeApp,
  ensureAuxiliaryBarClosed,
  launchVsCode,
  redactPreservedVsCodeUserData,
  resolveExtensionDevelopmentPath
} from '../../../../test/e2e/utils/vscode';
import { waitForWebviewFrame } from '../../../../test/e2e/utils/webviews';
import { openDebugFlagsFromLogs, openDebugFlagsFromTail } from '../../../../test/e2e/specs/debugFlagsPanel.shared';

type Phase = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

type SessionState = {
  phase: Phase;
  hostPid: number;
  socketPath: string;
  sessionDir: string;
  evidenceDir: string;
  startedAt: string;
  readyAt?: string;
  stoppedAt?: string;
  error?: string;
  org?: { alias: string; username?: string; instanceUrl?: string; strategy: string; slotKey?: string };
  workspacePath?: string;
  userDataDir?: string;
  vscodePid?: number;
  seeded?: { marker: string; logId: string };
  build?: Record<string, string>;
};

const repoRoot = path.resolve(requireEnv('VERIFY_REPO_ROOT'));
const sessionDir = path.resolve(requireEnv('VERIFY_SESSION_DIR'));
const evidenceDir = path.resolve(requireEnv('VERIFY_EVIDENCE_DIR'));
const socketPath = requireEnv('VERIFY_SOCKET');
const statePath = path.join(sessionDir, 'session.json');
const explicitTargetOrg = String(process.env.VERIFY_TARGET_ORG || '').trim();
const seedOnStart = process.env.VERIFY_SEED === '1';
const recordTrace = process.env.VERIFY_TRACE === '1';
const idleMinutes = Math.max(1, Number(process.env.VERIFY_IDLE_MINUTES || 30) || 30);
const startTimeoutMinutes = 15;

const state: SessionState = {
  phase: 'starting',
  hostPid: process.pid,
  socketPath,
  sessionDir,
  evidenceDir,
  startedAt: new Date().toISOString()
};

let scratch:
  Pick<ScratchOrgResult, 'scratchAlias' | 'cleanup' | 'assertLeaseHealthy' | 'strategy' | 'slotKey'> | undefined;
let workspace: Awaited<ReturnType<typeof createTempWorkspace>> | undefined;
let app: ElectronApplication | undefined;
let page: Page | undefined;
let vscodeAlive = false;
let server: http.Server | undefined;
let shotSeq = 0;
let runSeq = 0;
let running: string | undefined;
let lastActivity = Date.now();
let stopping: Promise<void> | undefined;

function requireEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required; start the session with verify.mjs start.`);
  }
  return value;
}

function log(message: string): void {
  console.log(`[verify] ${new Date().toISOString()} ${message}`);
}

async function writeState(): Promise<void> {
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function slug(value: string): string {
  return (
    value
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'shot'
  );
}

function nextEvidencePath(name: string, extension: string): string {
  shotSeq += 1;
  return path.join(evidenceDir, `${String(shotSeq).padStart(3, '0')}-${slug(name)}.${extension}`);
}

function displayPath(file: string): string {
  const relative = path.relative(repoRoot, file);
  return relative.startsWith('..') ? file : relative;
}

function requirePage(): Page {
  if (!page || !vscodeAlive) {
    throw new Error('The VS Code window is gone; stop and restart the session.');
  }
  return page;
}

function isFrame(value: unknown): value is Frame {
  return Boolean(value) && typeof (value as Frame).childFrames === 'function';
}

async function shot(name: string, target?: Frame | Locator): Promise<string> {
  const filePath = nextEvidencePath(name, 'png');
  if (!target) {
    await requirePage().screenshot({ path: filePath });
  } else if (isFrame(target)) {
    await target.locator('body').screenshot({ path: filePath, animations: 'disabled' });
  } else {
    await target.screenshot({ path: filePath, animations: 'disabled' });
  }
  return path.relative(repoRoot, filePath);
}

async function frameWith(selector: string, timeoutMs = 120_000): Promise<Frame> {
  return await waitForWebviewFrame(requirePage(), async frame => await frame.locator(selector).first().isVisible(), {
    timeoutMs
  });
}

function orgAlias(): string {
  if (!scratch) {
    throw new Error('The session has no org.');
  }
  return scratch.scratchAlias;
}

/** Helpers handed to every step module as `h`. */
function createHelpers() {
  return {
    runCommand: (title: string) => runCommand(requirePage(), title),
    runCommandWhenAvailable: (title: string, timeoutMs = 90_000) =>
      runCommandWhenAvailable(requirePage(), title, { timeoutMs }),
    executeCommandId: (commandId: string) => executeCommandId(requirePage(), commandId),
    openView: (viewName: string) => openView(requirePage(), viewName),
    dismissNotifications: () => dismissAllNotifications(requirePage()),
    closeQuickInput: () => closeQuickInputIfOpen(requirePage()),
    closeAuxiliaryBar: () => ensureAuxiliaryBarClosed(requirePage()),
    toasts: async (): Promise<string[]> =>
      await requirePage().locator('.notifications-toasts .notification-list-item').allInnerTexts(),
    frameWith,
    logsFrame: (timeoutMs?: number) => frameWith('[data-testid="logs-open-debug-flags"]', timeoutMs),
    tailFrame: (timeoutMs?: number) => frameWith('[data-testid="tail-open-debug-flags"]', timeoutMs),
    viewerFrame: (timeoutMs?: number) => frameWith('text=Apex Log Viewer', timeoutMs),
    debugFlagsFrame: (timeoutMs?: number) => frameWith('[data-testid="debug-flags-user-search"]', timeoutMs),
    // Clicks into a webview can be swallowed while it takes focus; these retry with keyboard and DOM clicks.
    openDebugFlagsFromLogs: () => openDebugFlagsFromLogs(requirePage()),
    openDebugFlagsFromTail: () => openDebugFlagsFromTail(requirePage()),
    shot,
    saveEvidence: async (name: string, content: unknown): Promise<string> => {
      const isText = typeof content === 'string';
      const filePath = nextEvidencePath(name, isText ? 'out' : 'json');
      await writeFile(filePath, isText ? content : JSON.stringify(content, null, 2), 'utf8');
      return path.relative(repoRoot, filePath);
    },
    copyToEvidence: async (sourcePath: string, name?: string): Promise<string> => {
      const target = nextEvidencePath(name || path.basename(sourcePath), 'copy');
      await cp(sourcePath, target, { recursive: true });
      return path.relative(repoRoot, target);
    },
    seedLog: () => seedApexLog(orgAlias()),
    seedErrorLog: () => seedApexErrorLog(orgAlias()),
    clearOrgLogs: (scope: 'all' | 'mine' = 'all') => clearOrgApexLogs(orgAlias(), scope),
    orgAuth: () => tooling.getOrgAuth(orgAlias()),
    tooling,
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  };
}

function publicSession() {
  return {
    org: state.org,
    workspacePath: state.workspacePath,
    evidenceDir: state.evidenceDir,
    seeded: state.seeded,
    repoRoot
  };
}

async function appendStepRecord(record: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(evidenceDir, 'steps.jsonl'), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'a'
  });
}

async function runStep(file: string, args: unknown): Promise<Record<string, unknown>> {
  runSeq += 1;
  const seq = runSeq;
  const started = Date.now();
  const step = displayPath(file);
  log(`run #${seq} ${step}`);
  try {
    const mod = await import(`${pathToFileURL(file).href}?run=${seq}`);
    const fn = typeof mod.default === 'function' ? mod.default : mod.default?.default;
    if (typeof fn !== 'function') {
      throw new Error(`${step} must export a default async function ({ page, h, expect, session, args }).`);
    }
    const result = await fn({ page: requirePage(), app, h: createHelpers(), expect, session: publicSession(), args });
    const record = { seq, at: new Date(started).toISOString(), step, args, ok: true, ms: Date.now() - started, result };
    await appendStepRecord(record);
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    let failureShot: string | undefined;
    if (vscodeAlive) {
      failureShot = await shot(`run-${seq}-failure`).catch(() => undefined);
    }
    const record = {
      seq,
      at: new Date(started).toISOString(),
      step,
      args,
      ok: false,
      ms: Date.now() - started,
      error: message,
      failureShot
    };
    await appendStepRecord(record);
    return record;
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function status(): Promise<Record<string, unknown>> {
  let workbenchVisible = false;
  let webviewFrames = 0;
  if (page && vscodeAlive) {
    workbenchVisible = await page
      .locator('.monaco-workbench')
      .isVisible()
      .catch(() => false);
    webviewFrames = page.frames().filter(frame => /vscode-webview/i.test(frame.url())).length;
  }
  let leaseHealthy = true;
  let leaseError: string | undefined;
  try {
    scratch?.assertLeaseHealthy?.();
  } catch (error) {
    leaseHealthy = false;
    leaseError = error instanceof Error ? error.message : String(error);
  }
  return {
    phase: state.phase,
    vscodeAlive,
    workbenchVisible,
    webviewFrames,
    leaseHealthy,
    leaseError,
    running,
    idleMinutesLeft: Math.max(0, Math.round((idleMinutes * 60_000 - (Date.now() - lastActivity)) / 60_000))
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  lastActivity = Date.now();
  const url = req.url || '/';
  if (req.method === 'GET' && url === '/status') {
    reply(res, 200, await status());
    return;
  }
  if (req.method !== 'POST') {
    reply(res, 404, { error: `No route ${req.method} ${url}` });
    return;
  }
  const body = await readBody(req);
  if (url === '/stop') {
    reply(res, 202, { stopping: true });
    void stop({ retire: Boolean(body.retire), keep: Boolean(body.keep), reason: 'stop requested' });
    return;
  }
  if (state.phase !== 'ready') {
    reply(res, 409, { error: `Session is ${state.phase}, not ready.` });
    return;
  }
  if (running) {
    reply(res, 409, { error: `Step ${running} is still running; steps run one at a time.` });
    return;
  }
  if (url === '/shot') {
    reply(res, 200, { shot: await shot(String(body.name || 'window')) });
    return;
  }
  if (url === '/run') {
    const file = path.resolve(String(body.file || ''));
    running = displayPath(file);
    try {
      reply(res, 200, await runStep(file, body.args ?? {}));
    } finally {
      running = undefined;
      lastActivity = Date.now();
    }
    return;
  }
  reply(res, 404, { error: `No route POST ${url}` });
}

async function listFiles(root: string, prefix = ''): Promise<Array<{ path: string; bytes: number }>> {
  const files: Array<{ path: string; bytes: number }> = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => [])) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push({ path: relative, bytes: (await stat(path.join(root, relative))).size });
    }
  }
  return files;
}

async function stop(options: { retire?: boolean; keep?: boolean; reason: string }): Promise<void> {
  stopping ??= (async () => {
    log(`stopping (${options.reason}; retire=${Boolean(options.retire)} keep=${Boolean(options.keep)})`);
    const wasReady = state.phase === 'ready';
    state.phase = 'stopping';
    await writeState().catch(() => {});
    if (app && vscodeAlive) {
      if (recordTrace) {
        await app
          .context()
          .tracing.stop({ path: path.join(evidenceDir, 'trace.zip') })
          .catch(error => log(`trace not saved: ${String(error)}`));
      }
      if (wasReady) {
        await shot('final-window').catch(() => {});
      }
      await closeVsCodeApp(app);
    }
    if (state.userDataDir) {
      await cp(path.join(state.userDataDir, 'logs'), path.join(evidenceDir, 'vscode-logs'), { recursive: true }).catch(
        () => log('no VS Code logs to copy')
      );
      if (options.keep) {
        await redactPreservedVsCodeUserData(state.userDataDir);
        log(`kept VS Code user data at ${state.userDataDir}`);
      } else {
        await removePathBestEffort(state.userDataDir);
      }
    }
    if (workspace) {
      await writeFile(
        path.join(evidenceDir, 'workspace-files.json'),
        JSON.stringify(await listFiles(workspace.workspacePath), null, 2),
        'utf8'
      ).catch(() => {});
      await workspace.cleanup({ keep: options.keep });
    }
    if (scratch) {
      // A start failure is recorded on the slot without retiring it; --retire is the explicit "the org is damaged".
      const release = options.retire
        ? { success: false, needsRecreate: true, lastRunResult: 'failed', errorMessage: 'Retired by verify session.' }
        : state.error
          ? {
              success: true,
              lastRunResult: 'failed',
              errorMessage: `verify start failed: ${state.error.split('\n')[0]}`
            }
          : { success: true };
      await scratch
        .cleanup(release)
        .then(() =>
          log(
            state.org?.slotKey
              ? `lease release sent for ${state.org.slotKey} (${options.retire ? 'needs_recreate' : 'healthy'}); ` +
                  'a "[e2e] scratch-org pool release failed" line above means it was not accepted'
              : 'no pool lease to release'
          )
        )
        .catch(error => log(`org release failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    await rm(socketPath, { force: true });
    state.phase = state.error ? 'failed' : 'stopped';
    state.stoppedAt = new Date().toISOString();
    await writeFile(path.join(evidenceDir, 'session.json'), JSON.stringify(state, null, 2), 'utf8').catch(() => {});
    await rm(sessionDir, { recursive: true, force: true });
    log(`stopped; evidence kept at ${path.relative(repoRoot, evidenceDir)}`);
    process.exit(state.error ? 1 : 0);
  })();
  await stopping;
}

async function buildFingerprint(): Promise<Record<string, string>> {
  const files = [
    'apps/vscode-extension/dist/extension.js',
    'apps/vscode-extension/media/main.js',
    'apps/vscode-extension/media/tail.js',
    'apps/vscode-extension/media/logViewer.js',
    'apps/vscode-extension/media/debugFlags.js'
  ];
  const result: Record<string, string> = {};
  for (const file of files) {
    result[file] = (await stat(path.join(repoRoot, file))).mtime.toISOString();
  }
  return result;
}

async function start(): Promise<void> {
  // A start that hangs after the lease is acquired (seeding, VS Code launch) must still give the slot back.
  const startWatchdog = setTimeout(() => {
    state.error ??= `start did not reach ready within ${startTimeoutMinutes} minutes`;
    void stop({ reason: 'start timed out' });
  }, startTimeoutMinutes * 60_000);
  delete process.env.ELECTRON_RUN_AS_NODE;
  applyE2eNetworkEnvironment();
  await mkdir(evidenceDir, { recursive: true });
  await rm(socketPath, { force: true });
  state.build = await buildFingerprint();
  await writeState();

  if (explicitTargetOrg) {
    log(`using already-authenticated org '${explicitTargetOrg}' (no pool lease)`);
    scratch = { scratchAlias: explicitTargetOrg, strategy: 'single', cleanup: async () => {} };
  } else {
    log('acquiring a real org through the configured Dev Hub (pool lease or single scratch)...');
    scratch = await ensureScratchOrg();
  }
  const auth = await tooling.getOrgAuth(scratch.scratchAlias, { forceRefresh: true });
  state.org = {
    alias: scratch.scratchAlias,
    username: auth.username,
    instanceUrl: auth.instanceUrl,
    strategy: explicitTargetOrg ? 'existing' : scratch.strategy,
    slotKey: scratch.slotKey
  };
  log(`org ready: ${scratch.scratchAlias} (${auth.username ?? 'unknown user'})`);

  const sfCli = await resolveSfCliInvocation();
  workspace = await createTempWorkspace({ targetOrg: scratch.scratchAlias, sfCli: sfCli ?? undefined });
  state.workspacePath = workspace.workspacePath;
  await writeState();

  if (seedOnStart) {
    log('seeding one Apex log...');
    state.seeded = await seedApexLog(scratch.scratchAlias);
    log(`seeded ${state.seeded.logId} with marker ${state.seeded.marker}`);
  }

  log('launching VS Code with the extension under development...');
  const launch = await launchVsCode({
    workspacePath: workspace.workspacePath,
    extensionDevelopmentPath: resolveExtensionDevelopmentPath(repoRoot)
  });
  app = launch.app;
  page = launch.page;
  vscodeAlive = true;
  state.userDataDir = launch.userDataDir;
  state.vscodePid = app.process().pid;
  // Outside the Playwright runner actions have no timeout; a hung step would hold the lease (idle stop skips running steps).
  app.context().setDefaultTimeout(60_000);
  app.on('close', () => {
    vscodeAlive = false;
    log('VS Code window closed');
  });
  if (recordTrace) {
    await app.context().tracing.start({ screenshots: true, snapshots: true });
  }

  // Running a contributed command activates the development extension; its handler only exists after activate().
  await runCommandWhenAvailable(page, 'Electivus Apex Logs: Show Extension Output', { timeoutMs: 120_000 });
  await page.waitForTimeout(1_500);
  const activationErrors = (await page.locator('.notifications-toasts .notification-list-item').allInnerTexts()).filter(
    text => /not found|failed to activate|activating extension/i.test(text)
  );
  if (activationErrors.length) {
    throw new Error(`The extension did not activate: ${activationErrors.join(' | ')}`);
  }
  await runCommand(page, 'View: Close Panel').catch(() => {});
  await closeQuickInputIfOpen(page);
  await dismissAllNotifications(page);
  await shot('ready');

  server = http.createServer((req, res) => {
    handle(req, res).catch(error => reply(res, 500, { error: error instanceof Error ? error.message : String(error) }));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(socketPath, () => resolve());
  });

  clearTimeout(startWatchdog);
  state.phase = 'ready';
  state.readyAt = new Date().toISOString();
  await writeState();
  log(`ready on ${socketPath}`);

  setInterval(() => {
    if (!running && Date.now() - lastActivity > idleMinutes * 60_000) {
      void stop({ reason: `idle for ${idleMinutes} minutes` });
    }
  }, 30_000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => void stop({ reason: signal }));
}

start().catch(async error => {
  state.error = error instanceof Error ? error.stack || error.message : String(error);
  log(`start failed: ${state.error}`);
  await stop({ reason: 'start failed' });
});
