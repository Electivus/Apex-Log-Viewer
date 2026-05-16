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
import { getTelemetryErrorCode } from '../shared/telemetryErrorCodes';
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
import { recordWebviewEvent, type WebviewProviderDiagnosticState } from '../shared/webviewDiagnostics';

// Corporate-managed notebooks can take several seconds to initialize VS Code
// webviews and their internal service worker. Keep these windows generous so a
// slow-but-healthy startup is not torn down into a remount loop.
export const WEBVIEW_STABLE_VISIBILITY_DELAY_MS = 1000;
export const WEBVIEW_READY_TIMEOUT_MS = 30000;
const WEBVIEW_REPLAY_RETRY_DELAY_MS = 250;
const WEBVIEW_REPLAY_MAX_RETRIES = 3;
const TAIL_REPLAYABLE_VISIBLE_UPDATE_TYPES = new Set<ExtensionToWebviewMessage['type']>([
  'loading',
  'error',
  'orgs',
  'debugLevels',
  'tailStatus',
  'tailData',
  'tailReset',
  'tailConfig'
]);

interface ReplayDeliveryBatch {
  pending: number;
  dropped: boolean;
  resetRetryBudgetOnSuccess: boolean;
}

interface WebviewPostOptions {
  replay?: boolean;
  requeueReplayOnDrop?: boolean;
  onDelivered?: () => void;
  replayBatch?: ReplayDeliveryBatch;
}

