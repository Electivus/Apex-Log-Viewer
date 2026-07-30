import { realWebviewSessionClock } from './webviewSessionClock';
import { createWebviewSessionInternal } from './webviewSessionInternal';

export const WEBVIEW_SESSION_MOUNT_DELAY_MS = 1000;
export const WEBVIEW_SESSION_READY_TIMEOUT_MS = 30_000;
export const WEBVIEW_SESSION_RETRY_DELAY_MS = 250;
export const WEBVIEW_SESSION_MAX_RETRIES = 3;

export interface WebviewSessionDisposable {
  dispose(): void;
}

export interface WebviewSessionHost<TOutbound> {
  readonly webview: {
    postMessage(message: TOutbound): Thenable<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => void | Promise<void>): WebviewSessionDisposable;
  };
  readonly visible: boolean;
  recoverAfterReadyTimeout(remount: () => void): void | Promise<void>;
  onDidDispose(listener: () => void): WebviewSessionDisposable;
  onDidChangeVisibility(listener: (visible: boolean) => void): WebviewSessionDisposable;
}

export type WebviewSessionInbound<TInbound> =
  { readonly kind: 'ready'; readonly generation?: number } | { readonly kind: 'message'; readonly message: TInbound };

export type WebviewDeliveryClassification = 'replayable' | 'transient';
export type WebviewSessionDetachReason = 'rebind' | 'hostDisposed' | 'explicit' | 'finalDispose';

export type WebviewSessionDiagnosticEvent =
  | 'attached'
  | 'callbackFailed'
  | 'deliveryAccepted'
  | 'deliveryAttempted'
  | 'deliveryFailed'
  | 'deliveryRejected'
  | 'deliverySkipped'
  | 'detached'
  | 'disposed'
  | 'hidden'
  | 'invalidInbound'
  | 'messageForwarded'
  | 'mountScheduled'
  | 'mounted'
  | 'ready'
  | 'readyDuplicate'
  | 'recoveryRequested'
  | 'replayIncomplete'
  | 'replayStarted'
  | 'replaySucceeded'
  | 'replaySuperseded'
  | 'retryAttempted'
  | 'retryExhausted'
  | 'retryScheduled'
  | 'staleWorkIgnored'
  | 'visible';

export interface WebviewSessionDiagnostic {
  readonly event: WebviewSessionDiagnosticEvent;
  readonly generation: number;
  readonly ready: boolean;
  readonly visible?: boolean;
  readonly contentMounted: boolean;
  readonly mountTimerActive: boolean;
  readonly readyTimerActive: boolean;
  readonly needsReplay: boolean;
  readonly classification?: WebviewDeliveryClassification;
  readonly attempt?: number;
  readonly callback?:
    'detach' | 'mount' | 'snapshot' | 'validateInbound' | 'message' | 'ready' | 'replay' | 'timeoutRecovery';
}

export interface WebviewSessionOptions<
  TOutbound,
  TInbound,
  THost extends WebviewSessionHost<TOutbound> = WebviewSessionHost<TOutbound>
> {
  mount(host: THost, generation: number): void | Promise<void>;
  getReplaySnapshot(): readonly TOutbound[] | Promise<readonly TOutbound[]>;
  validateInbound(message: unknown): WebviewSessionInbound<TInbound> | undefined;
  onDetach?(reason: WebviewSessionDetachReason): void;
  onMessage(message: TInbound): void | Promise<void>;
  onReady?(): void | Promise<void>;
  onReplaySucceeded?(): void;
  onDiagnostic?(diagnostic: WebviewSessionDiagnostic): void;
}

export interface WebviewSession<TOutbound, THost extends WebviewSessionHost<TOutbound>> {
  readonly ready: boolean;
  readonly visible: boolean | undefined;
  bind(host: THost): void;
  detach(): void;
  deliver(message: TOutbound, classification: WebviewDeliveryClassification): Promise<boolean>;
  dispose(): void;
}

export function createWebviewSession<TOutbound, TInbound, THost extends WebviewSessionHost<TOutbound>>(
  options: WebviewSessionOptions<TOutbound, TInbound, THost>
): WebviewSession<TOutbound, THost> {
  return createWebviewSessionInternal(options, realWebviewSessionClock);
}
