export interface WebviewSessionClock {
  setTimeout(callback: () => void, delayMs: number): { dispose(): void };
}

export const realWebviewSessionClock: WebviewSessionClock = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return {
      dispose() {
        clearTimeout(handle);
      }
    };
  }
};
