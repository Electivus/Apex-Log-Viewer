import {
  WEBVIEW_SESSION_MAX_RETRIES,
  WEBVIEW_SESSION_MOUNT_DELAY_MS,
  WEBVIEW_SESSION_READY_TIMEOUT_MS,
  WEBVIEW_SESSION_RETRY_DELAY_MS,
  type WebviewDeliveryClassification,
  type WebviewSession,
  type WebviewSessionDiagnostic,
  type WebviewSessionDetachReason,
  type WebviewSessionDisposable,
  type WebviewSessionHost,
  type WebviewSessionInbound,
  type WebviewSessionOptions
} from './webviewSession';
import type { WebviewSessionClock } from './webviewSessionClock';

class DefaultWebviewSession<TOutbound, TInbound, THost extends WebviewSessionHost<TOutbound>> implements WebviewSession<
  TOutbound,
  THost
> {
  private host: THost | undefined;
  private mountTimer: WebviewSessionDisposable | undefined;
  private readyTimer: WebviewSessionDisposable | undefined;
  private retryTimer: WebviewSessionDisposable | undefined;
  private messageListener: WebviewSessionDisposable | undefined;
  private visibilityListener: WebviewSessionDisposable | undefined;
  private hostDisposeListener: WebviewSessionDisposable | undefined;
  private generation = 0;
  private activeMountGeneration: number | undefined;
  private disposed = false;
  private readyState = false;
  private needsReplay = true;
  private replayIntentVersion = 0;
  private retryAttempts = 0;
  private retryExhaustionDiagnosed = false;

  constructor(
    private readonly options: WebviewSessionOptions<TOutbound, TInbound, THost>,
    private readonly clock: WebviewSessionClock
  ) {}

  get ready(): boolean {
    return this.readyState;
  }

  get visible(): boolean | undefined {
    return this.host?.visible;
  }

  bind(host: THost): void {
    if (this.disposed) {
      return;
    }
    if (this.host) {
      this.detachInternal('rebind');
    }
    this.host = host;
    this.readyState = false;
    this.activeMountGeneration = undefined;
    this.diagnose({ event: 'attached' });
    this.messageListener?.dispose();
    this.messageListener = host.webview.onDidReceiveMessage(message => this.handleInbound(host, message));
    this.visibilityListener?.dispose();
    this.visibilityListener = host.onDidChangeVisibility(visible => {
      if (this.host !== host || this.disposed) {
        return;
      }
      if (!visible) {
        this.mountTimer?.dispose();
        this.mountTimer = undefined;
        this.readyTimer?.dispose();
        this.readyTimer = undefined;
        this.retryTimer?.dispose();
        this.retryTimer = undefined;
        this.diagnose({ event: 'hidden' });
        return;
      }
      this.diagnose({ event: 'visible' });
      if (this.readyState) {
        if (this.needsReplay) {
          this.resetReplayRetryBudget();
          void this.replayLatest();
        }
        return;
      }
      if (this.activeMountGeneration !== undefined) {
        this.startReadyTimer(host, this.activeMountGeneration);
        return;
      }
      this.scheduleMount(host);
    });
    this.hostDisposeListener = host.onDidDispose(() => {
      if (this.host === host) {
        this.detachInternal('hostDisposed');
      }
    });
    if (!host.visible) {
      return;
    }
    this.scheduleMount(host);
  }

  detach(): void {
    this.detachInternal('explicit');
  }

  private detachInternal(reason: WebviewSessionDetachReason): void {
    const wasAttached = this.host !== undefined;
    this.host = undefined;
    this.readyState = false;
    this.activeMountGeneration = undefined;
    this.mountTimer?.dispose();
    this.mountTimer = undefined;
    this.readyTimer?.dispose();
    this.readyTimer = undefined;
    this.retryTimer?.dispose();
    this.retryTimer = undefined;
    this.resetReplayRetryBudget();
    this.messageListener?.dispose();
    this.messageListener = undefined;
    this.visibilityListener?.dispose();
    this.visibilityListener = undefined;
    this.hostDisposeListener?.dispose();
    this.hostDisposeListener = undefined;
    if (wasAttached) {
      this.diagnose({ event: 'detached' });
      try {
        this.options.onDetach?.(reason);
      } catch {
        this.diagnose({
          event: 'callbackFailed',
          callback: 'detach'
        });
      }
    }
  }

  async deliver(message: TOutbound, classification: WebviewDeliveryClassification): Promise<boolean> {
    const host = this.host;
    if (!host || !this.readyState || this.disposed) {
      if (classification === 'replayable') {
        this.markReplayNeeded();
      }
      this.diagnose({
        event: 'deliverySkipped',
        classification
      });
      return false;
    }
    const generation = this.generation;
    const deliveryIntentVersion = classification === 'replayable' ? this.advanceReplayIntentVersion() : undefined;
    if (!host.visible && classification === 'replayable') {
      this.needsReplay = true;
    }
    this.diagnose({
      event: 'deliveryAttempted',
      classification
    });
    try {
      const accepted = await host.webview.postMessage(message);
      if (!this.isCurrentGeneration(host, generation)) {
        this.diagnose({ event: 'staleWorkIgnored' });
        return false;
      }
      if (
        accepted &&
        classification === 'replayable' &&
        deliveryIntentVersion !== undefined &&
        this.replayIntentVersion !== deliveryIntentVersion
      ) {
        this.diagnose({ event: 'replaySuperseded' });
        return false;
      }
      if (!accepted && classification === 'replayable') {
        this.markReplayNeeded();
        this.scheduleReplayRetry();
      }
      this.diagnose({
        event: accepted ? 'deliveryAccepted' : 'deliveryRejected',
        classification
      });
      return accepted;
    } catch {
      if (!this.isCurrentGeneration(host, generation)) {
        this.diagnose({ event: 'staleWorkIgnored' });
        return false;
      }
      if (classification === 'replayable') {
        this.markReplayNeeded();
        this.scheduleReplayRetry();
      }
      this.diagnose({
        event: 'deliveryFailed',
        classification
      });
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachInternal('finalDispose');
    this.diagnose({ event: 'disposed' });
  }

  private scheduleMount(host: THost): void {
    this.mountTimer?.dispose();
    this.mountTimer = this.clock.setTimeout(() => {
      this.mountTimer = undefined;
      if (this.disposed || this.host !== host || !host.visible) {
        return;
      }
      const generation = ++this.generation;
      void this.mount(host, generation);
    }, WEBVIEW_SESSION_MOUNT_DELAY_MS);
    this.diagnose({ event: 'mountScheduled' });
  }

  private async handleInbound(host: THost, raw: unknown): Promise<void> {
    const generation = this.generation;
    if (this.host !== host || this.disposed) {
      this.diagnose({ event: 'staleWorkIgnored' });
      return;
    }
    let inbound: WebviewSessionInbound<TInbound> | undefined;
    try {
      inbound = this.options.validateInbound(raw);
    } catch {
      this.diagnose({
        event: 'callbackFailed',
        callback: 'validateInbound'
      });
      return;
    }
    if (!inbound) {
      this.diagnose({ event: 'invalidInbound' });
      return;
    }
    if (inbound.kind === 'message') {
      try {
        await this.options.onMessage(inbound.message);
        if (!this.isCurrentGeneration(host, generation)) {
          this.diagnose({ event: 'staleWorkIgnored' });
          return;
        }
        this.diagnose({ event: 'messageForwarded' });
      } catch {
        if (!this.isCurrentGeneration(host, generation)) {
          this.diagnose({ event: 'staleWorkIgnored' });
          return;
        }
        this.diagnose({
          event: 'callbackFailed',
          callback: 'message'
        });
      }
      return;
    }
    const activeMountGeneration = this.activeMountGeneration;
    if (
      activeMountGeneration === undefined ||
      (inbound.generation === undefined && activeMountGeneration > 1) ||
      (inbound.generation !== undefined && inbound.generation !== activeMountGeneration)
    ) {
      this.diagnose({ event: 'staleWorkIgnored' });
      return;
    }
    if (this.readyState) {
      this.diagnose({ event: 'readyDuplicate' });
      return;
    }
    this.readyState = true;
    this.readyTimer?.dispose();
    this.readyTimer = undefined;
    this.resetReplayRetryBudget();
    this.markReplayNeeded();
    this.diagnose({ event: 'ready' });
    await this.replayLatest();
    if (!this.isCurrentGeneration(host, generation) || !this.readyState) {
      this.diagnose({ event: 'staleWorkIgnored' });
      return;
    }
    try {
      await this.options.onReady?.();
    } catch {
      if (this.isCurrentGeneration(host, generation) && this.readyState) {
        this.diagnose({
          event: 'callbackFailed',
          callback: 'ready'
        });
      }
    }
  }

  private async mount(host: THost, generation: number): Promise<void> {
    try {
      await this.options.mount(host, generation);
    } catch {
      if (this.isCurrentGeneration(host, generation)) {
        this.diagnose({
          event: 'callbackFailed',
          callback: 'mount'
        });
      }
      return;
    }
    if (!this.isCurrentGeneration(host, generation)) {
      this.diagnose({ event: 'staleWorkIgnored' });
      return;
    }
    this.activeMountGeneration = generation;
    if (host.visible) {
      this.startReadyTimer(host, generation);
    }
    this.diagnose({ event: 'mounted' });
  }

  private startReadyTimer(host: THost, generation: number): void {
    this.readyTimer?.dispose();
    this.readyTimer = this.clock.setTimeout(() => {
      this.readyTimer = undefined;
      if (!this.isCurrentGeneration(host, generation) || this.readyState) {
        return;
      }
      void this.requestReadyTimeoutRecovery(host, generation);
    }, WEBVIEW_SESSION_READY_TIMEOUT_MS);
  }

  private async requestReadyTimeoutRecovery(host: THost, generation: number): Promise<void> {
    this.diagnose({ event: 'recoveryRequested' });
    try {
      await host.recoverAfterReadyTimeout(() => {
        if (!this.isCurrentGeneration(host, generation) || this.readyState) {
          this.diagnose({ event: 'staleWorkIgnored' });
          return;
        }
        this.activeMountGeneration = undefined;
        this.scheduleMount(host);
      });
    } catch {
      if (this.isCurrentGeneration(host, generation)) {
        this.diagnose({
          event: 'callbackFailed',
          callback: 'timeoutRecovery'
        });
      }
    }
  }

  private async replayLatest(): Promise<void> {
    const host = this.host;
    if (!host || !this.readyState || this.disposed) {
      return;
    }
    const generation = this.generation;
    const replayIntentVersion = this.replayIntentVersion;
    this.diagnose({ event: 'replayStarted' });
    let snapshot: readonly TOutbound[];
    try {
      snapshot = await this.options.getReplaySnapshot();
    } catch {
      if (!this.isCurrentGeneration(host, generation)) {
        this.diagnose({ event: 'staleWorkIgnored' });
        return;
      }
      this.markReplayNeeded();
      this.diagnose({
        event: 'callbackFailed',
        callback: 'snapshot'
      });
      this.scheduleReplayRetry();
      return;
    }
    if (!this.isCurrentGeneration(host, generation)) {
      this.diagnose({ event: 'staleWorkIgnored' });
      return;
    }
    if (this.replayIntentVersion !== replayIntentVersion) {
      this.markReplayNeeded();
      this.diagnose({ event: 'replaySuperseded' });
      this.scheduleReplayRetry();
      return;
    }
    const outcomes = await Promise.all(
      snapshot.map(async message => {
        try {
          return await host.webview.postMessage(message);
        } catch {
          return false;
        }
      })
    );
    if (!this.isCurrentGeneration(host, generation)) {
      this.diagnose({ event: 'staleWorkIgnored' });
      return;
    }
    const allAccepted = outcomes.every(Boolean);
    if (allAccepted) {
      if (this.replayIntentVersion !== replayIntentVersion) {
        this.markReplayNeeded();
        this.diagnose({ event: 'replaySuperseded' });
        this.scheduleReplayRetry();
        return;
      }
      this.needsReplay = false;
      this.retryAttempts = 0;
      this.retryExhaustionDiagnosed = false;
      this.retryTimer?.dispose();
      this.retryTimer = undefined;
      this.diagnose({ event: 'replaySucceeded' });
      try {
        this.options.onReplaySucceeded?.();
      } catch {
        this.diagnose({
          event: 'callbackFailed',
          callback: 'replay'
        });
      }
      return;
    }
    this.markReplayNeeded();
    this.diagnose({ event: 'replayIncomplete' });
    this.scheduleReplayRetry();
  }

  private scheduleReplayRetry(): void {
    if (this.retryAttempts >= WEBVIEW_SESSION_MAX_RETRIES) {
      if (!this.retryExhaustionDiagnosed) {
        this.retryExhaustionDiagnosed = true;
        this.diagnose({
          event: 'retryExhausted',
          attempt: this.retryAttempts
        });
      }
      return;
    }
    if (this.retryTimer || this.disposed || !this.host?.visible || !this.readyState) {
      return;
    }
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.disposed || !this.host?.visible || !this.readyState || !this.needsReplay) {
        return;
      }
      this.retryAttempts += 1;
      this.diagnose({
        event: 'retryAttempted',
        attempt: this.retryAttempts
      });
      void this.replayLatest();
    }, WEBVIEW_SESSION_RETRY_DELAY_MS);
    this.diagnose({
      event: 'retryScheduled',
      attempt: this.retryAttempts + 1
    });
  }

  private diagnose(
    diagnostic: Omit<
      WebviewSessionDiagnostic,
      'generation' | 'ready' | 'visible' | 'contentMounted' | 'mountTimerActive' | 'readyTimerActive' | 'needsReplay'
    >
  ): void {
    try {
      this.options.onDiagnostic?.({
        generation: this.generation,
        ready: this.readyState,
        ...(this.host ? { visible: this.host.visible } : {}),
        contentMounted: this.activeMountGeneration !== undefined,
        mountTimerActive: this.mountTimer !== undefined,
        readyTimerActive: this.readyTimer !== undefined,
        needsReplay: this.needsReplay,
        ...diagnostic
      });
    } catch {
      // Diagnostics must never affect session mechanics.
    }
  }

  private markReplayNeeded(): void {
    this.needsReplay = true;
    this.advanceReplayIntentVersion();
  }

  private advanceReplayIntentVersion(): number {
    this.replayIntentVersion += 1;
    return this.replayIntentVersion;
  }

  private resetReplayRetryBudget(): void {
    this.retryAttempts = 0;
    this.retryExhaustionDiagnosed = false;
    this.retryTimer?.dispose();
    this.retryTimer = undefined;
  }

  private isCurrentGeneration(host: THost, generation: number): boolean {
    return this.host === host && this.generation === generation && !this.disposed;
  }
}

export function createWebviewSessionInternal<TOutbound, TInbound, THost extends WebviewSessionHost<TOutbound>>(
  options: WebviewSessionOptions<TOutbound, TInbound, THost>,
  clock: WebviewSessionClock
): WebviewSession<TOutbound, THost> {
  return new DefaultWebviewSession(options, clock);
}
