export type WebviewSurface = 'logs' | 'tail';
export type WebviewHostKind = 'panel' | 'editor';

export interface WebviewLifecycleEvent {
  timestamp: string;
  surface: WebviewSurface;
  event: string;
  hostKind?: WebviewHostKind;
  mountSequence?: number;
  messageType?: string;
  visible?: boolean;
  ready?: boolean;
  contentMounted?: boolean;
  details?: Record<string, string | number | boolean | undefined>;
}

export interface WebviewProviderDiagnosticState {
  surface: WebviewSurface;
  hasHost: boolean;
  hostKind?: WebviewHostKind;
  visible?: boolean;
  ready: boolean;
  disposed: boolean;
  contentMounted: boolean;
  mountSequence: number;
  mountTimerActive: boolean;
  readyTimerActive: boolean;
  needsReplayOnVisible: boolean;
  snapshots: Record<string, string | number | boolean | undefined>;
}

const MAX_WEBVIEW_EVENTS = 200;
const webviewEvents: WebviewLifecycleEvent[] = [];

export function recordWebviewEvent(event: Omit<WebviewLifecycleEvent, 'timestamp'>): void {
  webviewEvents.push({
    timestamp: new Date().toISOString(),
    ...event
  });
  if (webviewEvents.length > MAX_WEBVIEW_EVENTS) {
    webviewEvents.splice(0, webviewEvents.length - MAX_WEBVIEW_EVENTS);
  }
}

export function getWebviewDiagnosticEvents(): WebviewLifecycleEvent[] {
  return webviewEvents.slice();
}
