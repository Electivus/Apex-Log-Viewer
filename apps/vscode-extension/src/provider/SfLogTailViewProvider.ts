import * as vscode from 'vscode';
import { localize } from '../host/utils/localize';
import { listDebugLevels, getActiveUserDebugLevel, ensureDefaultTailDebugLevel } from '../host/salesforce/traceflags';
import type { OrgAuth } from '../host/salesforce/types';
import {
  parseWebviewToExtensionMessage,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage
} from '../shared/messages';
import { logInfo, logWarn } from '../host/utils/logger';
import { safeSendEvent } from '../shared/telemetry';
import { getTelemetryErrorCode } from '../shared/telemetryErrorCodes';
import { ensureReplayDebuggerAvailable } from '../host/utils/replayDebugger';
import { buildWebviewHtml } from '../host/utils/webviewHtml';
import {
  DEFAULT_TAIL_BUFFER_LINES,
  MAX_TAIL_BUFFER_LINES,
  MIN_TAIL_BUFFER_LINES,
  TailService
} from '../host/utils/tailService';
import { pickSelectedOrg } from '../host/utils/orgs';
import { getNumberConfig, affectsConfiguration } from '../host/utils/config';
import { getErrorMessage } from '../host/utils/error';
import type { OrgItem } from '../shared/types';
import { LogViewerPanel } from '../panel/LogViewerPanel';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';
import { runtimeClient } from '../runtime/runtimeClient';
import { createWebviewPanelHost, createWebviewViewHost, type BoundWebviewHost } from './webviewHost';
import { recordWebviewEvent, type WebviewProviderDiagnosticState } from '../shared/webviewDiagnostics';
import {
  createWebviewSession,
  type WebviewDeliveryClassification,
  type WebviewSession,
  type WebviewSessionDiagnostic,
  type WebviewSessionDetachReason,
  type WebviewSessionInbound
} from './webviewSession';

