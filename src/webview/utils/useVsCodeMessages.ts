import { useCallback, useMemo } from 'react';

declare global {
  // Provided by VS Code webview runtime
  var acquireVsCodeApi: <T = unknown>() => {
    postMessage: (msg: T) => void;
    getState: <S = any>() => S | undefined;
    setState: (state: any) => void;
  };
}

export function useVsCodeMessages<Send, Receive>() {
  const vscode = useMemo(() => acquireVsCodeApi<Send>(), []);
  const postMessage = useCallback((msg: Send) => {
    vscode.postMessage(msg);
  }, [vscode]);
  const addMessageListener = useCallback((listener: (msg: Receive) => void) => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as Receive;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      listener(msg);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);
  return { postMessage, addMessageListener };
}
