export type VsCodeWebviewApi<T> = {
  postMessage: (msg: T) => void;
  getState: <S = any>() => S | undefined;
  setState: (state: any) => void;
};

export type MessageBus = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

declare global {
  var acquireVsCodeApi: <T = unknown>() => VsCodeWebviewApi<T>;
}

const noopApi: VsCodeWebviewApi<any> = {
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {}
};

function withSentAt<T>(api: VsCodeWebviewApi<T>): VsCodeWebviewApi<T> {
  return {
    postMessage: message =>
      api.postMessage(
        typeof message === 'object' && message !== null && !Array.isArray(message)
          ? { ...message, sentAt: Date.now() }
          : message
      ),
    getState: () => api.getState(),
    setState: state => api.setState(state)
  };
}

export function getDefaultVsCodeApi<T>(): VsCodeWebviewApi<T> {
  if (typeof acquireVsCodeApi === 'function') {
    try {
      return withSentAt(acquireVsCodeApi<T>());
    } catch (error) {
      console.warn('acquireVsCodeApi threw during initialization', error);
    }
  }
  return noopApi;
}

export function getDefaultMessageBus(): MessageBus | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  if (typeof window.addEventListener !== 'function' || typeof window.removeEventListener !== 'function') {
    return undefined;
  }
  return window;
}