export class SfLogTailViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'electivus.apexLogViewer.tailView';
  private view?: { webview: vscode.Webview };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly session: WebviewSession<ExtensionToWebviewMessage, BoundWebviewHost>;
  private sessionDiagnostic: WebviewSessionDiagnostic | undefined;
  private disposed = false;
  private selectedOrg: string | undefined;
  private tailService = new TailService(m => this.post(m, 'replayable'));
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
  private tailResetNeedsReplay = false;
  private errorMessage: string | undefined;
  private errorClearNeedsReplay = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.tailService.setOrg(this.selectedOrg);
    this.tailBufferSizeSnapshot = this.getTailBufferSize();
    this.tailService.setBufferLimit(this.tailBufferSizeSnapshot);
    this.session = createWebviewSession({
      mount: (host, generation) => {
        host.webview.html = this.getHtmlForWebview(host.webview, generation);
        logInfo('Tail webview mounted.');
      },
      getReplaySnapshot: () => this.getReplaySnapshot(),
      validateInbound: message => this.validateInbound(message),
      onDetach: reason => this.handleSessionDetach(reason),
      onMessage: message => this.handleMessage(message),
      onReady: () => this.bootstrapWebview(),
      onReplaySucceeded: () => {
        this.tailResetNeedsReplay = false;
        if (this.errorMessage === undefined) {
          this.errorClearNeedsReplay = false;
        }
      },
      onDiagnostic: diagnostic => this.handleSessionDiagnostic(diagnostic)
    });

    // React to tail buffer size changes live
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsConfiguration(e, 'electivus.apexLogViewer.tail.bufferLines')) {
          try {
            const size = this.getTailBufferSize();
            this.tailService.setBufferLimit(size);
            this.post({ type: 'tailConfig', tailBufferSize: size }, 'replayable');
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
    let host: BoundWebviewHost;
    host = createWebviewViewHost(webviewView, () => this.showPlaceholder(host));
    this.bindHost(host);
  }

  public resolveWebviewPanel(panel: vscode.WebviewPanel, replaceAfterReadyTimeout?: () => void | Promise<void>): void {
    this.bindHost(createWebviewPanelHost(panel, replaceAfterReadyTimeout));
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    logInfo('Tail: received message from webview:', message.type);
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
      this.post({ type: 'loading', value: true }, 'replayable');
      try {
        await this.sendOrgs();
        await this.sendDebugLevels();
      } finally {
        this.post({ type: 'loading', value: false }, 'replayable');
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
      this.post({ type: 'loading', value: true }, 'replayable');
      try {
        await this.tailService.start(typeof message.debugLevel === 'string' ? message.debugLevel.trim() : undefined);
      } finally {
        this.post({ type: 'loading', value: false }, 'replayable');
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
      this.post({ type: 'tailReset' }, 'replayable');
      return;
    }
  }

  public getSelectedOrg(): string | undefined {
    return this.selectedOrg;
  }

  public isReady(): boolean {
    return this.session.ready && !this.disposed;
  }

  public getWebviewDiagnosticState(): WebviewProviderDiagnosticState {
    const diagnostic = this.sessionDiagnostic;
    return {
      surface: 'tail',
      hasHost: !!this.view,
      visible: diagnostic?.visible,
      ready: this.session.ready,
      disposed: this.disposed,
      contentMounted: diagnostic?.contentMounted ?? false,
      mountSequence: diagnostic?.generation ?? 0,
      mountTimerActive: diagnostic?.mountTimerActive ?? false,
      readyTimerActive: diagnostic?.readyTimerActive ?? false,
      needsReplayOnVisible: diagnostic?.needsReplay ?? true,
      snapshots: {
        loading: this.loadingState,
        hasOrgsSnapshot: this.hasOrgsSnapshot,
        orgCount: this.orgsSnapshot.length,
        hasDebugLevelsSnapshot: this.hasDebugLevelsSnapshot,
        debugLevelCount: this.debugLevelsSnapshot.length,
        tailRunning: this.tailRunningSnapshot,
        tailBufferSize: this.tailBufferSizeSnapshot,
        bufferedLineCount: this.tailService.getBufferedLines().length,
        tailResetNeedsReplay: this.tailResetNeedsReplay,
        hasError: this.errorMessage !== undefined,
        errorClearNeedsReplay: this.errorClearNeedsReplay,
        sessionEvent: diagnostic?.event,
        sessionGeneration: diagnostic?.generation,
        sessionRetryAttempt: diagnostic?.attempt,
        sessionDeliveryClassification: diagnostic?.classification
      }
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.view = undefined;
    this.session.dispose();
    this.tailService.stop();
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

  private showPlaceholder(host: BoundWebviewHost): void {
    host.webview.html = this.getPlaceholderHtml();
    recordWebviewEvent({
      surface: 'tail',
      event: 'placeholder',
      visible: host.visible,
      ready: this.session.ready,
      contentMounted: false
    });
  }

  private async bootstrapWebview(): Promise<void> {
    const needsBootstrap =
      !this.hasOrgsSnapshot ||
      !this.hasDebugLevelsSnapshot ||
      this.orgsBootstrapNeedsRefresh ||
      this.debugLevelsBootstrapNeedsRefresh;
    if (needsBootstrap) {
      await this.refreshViewState();
      return;
    }
    if ((this.sessionDiagnostic?.generation ?? 0) > 1) {
      void this.refreshViewState({ showLoading: false });
    }
  }

  private getReplaySnapshot(): readonly ExtensionToWebviewMessage[] {
    const snapshot: ExtensionToWebviewMessage[] = [
      { type: 'init', locale: vscode.env.language },
      { type: 'loading', value: this.loadingState }
    ];
    if (this.hasOrgsSnapshot) {
      snapshot.push({ type: 'orgs', data: this.orgsSnapshot, selected: this.selectedOrg });
    }
    if (this.hasDebugLevelsSnapshot) {
      snapshot.push({
        type: 'debugLevels',
        data: this.debugLevelsSnapshot,
        active: this.activeDebugLevelSnapshot
      });
    }
    snapshot.push(
      { type: 'tailConfig', tailBufferSize: this.tailBufferSizeSnapshot },
      { type: 'tailStatus', running: this.tailRunningSnapshot }
    );
    const bufferedLines = this.tailService.getBufferedLines();
    if (bufferedLines.length > 0) {
      snapshot.push({ type: 'tailReset' }, { type: 'tailData', lines: bufferedLines });
    } else if (this.tailResetNeedsReplay) {
      snapshot.push({ type: 'tailReset' });
    }
    if (this.errorMessage !== undefined) {
      snapshot.push({ type: 'error', message: this.errorMessage });
    } else if (this.errorClearNeedsReplay) {
      snapshot.push({ type: 'error', message: undefined });
    }
    return snapshot;
  }

  private clearTailReplayState(): void {
    this.tailService.clearBufferedLines();
    this.post({ type: 'tailReset' }, 'replayable');
  }

  private post(msg: ExtensionToWebviewMessage, classification: WebviewDeliveryClassification): void {
    let shouldClearWebviewError = false;
    switch (msg.type) {
      case 'loading':
        this.loadingState = !!msg.value;
        break;
      case 'error':
        this.errorMessage = msg.message;
        if (msg.message !== undefined) {
          this.errorClearNeedsReplay = false;
        }
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
        if (msg.running && this.errorMessage !== undefined) {
          this.errorMessage = undefined;
          shouldClearWebviewError = true;
        }
        break;
      case 'tailData':
        if (Array.isArray(msg.lines) && msg.lines.length > 0 && this.errorMessage !== undefined) {
          this.errorMessage = undefined;
          shouldClearWebviewError = true;
        }
        break;
      case 'tailReset':
        this.tailResetNeedsReplay = true;
        break;
      case 'tailConfig':
        this.tailBufferSizeSnapshot = msg.tailBufferSize;
        break;
    }
    const visibleAtDelivery = this.session.visible === true;
    const delivery = this.session.deliver(msg, classification);
    if (msg.type === 'tailReset') {
      void delivery.then(accepted => {
        if (accepted && visibleAtDelivery) {
          this.tailResetNeedsReplay = false;
        }
      });
    } else if (msg.type === 'error' && msg.message === undefined) {
      void delivery.then(accepted => {
        if (accepted && visibleAtDelivery && this.errorMessage === undefined) {
          this.errorClearNeedsReplay = false;
        }
      });
    }
    if (shouldClearWebviewError) {
      this.errorClearNeedsReplay = true;
      this.post({ type: 'error', message: undefined }, 'replayable');
    }
  }

  private getTailBufferSize(): number {
    return getNumberConfig(
      'electivus.apexLogViewer.tail.bufferLines',
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
      this.post({ type: 'orgs', data: orgs, selected }, 'replayable');
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('orgs.list', { outcome: 'ok', view: 'tail' }, { durationMs, count: orgs.length });
      } catch {}
    } catch (e) {
      logWarn('Tail: sendOrgs failed ->', getErrorMessage(e));
      this.orgsBootstrapNeedsRefresh = true;
      this.post({ type: 'orgs', data: [], selected: this.selectedOrg }, 'replayable');
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('orgs.list', { outcome: 'error', view: 'tail', code: getTelemetryErrorCode(e) }, { durationMs });
      } catch {}
    }
  }

  public async refreshViewState(options?: { showLoading?: boolean }): Promise<void> {
    if (!this.view || this.disposed) {
      return;
    }

    const showLoading = options?.showLoading !== false;
    if (showLoading) {
      this.post({ type: 'loading', value: true }, 'replayable');
    }
    try {
      await this.sendOrgs();
      await this.sendDebugLevels();
      this.post({ type: 'tailConfig', tailBufferSize: this.getTailBufferSize() }, 'replayable');
      this.post({ type: 'tailStatus', running: this.tailService.isRunning() }, 'replayable');
    } finally {
      if (showLoading) {
        this.post({ type: 'loading', value: false }, 'replayable');
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
      this.post({ type: 'debugLevels', data: [] }, 'replayable');
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('debugLevels.load', { outcome: 'error', code: getTelemetryErrorCode(e) }, { durationMs });
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
    this.post({ type: 'debugLevels', data: out, active }, 'replayable');
    try {
      const durationMs = Date.now() - t0;
      safeSendEvent('debugLevels.load', { outcome: 'ok' }, { durationMs, count: out.length });
    } catch {}
  }
  // Tail webview actions
  private async openLog(logId: string): Promise<void> {
    const t0 = Date.now();
    this.post({ type: 'loading', value: true }, 'replayable');
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
      this.post({ type: 'error', message: msg }, 'replayable');
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('log.open', { view: 'tail', outcome: 'error' }, { durationMs });
      } catch {}
    } finally {
      this.post({ type: 'loading', value: false }, 'replayable');
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
        this.post({ type: 'error', message: msg }, 'replayable');
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

  private validateInbound(message: unknown): WebviewSessionInbound<WebviewToExtensionMessage> | undefined {
    const parsed = parseWebviewToExtensionMessage(message);
    if (!parsed) {
      logWarn('Tail: ignored invalid webview message');
      return undefined;
    }
    return parsed.type === 'ready'
      ? {
          kind: 'ready',
          ...(parsed.mountSequence !== undefined ? { generation: parsed.mountSequence } : {})
        }
      : { kind: 'message', message: parsed };
  }

  private handleSessionDiagnostic(diagnostic: WebviewSessionDiagnostic): void {
    this.sessionDiagnostic = diagnostic;
    if (diagnostic.event === 'ready') {
      logInfo('Tail webview ready.');
    }
    recordWebviewEvent({
      surface: 'tail',
      event: diagnostic.event,
      mountSequence: diagnostic.generation,
      visible: diagnostic.visible,
      ready: diagnostic.ready,
      contentMounted: diagnostic.contentMounted,
      details: {
        ...(diagnostic.classification ? { classification: diagnostic.classification } : {}),
        ...(diagnostic.attempt !== undefined ? { attempt: diagnostic.attempt } : {}),
        ...(diagnostic.callback ? { callback: diagnostic.callback } : {})
      }
    });
  }

  private handleSessionDetach(reason: WebviewSessionDetachReason): void {
    this.view = undefined;
    if (reason === 'hostDisposed' || reason === 'explicit') {
      this.tailService.stop();
    }
    logInfo(
      `Tail webview detached${reason === 'hostDisposed' || reason === 'explicit' ? '; stopped tail' : ''} (${reason}).`
    );
  }

  private bindHost(host: BoundWebviewHost): void {
    if (this.disposed) {
      return;
    }
    host.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    this.showPlaceholder(host);
    this.session.bind(host);
    this.view = host;
    logInfo('Tail webview resolved.');
  }
}
