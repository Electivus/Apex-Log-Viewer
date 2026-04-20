import * as vscode from 'vscode';
import { localize } from '../../../../src/utils/localize';
import {
  listDebugLevels,
  getActiveUserDebugLevel,
  ensureDefaultTailDebugLevel
} from '../../../../src/salesforce/traceflags';
import type { OrgAuth } from '../../../../src/salesforce/types';
import { parseWebviewToExtensionMessage, type ExtensionToWebviewMessage } from '../shared/messages';
import { logInfo, logWarn } from '../../../../src/utils/logger';
import { safeSendEvent } from '../shared/telemetry';
import { ensureReplayDebuggerAvailable } from '../../../../src/utils/replayDebugger';
import { buildWebviewHtml } from '../../../../src/utils/webviewHtml';
import {
  DEFAULT_TAIL_BUFFER_LINES,
  MAX_TAIL_BUFFER_LINES,
  MIN_TAIL_BUFFER_LINES,
  TailService
} from '../../../../src/utils/tailService';
import { pickSelectedOrg } from '../../../../src/utils/orgs';
import { getNumberConfig, affectsConfiguration } from '../../../../src/utils/config';
import { getErrorMessage } from '../../../../src/utils/error';
import type { OrgItem } from '../shared/types';
import { LogViewerPanel } from '../panel/LogViewerPanel';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';
import { runtimeClient } from '../runtime/runtimeClient';
import { createWebviewPanelHost, createWebviewViewHost, type BoundWebviewHost } from './webviewHost';

export const WEBVIEW_STABLE_VISIBILITY_DELAY_MS = 200;
export const WEBVIEW_READY_TIMEOUT_MS = 5000;