export class SfLogTailViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sfLogTail';
  private view?: { webview: vscode.Webview };
  private host?: BoundWebviewHost;
  private readonly disposables: vscode.Disposable[] = [];
  private hostDisposables: vscode.Disposable[] = [];
  private readonly readyTimeoutListeners = new Set<() => void>();
  private disposed = false;
  private ready = false;
  private contentMounted = false;
  private needsReplayOnVisible = false;
  private mountTimer: ReturnType<typeof setTimeout> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private visibleReplayRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private visibleReplayRetryAttempts = 0;
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
  private tailResetNeedsReplay = false;
  private errorMessage: string | undefined;
  private errorClearNeedsReplay = false;

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

  public getWebviewDiagnosticState(): WebviewProviderDiagnosticState {
    return {
      surface: 'tail',
      hasHost: !!this.host,
      hostKind: this.host?.kind,
      visible: this.host?.visible,
      ready: this.ready,
      disposed: this.disposed,
      contentMounted: this.contentMounted,
      mountSequence: this.mountSequence,
      mountTimerActive: this.mountTimer !== undefined,
      readyTimerActive: this.readyTimer !== undefined,
      needsReplayOnVisible: this.needsReplayOnVisible,
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
        visibleReplayRetryTimerActive: this.visibleReplayRetryTimer !== undefined,
        visibleReplayRetryAttempts: this.visibleReplayRetryAttempts
      }
    };
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
    this.contentMounted = false;
    this.needsReplayOnVisible = false;
    this.visibleReplayRetryAttempts = 0;
    this.tailResetNeedsReplay = false;
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

  private clearVisibleReplayRetryTimer(): void {
    if (this.visibleReplayRetryTimer) {
      clearTimeout(this.visibleReplayRetryTimer);
      this.visibleReplayRetryTimer = undefined;
    }
  }

  private clearBootstrapTimers(): void {
    this.clearMountTimer();
    this.clearReadyTimer();
    this.clearVisibleReplayRetryTimer();
  }

  private showPlaceholder(host: BoundWebviewHost): void {
    this.contentMounted = false;
    host.webview.html = this.getPlaceholderHtml();
    recordWebviewEvent({
      surface: 'tail',
      event: 'placeholder',
      hostKind: host.kind,
      mountSequence: this.mountSequence,
      visible: host.visible,
      ready: this.ready,
      contentMounted: this.contentMounted
    });
  }

  private scheduleMount(host = this.host): void {
    if (!host || this.disposed || !host.visible) {
      return;
    }
    this.clearMountTimer();
    recordWebviewEvent({
      surface: 'tail',
      event: 'mountScheduled',
      hostKind: host.kind,
      mountSequence: this.mountSequence,
      visible: host.visible,
      ready: this.ready,
      contentMounted: this.contentMounted,
      details: { delayMs: WEBVIEW_STABLE_VISIBILITY_DELAY_MS }
    });
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
    this.needsReplayOnVisible = false;
    this.visibleReplayRetryAttempts = 0;
    const mountId = ++this.mountSequence;
    this.contentMounted = true;
    host.webview.html = this.getHtmlForWebview(host.webview, mountId);
    this.startReadyTimer(host, mountId);
    recordWebviewEvent({
      surface: 'tail',
      event: 'mounted',
      hostKind: host.kind,
      mountSequence: mountId,
      visible: host.visible,
      ready: this.ready,
      contentMounted: this.contentMounted
    });
    logInfo(`Tail webview mounted (${host.kind}).`);
  }

  private startReadyTimer(host: BoundWebviewHost, mountId: number): void {
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = undefined;
      if (this.host !== host || this.disposed || this.ready || mountId !== this.mountSequence) {
        return;
      }
      logWarn(`Tail webview did not report ready within ${WEBVIEW_READY_TIMEOUT_MS}ms (${host.kind}).`);
      recordWebviewEvent({
        surface: 'tail',
        event: 'readyTimeout',
        hostKind: host.kind,
        mountSequence: mountId,
        visible: host.visible,
        ready: this.ready,
        contentMounted: this.contentMounted,
        details: { timeoutMs: WEBVIEW_READY_TIMEOUT_MS }
      });
      this.ready = false;
      this.showPlaceholder(host);
      if (host.kind === 'editor') {
        this.fireReadyTimeout();
      } else if (host.visible) {
        // Sidebar views need an internal remount because they do not recreate themselves.
        this.scheduleMount(host);
      }
    }, WEBVIEW_READY_TIMEOUT_MS);
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
      this.clearBootstrapTimers();
      recordWebviewEvent({
        surface: 'tail',
        event: 'hidden',
        hostKind: host.kind,
        mountSequence: this.mountSequence,
        visible,
        ready: this.ready,
        contentMounted: this.contentMounted
      });
      return;
    }
    recordWebviewEvent({
      surface: 'tail',
      event: 'visible',
      hostKind: host.kind,
      mountSequence: this.mountSequence,
      visible,
      ready: this.ready,
      contentMounted: this.contentMounted,
      details: { needsReplayOnVisible: this.needsReplayOnVisible }
    });
    if (this.ready) {
      if (this.needsReplayOnVisible) {
        this.replayRetainedState(host, visible, 'replayedOnVisible', true);
      }
      return;
    }
    if (this.contentMounted && this.mountSequence > 0) {
      this.startReadyTimer(host, this.mountSequence);
      recordWebviewEvent({
        surface: 'tail',
        event: 'resumedPendingReady',
        hostKind: host.kind,
        mountSequence: this.mountSequence,
        visible,
        ready: this.ready,
        contentMounted: this.contentMounted
      });
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
        recordWebviewEvent({
          surface: 'tail',
          event: 'ignoredUnsequencedReady',
          hostKind: this.host.kind,
          mountSequence: this.mountSequence,
          visible: this.host.visible,
          ready: this.ready,
          contentMounted: this.contentMounted
        });
        return;
      }
    } else if (mountSequence !== this.mountSequence) {
      logInfo(`Tail webview ignored stale ready (${this.host.kind}).`);
      recordWebviewEvent({
        surface: 'tail',
        event: 'ignoredStaleReady',
        hostKind: this.host.kind,
        mountSequence: this.mountSequence,
        visible: this.host.visible,
        ready: this.ready,
        contentMounted: this.contentMounted,
        details: { receivedMountSequence: mountSequence }
      });
      return;
    }
    this.ready = true;
    this.clearReadyTimer();
    recordWebviewEvent({
      surface: 'tail',
      event: 'ready',
      hostKind: this.host.kind,
      mountSequence: this.mountSequence,
      visible: this.host.visible,
      ready: this.ready,
      contentMounted: this.contentMounted
    });
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

  private replayRetainedState(
    host: BoundWebviewHost,
    visible: boolean,
    event: string,
    resetRetryBudget: boolean
  ): void {
    if (resetRetryBudget) {
      this.visibleReplayRetryAttempts = 0;
    }
    const replayBatch: ReplayDeliveryBatch = {
      pending: 0,
      dropped: false,
      resetRetryBudgetOnSuccess: !resetRetryBudget
    };
    this.needsReplayOnVisible = false;
    this.post({ type: 'init', locale: vscode.env.language }, { requeueReplayOnDrop: true, replayBatch });
    this.replaySnapshot({ requeueReplayOnDrop: true, replayBatch });
    recordWebviewEvent({
      surface: 'tail',
      event,
      hostKind: host.kind,
      mountSequence: this.mountSequence,
      visible,
      ready: this.ready,
      contentMounted: this.contentMounted,
      details: { retryAttempts: this.visibleReplayRetryAttempts }
    });
  }

  private replaySnapshot(options?: WebviewPostOptions): void {
    const replayOptions: WebviewPostOptions = {
      replay: true,
      requeueReplayOnDrop: options?.requeueReplayOnDrop,
      replayBatch: options?.replayBatch
    };
    this.post({ type: 'loading', value: this.loadingState }, replayOptions);
    if (this.hasOrgsSnapshot) {
      this.post({ type: 'orgs', data: this.orgsSnapshot, selected: this.selectedOrg }, replayOptions);
    }
    if (this.hasDebugLevelsSnapshot) {
      this.post(
        { type: 'debugLevels', data: this.debugLevelsSnapshot, active: this.activeDebugLevelSnapshot },
        replayOptions
      );
    }
    this.post({ type: 'tailConfig', tailBufferSize: this.tailBufferSizeSnapshot }, replayOptions);
    this.post({ type: 'tailStatus', running: this.tailRunningSnapshot }, replayOptions);
    const bufferedLines = this.tailService.getBufferedLines();
    if (bufferedLines.length > 0) {
      this.post({ type: 'tailReset' }, replayOptions);
      this.post({ type: 'tailData', lines: bufferedLines }, replayOptions);
    } else if (this.tailResetNeedsReplay) {
      this.post({ type: 'tailReset' }, replayOptions);
    }
    if (this.errorMessage !== undefined) {
      this.post({ type: 'error', message: this.errorMessage }, replayOptions);
    } else if (this.errorClearNeedsReplay) {
      this.post(
        { type: 'error', message: undefined },
        {
          ...replayOptions,
          onDelivered: () => {
            if (this.errorMessage === undefined) {
              this.errorClearNeedsReplay = false;
            }
          }
        }
      );
    }
  }

  private clearTailReplayState(): void {
    this.tailService.clearBufferedLines();
    this.post({ type: 'tailReset' });
  }

  private settleReplayDeliveryBatch(batch: ReplayDeliveryBatch | undefined): void {
    if (!batch) {
      return;
    }
    batch.pending = Math.max(0, batch.pending - 1);
    if (batch.pending > 0) {
      return;
    }
    if (!batch.dropped && batch.resetRetryBudgetOnSuccess && !this.needsReplayOnVisible) {
      this.visibleReplayRetryAttempts = 0;
      recordWebviewEvent({
        surface: 'tail',
        event: 'replayRetryBudgetResetAfterDelivery',
        hostKind: this.host?.kind,
        mountSequence: this.mountSequence,
        visible: this.host?.visible,
        ready: this.ready,
        contentMounted: this.contentMounted
      });
    }
  }

  private post(msg: ExtensionToWebviewMessage, options?: WebviewPostOptions): void {
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
      case 'tailReset':
        if (!options?.replay) {
          this.tailResetNeedsReplay = true;
        }
        break;
      case 'tailConfig':
        this.tailBufferSizeSnapshot = msg.tailBufferSize;
        break;
    }
    const visible = this.host?.visible ?? false;
    if (this.host && !visible && !options?.replay) {
      this.needsReplayOnVisible = true;
      this.visibleReplayRetryAttempts = 0;
      recordWebviewEvent({
        surface: 'tail',
        event: 'messagePostedWhileHidden',
        hostKind: this.host.kind,
        mountSequence: this.mountSequence,
        messageType: msg.type,
        visible,
        ready: this.ready,
        contentMounted: this.contentMounted
      });
    }
    const postContext = {
      hostKind: this.host?.kind,
      mountSequence: this.mountSequence,
      visible: this.host?.visible,
      ready: this.ready,
      contentMounted: this.contentMounted
    };
    const scheduleVisibleReplayRetry = () => {
      if (
        !postContext.visible ||
        !this.host ||
        !this.host.visible ||
        !this.ready ||
        this.visibleReplayRetryTimer ||
        this.visibleReplayRetryAttempts >= WEBVIEW_REPLAY_MAX_RETRIES
      ) {
        return;
      }

      const host = this.host;
      const mountSequence = this.mountSequence;
      const attempt = ++this.visibleReplayRetryAttempts;
      this.visibleReplayRetryTimer = setTimeout(() => {
        this.visibleReplayRetryTimer = undefined;
        if (
          this.disposed ||
          this.host !== host ||
          !host.visible ||
          !this.ready ||
          mountSequence !== this.mountSequence ||
          !this.needsReplayOnVisible
        ) {
          return;
        }
        this.replayRetainedState(host, true, 'retriedReplayAfterDroppedPost', false);
      }, WEBVIEW_REPLAY_RETRY_DELAY_MS);
      recordWebviewEvent({
        surface: 'tail',
        event: 'scheduledReplayRetryAfterDroppedPost',
        hostKind: postContext.hostKind,
        mountSequence: postContext.mountSequence,
        messageType: msg.type,
        visible: postContext.visible,
        ready: postContext.ready,
        contentMounted: postContext.contentMounted,
        details: { attempt, delayMs: WEBVIEW_REPLAY_RETRY_DELAY_MS }
      });
    };
    const requeueReplay = () => {
      const requeueReason = options?.requeueReplayOnDrop
        ? 'explicit'
        : !options?.replay &&
            postContext.visible === true &&
            postContext.ready === true &&
            TAIL_REPLAYABLE_VISIBLE_UPDATE_TYPES.has(msg.type)
          ? 'visibleUpdate'
          : undefined;
      if (!requeueReason || this.disposed || postContext.mountSequence !== this.mountSequence) {
        return;
      }
      this.needsReplayOnVisible = true;
      scheduleVisibleReplayRetry();
      recordWebviewEvent({
        surface: 'tail',
        event: 'replayRequeuedAfterDroppedPost',
        hostKind: postContext.hostKind,
        mountSequence: postContext.mountSequence,
        messageType: msg.type,
        visible: postContext.visible,
        ready: postContext.ready,
        contentMounted: postContext.contentMounted,
        details: { reason: requeueReason }
      });
    };
    const replayBatch = options?.replayBatch;
    if (replayBatch) {
      replayBatch.pending += 1;
    }
    const postResult = this.view?.webview.postMessage(msg);
    if (postResult) {
      postResult.then(
        delivered => {
          if (!delivered) {
            if (replayBatch) {
              replayBatch.dropped = true;
            }
            recordWebviewEvent({
              surface: 'tail',
              event: 'messageDropped',
              hostKind: postContext.hostKind,
              mountSequence: postContext.mountSequence,
              messageType: msg.type,
              visible: postContext.visible,
              ready: postContext.ready,
              contentMounted: postContext.contentMounted
            });
            logInfo('Tail webview postMessage dropped', msg.type);
            requeueReplay();
          } else {
            if (msg.type === 'tailReset') {
              this.tailResetNeedsReplay = false;
            }
            options?.onDelivered?.();
          }
          this.settleReplayDeliveryBatch(replayBatch);
        },
        error => {
          if (replayBatch) {
            replayBatch.dropped = true;
          }
          recordWebviewEvent({
            surface: 'tail',
            event: 'messagePostRejected',
            hostKind: postContext.hostKind,
            mountSequence: postContext.mountSequence,
            messageType: msg.type,
            visible: postContext.visible,
            ready: postContext.ready,
            contentMounted: postContext.contentMounted,
            details: { error: getErrorMessage(error) }
          });
          logWarn('Tail webview postMessage failed ->', getErrorMessage(error));
          requeueReplay();
          this.settleReplayDeliveryBatch(replayBatch);
        }
      );
    } else if (replayBatch) {
      replayBatch.dropped = true;
      this.settleReplayDeliveryBatch(replayBatch);
    }
    if (shouldClearWebviewError) {
      this.errorClearNeedsReplay = true;
      this.post(
        { type: 'error', message: undefined },
        {
          requeueReplayOnDrop: true,
          onDelivered: () => {
            if (this.errorMessage === undefined) {
              this.errorClearNeedsReplay = false;
            }
          }
        }
      );
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
    this.contentMounted = false;
    this.needsReplayOnVisible = false;
    this.visibleReplayRetryAttempts = 0;
    this.tailResetNeedsReplay = false;
    this.clearBootstrapTimers();
    host.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    this.showPlaceholder(host);
    logInfo(`Tail webview resolved (${host.kind}).`);
    recordWebviewEvent({
      surface: 'tail',
      event: 'resolved',
      hostKind: host.kind,
      mountSequence: this.mountSequence,
      visible: host.visible,
      ready: this.ready,
      contentMounted: this.contentMounted
    });

    this.hostDisposables.push(
      host.onDidDispose(() => {
        if (this.host !== host) {
          return;
        }
        this.disposed = true;
        this.ready = false;
        this.contentMounted = false;
        this.needsReplayOnVisible = false;
        this.visibleReplayRetryAttempts = 0;
        this.view = undefined;
        this.host = undefined;
        this.clearBootstrapTimers();
        // Stop timers and clear caches, but keep controller disposal separate.
        this.tailService.stop();
        logInfo(`Tail webview disposed; stopped tail (${host.kind}).`);
        recordWebviewEvent({
          surface: 'tail',
          event: 'disposed',
          hostKind: host.kind,
          mountSequence: this.mountSequence,
          visible: host.visible,
          ready: this.ready,
          contentMounted: this.contentMounted
        });
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
