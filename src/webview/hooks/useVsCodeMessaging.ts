import { useCallback, useEffect } from 'react';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/messages';

/**
 * React hook to bridge VS Code's messaging APIs.
 *
 * It sets up a message event listener and returns a typed `postMessage`
 * helper for sending messages back to the extension.
 *
 * @param onMessage - handler invoked for each message from the extension.
 * @returns `postMessage` function for sending messages to the extension.
 */
export function useVsCodeMessaging(
  onMessage: (msg: ExtensionToWebviewMessage) => void
) {
  const vscode = acquireVsCodeApi<WebviewToExtensionMessage>();

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const msg = event.data as ExtensionToWebviewMessage;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      onMessage(msg);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [onMessage]);

  return useCallback(
    (msg: WebviewToExtensionMessage) => {
      vscode.postMessage(msg);
    },
    [vscode]
  );
}

/** VS Code webview API available globally at runtime. */
declare global {
  var acquireVsCodeApi: <T = unknown>() => {
    postMessage: (msg: T) => void;
    getState: <S = any>() => S | undefined;
    setState: (state: any) => void;
  };
}
