import { type WebviewSession, type WebviewSessionHost, type WebviewSessionOptions } from '../provider/webviewSession';
import { createWebviewSessionInternal } from '../provider/webviewSessionInternal';
import type { WebviewSessionClock } from '../provider/webviewSessionClock';

export type { WebviewSessionClock } from '../provider/webviewSessionClock';

export function createWebviewSessionForTest<TOutbound, TInbound, THost extends WebviewSessionHost<TOutbound>>(
  options: WebviewSessionOptions<TOutbound, TInbound, THost>,
  clock: WebviewSessionClock
): WebviewSession<TOutbound, THost> {
  return createWebviewSessionInternal(options, clock);
}