export class SfLogTailViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sfLogTail';
  private view?: { webview: vscode.Webview };
  private host?: BoundWebviewHost;
  private readonly disposables: vscode.Disposable[] = [];
  private hostDisposables: vscode.Disposable[] = [];
  private readonly readyTimeoutListeners = new Set<() => void>();
  private disposed = false;
  private ready = false;
  private mountTimer: ReturnType<typeof setTimeout> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private mountSequence = 0;
  private selectedOrg: string | undefined;
  private tailService = new TailService(m => this.post(m));
  private loadingState = false;
  private orgsSnapshot: OrgItem[] = [];
  private hasOrgsSnapshot = false;
  private orgsBootstrapNeedsRefresh = false;
  private debugLevelsSnapshot: string[] = [];
  private activeDebugLevelSnapshot: string | undefined;
  private hasDebugLevelsSnapshot = false;
  private debugLevelsBootstrapNeedsRefresh = false;
  private tailRunningSnapshot = false;
  private tailBufferSizeSnapshot = DEFAULT_TAIL_BUFFER_LINES;
  private errorMessage: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.tailService.setOrg(this.selectedOrg);
    this.tailBufferSizeSnapshot = this.getTailBufferSize();
    this.tailService.setBufferLimit(this.tailBufferSizeSnapshot);

    // React to tail buffer size changes live
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsConfiguration(e, 'sfLogs.tailBufferSize')) {
          try {
            const size = this.getTailBufferSize();
            this.tailService.setBufferLimit(size);
            this.post({ type: 'tailConfig', tailBufferSize: size });
          } catch {
            // ignore
          }
        }
      })
    );

    // Track window activity to adapt polling cadence (requires VS Code 1.89+; @types 1.90)
    try {
      this.tailService.setWindowActive(vscode.window.state?.active ?? true);
      this.disposables.push(
        vscode.window.onDidChangeWindowState(e => {
          this.tailService.setWindowActive(e.active);
          if (e.active && this.tailService.isRunning() && !this.disposed) {
            this.tailService.promptPoll();
          }
        })
      );
    } catch (e) {
      logWarn('Tail: window state tracking failed ->', getErrorMessage(e));
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.bindHost(createWebviewViewHost(webviewView));
  }

  public resolveWebviewPanel(panel: vscode.WebviewPanel): void {
    this.bindHost(createWebviewPanelHost(panel));
  }

  private async onMessage(rawMessage: unknown): Promise<void> {
    const message = parseWebviewToExtensionMessage(rawMessage);
    const t = message?.type;
    if (t) {
      logInfo('Tail: received message from webview:', t);
    }
    if (!message) {
      logWarn('Tail: ignored invalid webview message');
      return;
    }
    if (message.type === 'ready') {
      await this.handleReadyMessage(message.mountSequence);
      return;
    }
    if (message.type === 'selectOrg') {
      const target = typeof message.target === 'string' ? message.target.trim() : undefined;
      const next = target || undefined;
      const prev = this.selectedOrg;
      this.setSelectedOrg(next);
      this.tailService.setOrg(next);
      if (prev !== next) {
        this.tailService.stop();
        this.clearTailReplayState();
      }
      logInfo('Tail: selected org set to', next || '(none)');
      this.post({ type: 'loading', value: true });
      try {
        await this.sendOrgs();
        await this.sendDebugLevels();
      } finally {
        this.post({ type: 'loading', value: false });
      }
      return;
    }
    if (message.type === 'openLog') {
      const id = message.logId;
      logInfo('Tail: openLog requested for', id);
      await this.openLog(id);
      return;
    }
    if (message.type === 'openDebugFlags') {
      logInfo('Tail: openDebugFlags requested');
      await DebugFlagsPanel.show({
        selectedOrg: this.selectedOrg,
        sourceView: 'tail'
      });
      return;
    }
    if (message.type === 'replay') {
      const id = message.logId;
      logInfo('Tail: replay requested for', id);
      await this.replayLog(id);
      return;
    }
    if (message.type === 'tailStart') {
      // Surface loading while ensuring TraceFlag and priming tail
      this.post({ type: 'loading', value: true });
      try {
        await this.tailService.start(typeof message.debugLevel === 'string' ? message.debugLevel.trim() : undefined);
      } finally {
        this.post({ type: 'loading', value: false });
      }
      return;
    }
    if (message.type === 'tailStop') {
      this.tailService.stop();
      return;
    }
    if (message.type === 'tailClear') {
      this.tailService.clearLogPaths();
      this.tailService.clearBufferedLines();
      this.post({ type: 'tailReset' });
      return;
    }
  }

  public getSelectedOrg(): string | undefined {
    return this.selectedOrg;
  }

  public isReady(): boolean {
    return this.ready && !this.disposed;
  }

  public onDidReadyTimeout(listener: () => void): vscode.Disposable {
    this.readyTimeoutListeners.add(listener);
    return {
      dispose: () => {
        this.readyTimeoutListeners.delete(listener);
      }
    };
  }

  public dispose(): void {
    this.disposed = true;
    this.ready = false;
    this.view = undefined;
    this.host = undefined;
    this.clearBootstrapTimers();
    this.tailService.stop();
    this.readyTimeoutListeners.clear();
    vscode.Disposable.from(...this.hostDisposables).dispose();
    this.hostDisposables = [];
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
  }

  private getHtmlForWebview(webview: vscode.Webview, mountSequence?: number): string {
    return buildWebviewHtml(
      webview,
      this.context.extensionUri,
      'tail.js',
      localize('salesforce.tail.view.name', 'Electivus Apex Logs Tail'),
      { mountSequence }
    );
  }

  private getPlaceholderHtml(): string {
    const title = this.escapeHtml(localize('salesforce.tail.view.name', 'Electivus Apex Logs Tail'));
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
  </head>
  <body></body>
</html>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private clearMountTimer(): void {
    if (this.mountTimer) {
      clearTimeout(this.mountTimer);
      this.mountTimer = undefined;
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
  }

  private clearBootstrapTimers(): void {
    this.clearMountTimer();
    this.clearReadyTimer();
  }

  private showPlaceholder(host: BoundWebviewHost): void {
    host.webview.html = this.getPlaceholderHtml();
  }

  private scheduleMount(host = this.host): void {
    if (!host || this.disposed || !host.visible) {
      return;
    }
    this.clearMountTimer();
    this.mountTimer = setTimeout(() => {
      this.mountTimer = undefined;
      if (this.host !== host || this.disposed || !host.visible) {
        return;
      }
      this.mountWebview(host);
    }, WEBVIEW_STABLE_VISIBILITY_DELAY_MS);
  }

  private mountWebview(host: BoundWebviewHost): void {
    this.ready = false;
    const mountId = ++this.mountSequence;
    host.webview.html = this.getHtmlForWebview(host.webview, mountId);
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = undefined;
      if (this.host !== host || this.disposed || this.ready || mountId !== this.mountSequence) {
        return;
      }
      logWarn(`Tail webview did not report ready within ${WEBVIEW_READY_TIMEOUT_MS}ms (${host.kind}).`);
      this.ready = false;
      this.showPlaceholder(host);
      if (host.kind === 'editor') {
        this.fireReadyTimeout();
      } else if (host.visible) {
        // Sidebar views need an internal remount because they do not recreate themselves.
        this.scheduleMount(host);
      }
    }, WEBVIEW_READY_TIMEOUT_MS);
    logInfo(`Tail webview mounted (${host.kind}).`);
  }

  private fireReadyTimeout(): void {
    for (const listener of [...this.readyTimeoutListeners]) {
      try {
        listener();
      } catch {}
    }
  }

  private handleVisibilityChange(host: BoundWebviewHost, visible: boolean): void {
    if (this.host !== host || this.disposed) {
      return;
    }
    if (!visible) {
      this.ready = false;
      this.clearBootstrapTimers();
      this.showPlaceholder(host);
      return;
    }
    this.scheduleMount(host);
  }

  private async handleReadyMessage(mountSequence?: number): Promise<void> {
    if (!this.host || this.disposed || this.ready) {
      return;
    }
    if (mountSequence === undefined) {
      if (this.mountSequence > 1) {
        logInfo(`Tail webview ignored unsequenced stale ready (${this.host.kind}).`);
        return;
      }
    } else if (mountSequence !== this.mountSequence) {
      logInfo(`Tail webview ignored stale ready (${this.host.kind}).`);
      return;
    }
    this.ready = true;
    this.clearReadyTimer();
    this.post({ type: 'init', locale: vscode.env.language });
    this.replaySnapshot();
    const needsBootstrap =
      !this.hasOrgsSnapshot ||
      !this.hasDebugLevelsSnapshot ||
      this.orgsBootstrapNeedsRefresh ||
      this.debugLevelsBootstrapNeedsRefresh;
    if (needsBootstrap) {
      await this.refreshViewState();
      return;
    }
    if (this.mountSequence > 1) {
      void this.refreshViewState({ showLoading: false });
    }
  }

  private replaySnapshot(): void {
    this.post({ type: 'loading', value: this.loadingState }, { replay: true });
    if (this.hasOrgsSnapshot) {
      this.post({ type: 'orgs', data: this.orgsSnapshot, selected: this.selectedOrg }, { replay: true });
    }
    if (this.hasDebugLevelsSnapshot) {
      this.post(
        { type: 'debugLevels', data: this.debugLevelsSnapshot, active: this.activeDebugLevelSnapshot },
        { replay: true }
      );
    }
    this.post({ type: 'tailConfig', tailBufferSize: this.tailBufferSizeSnapshot }, { replay: true });
    this.post({ type: 'tailStatus', running: this.tailRunningSnapshot }, { replay: true });
    const bufferedLines = this.tailService.getBufferedLines();
    if (bufferedLines.length > 0) {
      this.post({ type: 'tailReset' }, { replay: true });
      this.post({ type: 'tailData', lines: bufferedLines }, { replay: true });
    }
    if (this.errorMessage !== undefined) {
      this.post({ type: 'error', message: this.errorMessage }, { replay: true });
    }
  }

  private clearTailReplayState(): void {
    this.tailService.clearBufferedLines();
    this.post({ type: 'tailReset' });
  }

  private post(msg: ExtensionToWebviewMessage, options?: { replay?: boolean }): void {
    let shouldClearWebviewError = false;
    switch (msg.type) {
      case 'loading':
        this.loadingState = !!msg.value;
        break;
      case 'error':
        this.errorMessage = msg.message;
        break;
      case 'orgs':
        this.hasOrgsSnapshot = true;
        this.orgsSnapshot = Array.isArray(msg.data) ? [...msg.data] : [];
        this.selectedOrg = msg.selected;
        break;
      case 'debugLevels':
        this.hasDebugLevelsSnapshot = true;
        this.debugLevelsSnapshot = Array.isArray(msg.data) ? [...msg.data] : [];
        this.activeDebugLevelSnapshot = msg.active;
        break;
      case 'tailStatus':
        this.tailRunningSnapshot = !!msg.running;
        if (msg.running && !options?.replay && this.errorMessage !== undefined) {
          this.errorMessage = undefined;
          shouldClearWebviewError = true;
        }
        break;
      case 'tailData':
        if (Array.isArray(msg.lines) && msg.lines.length > 0 && !options?.replay && this.errorMessage !== undefined) {
          this.errorMessage = undefined;
          shouldClearWebviewError = true;
        }
        break;
      case 'tailConfig':
        this.tailBufferSizeSnapshot = msg.tailBufferSize;
        break;
    }
    this.view?.webview.postMessage(msg);
    if (shouldClearWebviewError) {
      this.view?.webview.postMessage({ type: 'error', message: undefined });
    }
  }

  private getTailBufferSize(): number {
    return getNumberConfig(
      'sfLogs.tailBufferSize',
      DEFAULT_TAIL_BUFFER_LINES,
      MIN_TAIL_BUFFER_LINES,
      MAX_TAIL_BUFFER_LINES
    );
  }

  public async sendOrgs(): Promise<void> {
    const t0 = Date.now();
    try {
      const orgs = await runtimeClient.orgList();
      logInfo('Tail: sendOrgs ->', orgs.length, 'org(s)');
      const selected = pickSelectedOrg(orgs, this.selectedOrg);
      this.setSelectedOrg(selected);
      this.tailService.setOrg(selected);
      this.orgsBootstrapNeedsRefresh = false;
      this.post({ type: 'orgs', data: orgs, selected });
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('orgs.list', { outcome: 'ok', view: 'tail' }, { durationMs, count: orgs.length });
      } catch {}
    } catch (e) {
      logWarn('Tail: sendOrgs failed ->', getErrorMessage(e));
      this.orgsBootstrapNeedsRefresh = true;
      this.post({ type: 'orgs', data: [], selected: this.selectedOrg });
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('orgs.list', { outcome: 'error', view: 'tail' }, { durationMs });
      } catch {}
    }
  }

  public async refreshViewState(options?: { showLoading?: boolean }): Promise<void> {
    if (!this.view || this.disposed) {
      return;
    }

    const showLoading = options?.showLoading !== false;
    if (showLoading) {
      this.post({ type: 'loading', value: true });
    }
    try {
      await this.sendOrgs();
      await this.sendDebugLevels();
      this.post({ type: 'tailConfig', tailBufferSize: this.getTailBufferSize() });
      this.post({ type: 'tailStatus', running: this.tailService.isRunning() });
    } finally {
      if (showLoading) {
        this.post({ type: 'loading', value: false });
      }
    }
  }

  public setSelectedOrg(username?: string): void {
    this.selectedOrg = username;
  }

  public async syncSelectedOrg(username?: string): Promise<void> {
    const next = typeof username === 'string' ? username.trim() || undefined : undefined;
    if (!next || next === this.selectedOrg) {
      return;
    }

    const previous = this.selectedOrg;
    this.setSelectedOrg(next);
    this.tailService.setOrg(next);
    if (previous !== next) {
      this.tailService.stop();
      this.clearTailReplayState();
    }

    if (!this.view || this.disposed) {
      return;
    }

    await this.refreshViewState();
  }

  private async sendDebugLevels(): Promise<void> {
    const t0 = Date.now();
    // Load auth; if this fails, surface empty list once
    let auth: OrgAuth;
    try {
      auth = await runtimeClient.getOrgAuth({ username: this.selectedOrg });
    } catch (e) {
      logWarn('Tail: could not load auth for debug levels ->', getErrorMessage(e));
      this.debugLevelsBootstrapNeedsRefresh = true;
      this.post({ type: 'debugLevels', data: [] });
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('debugLevels.load', { outcome: 'error' }, { durationMs });
      } catch {}
      return;
    }

    // Fetch levels and active selection concurrently so one failure
    // doesn't block the other and result in an empty combobox.
    const [levelsResult, activeLevel] = await Promise.all([
      listDebugLevels(auth)
        .then(data => ({ ok: true as const, data }))
        .catch(() => {
          logWarn('Tail: listDebugLevels failed');
          return { ok: false as const, data: [] as string[] };
        }),
      getActiveUserDebugLevel(auth).catch(() => {
        logWarn('Tail: getActiveUserDebugLevel failed');
        return undefined as string | undefined;
      })
    ]);

    // Ensure the active value appears in the list if present
    let active = activeLevel;
    const out = Array.isArray(levelsResult.data) ? [...levelsResult.data] : [];
    if (active && !out.includes(active)) {
      out.unshift(active);
    }
    if (levelsResult.ok && out.length === 0) {
      try {
        const ensuredLevel = await ensureDefaultTailDebugLevel(auth);
        out.push(ensuredLevel);
        active = active || ensuredLevel;
      } catch (e) {
        logWarn('Tail: ensure default debug level failed ->', getErrorMessage(e));
      }
    }
    if (!active && out.length > 0) {
      active = out[0];
    }
    this.debugLevelsBootstrapNeedsRefresh = out.length === 0;
    this.post({ type: 'debugLevels', data: out, active });
    try {
      const durationMs = Date.now() - t0;
      safeSendEvent('debugLevels.load', { outcome: 'ok' }, { durationMs, count: out.length });
    } catch {}
  }
  // Tail webview actions
  private async openLog(logId: string): Promise<void> {
    const t0 = Date.now();
    this.post({ type: 'loading', value: true });
    try {
      const filePath = await this.tailService.ensureLogSaved(logId);
      await LogViewerPanel.show({ logId, filePath });
      logInfo('Tail: opened log', logId);
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('log.open', { outcome: 'ok', view: 'tail' }, { durationMs });
      } catch {}
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('Tail: openLog failed ->', msg);
      this.post({ type: 'error', message: msg });
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('log.open', { view: 'tail', outcome: 'error' }, { durationMs });
      } catch {}
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private async replayLog(logId: string): Promise<void> {
    const t0 = Date.now();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: localize('replayStarting', 'Starting Apex Replay Debugger…'),
          cancellable: true
        },
        async (_progress, ct) => {
          const controller = new AbortController();
          ct.onCancellationRequested(() => controller.abort());
          const ok = await ensureReplayDebuggerAvailable();
          if (!ok || ct.isCancellationRequested) {
            return;
          }
          const filePath = await this.tailService.ensureLogSaved(logId, controller.signal);
          if (ct.isCancellationRequested) {
            return;
          }
          const uri = vscode.Uri.file(filePath);
          try {
            await vscode.commands.executeCommand('sf.launch.replay.debugger.logfile', uri);
          } catch (e) {
            if (!controller.signal.aborted) {
              logWarn('Tail: sf.launch.replay.debugger.logfile failed ->', getErrorMessage(e));
              await vscode.commands.executeCommand('sfdx.launch.replay.debugger.logfile', uri);
            }
          }
        }
      );
      logInfo('Tail: replay requested for', logId);
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('logs.replay', { view: 'tail', outcome: 'ok' }, { durationMs });
      } catch {}
    } catch (e) {
      if (this.isAbortLikeError(e)) {
        // cancellation; no error message
      } else {
        const msg = getErrorMessage(e);
        logWarn('Tail: replay failed ->', msg);
        this.post({ type: 'error', message: msg });
        try {
          const durationMs = Date.now() - t0;
          safeSendEvent('logs.replay', { view: 'tail', outcome: 'error' }, { durationMs });
        } catch {}
      }
    }
  }

  private isAbortLikeError(err: unknown, message?: string): boolean {
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      return true;
    }

    const normalized = String(message ?? getErrorMessage(err) ?? '').toLowerCase();
    return normalized.includes('abort') || normalized.includes('canceled') || normalized.includes('cancelled');
  }

  private bindHost(host: BoundWebviewHost): void {
    vscode.Disposable.from(...this.hostDisposables).dispose();
    this.hostDisposables = [];
    this.host = host;
    this.view = host;
    this.disposed = false;
    this.ready = false;
    this.clearBootstrapTimers();
    host.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    this.showPlaceholder(host);
    logInfo(`Tail webview resolved (${host.kind}).`);

    this.hostDisposables.push(
      host.onDidDispose(() => {
        if (this.host !== host) {
          return;
        }
        this.disposed = true;
        this.ready = false;
        this.view = undefined;
        this.host = undefined;
        this.clearBootstrapTimers();
        // Stop timers and clear caches, but keep controller disposal separate.
        this.tailService.stop();
        logInfo(`Tail webview disposed; stopped tail (${host.kind}).`);
      }),
      host.onDidChangeVisibility(visible => {
        this.handleVisibilityChange(host, visible);
      }),
      host.webview.onDidReceiveMessage(message => {
        void this.onMessage(message);
      })
    );

    this.handleVisibilityChange(host, host.visible);
  }
}
