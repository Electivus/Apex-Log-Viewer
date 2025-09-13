import { useEffect, useMemo } from 'react';

// Minimal VS Code API interface
interface VsCodeApi<T> {
  postMessage: (msg: T) => void;
  getState: <S = unknown>() => S | undefined;
  setState: (state: any) => void;
}

declare global {
  function acquireVsCodeApi<T = unknown>(): VsCodeApi<T>;
}

export function useVsCodeMessaging<Incoming, Outgoing = unknown>(
  onMessage: (msg: Incoming) => void
) {
  const vscode = useMemo(() => acquireVsCodeApi<Outgoing>(), []);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const msg = event.data as Incoming;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      onMessage(msg);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [onMessage]);

  return {
    postMessage: vscode.postMessage
  };
}

