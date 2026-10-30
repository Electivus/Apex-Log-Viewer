import type * as vscode from 'vscode';
import { recordWebviewEvent } from '../shared/webviewDiagnostics';
import type { WebviewProviderDiagnosticState, WebviewHostKind, WebviewSurface } from '../shared/webviewDiagnostics';
import type { BoundWebviewHost } from './webviewHost';
import type { WebviewSession, WebviewSessionDiagnostic, WebviewSessionInbound } from './webviewSession';

export interface WebviewSurfaceOptions<TInbound extends { type: string }> {
  surface: WebviewSurface;
  /** Names the surface in log lines, such as "Tail". */
  label: string;
  /** The localized title of the placeholder page shown while no webview content is mounted. */
  title: () => string;
  /** The inbound message type that announces the webview, carrying its mount sequence. */
  readyType: TInbound['type'];
  parseInbound(message: unknown): TInbound | undefined;
  log: { info(message: string): void; warn(message: string): void };
}

export interface SurfaceDiagnosticInput {
  session: { readonly ready: boolean };
  hasHost: boolean;
  hostKind?: WebviewHostKind;
  disposed: boolean;
  /** The surface's own counters; the session's latest event is added to them. */
  snapshots: WebviewProviderDiagnosticState['snapshots'];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * What every provider hosted by a Webview Session repeats around it: the placeholder page, inbound
 * validation, the session diagnostics and the host binding. The provider keeps the replay snapshot,
 * the bootstrap policy and the surface's own counters.
 */
export function createWebviewSurface<TInbound extends { type: string }>(options: WebviewSurfaceOptions<TInbound>) {
  const { surface, label, title, readyType, parseInbound, log } = options;
  let lastDiagnostic: WebviewSessionDiagnostic | undefined;

  function showPlaceholder(host: BoundWebviewHost, sessionReady: boolean): void {
    host.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(title())}</title>
  </head>
  <body></body>
</html>`;
    recordWebviewEvent({
      surface,
      event: 'placeholder',
      visible: host.visible,
      ready: sessionReady,
      contentMounted: false
    });
  }

  return {
    showPlaceholder,

    /** The latest session diagnostic, for a provider that reacts to the mount generation. */
    get lastDiagnostic(): WebviewSessionDiagnostic | undefined {
      return lastDiagnostic;
    },

    validateInbound(message: unknown): WebviewSessionInbound<TInbound> | undefined {
      const parsed = parseInbound(message);
      if (!parsed) {
        log.warn(`${label}: ignored invalid webview message`);
        return undefined;
      }
      if (parsed.type !== readyType) {
        return { kind: 'message', message: parsed };
      }
      const mountSequence = (parsed as { mountSequence?: number }).mountSequence;
      return { kind: 'ready', ...(mountSequence !== undefined ? { generation: mountSequence } : {}) };
    },

    handleSessionDiagnostic(diagnostic: WebviewSessionDiagnostic): void {
      lastDiagnostic = diagnostic;
      if (diagnostic.event === 'ready') {
        log.info(`${label} webview ready.`);
      }
      recordWebviewEvent({
        surface,
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
    },

    diagnosticState({
      session,
      hasHost,
      hostKind,
      disposed,
      snapshots
    }: SurfaceDiagnosticInput): WebviewProviderDiagnosticState {
      const diagnostic = lastDiagnostic;
      return {
        surface,
        hasHost,
        ...(hostKind ? { hostKind } : {}),
        visible: diagnostic?.visible,
        ready: session.ready,
        disposed,
        contentMounted: diagnostic?.contentMounted ?? false,
        mountSequence: diagnostic?.generation ?? 0,
        mountTimerActive: diagnostic?.mountTimerActive ?? false,
        readyTimerActive: diagnostic?.readyTimerActive ?? false,
        needsReplayOnVisible: diagnostic?.needsReplay ?? true,
        snapshots: {
          ...snapshots,
          sessionEvent: diagnostic?.event,
          sessionGeneration: diagnostic?.generation,
          sessionRetryAttempt: diagnostic?.attempt,
          sessionDeliveryClassification: diagnostic?.classification
        }
      };
    },

    /** Shows the placeholder, then hands the host to the session, which mounts the real page. */
    bindHost<TOutbound>(
      host: BoundWebviewHost,
      session: WebviewSession<TOutbound, BoundWebviewHost>,
      localResourceRoots: readonly vscode.Uri[]
    ): void {
      host.webview.options = { enableScripts: true, localResourceRoots };
      showPlaceholder(host, session.ready);
      session.bind(host);
      log.info(`${label} webview resolved.`);
    }
  };
}
