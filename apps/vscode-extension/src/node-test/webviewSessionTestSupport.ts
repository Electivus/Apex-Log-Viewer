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

/** Flush the promise chains a session or provider starts. The fake clock never touches real timers. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

interface TestTimer {
  readonly id: number;
  readonly runAt: number;
  readonly callback: () => void;
}

export class FakeClock implements WebviewSessionClock {
  private readonly timers = new Map<number, TestTimer>();
  private now = 0;
  private nextId = 1;

  setTimeout(callback: () => void, delayMs: number): { dispose(): void } {
    const timer: TestTimer = { id: this.nextId++, runAt: this.now + delayMs, callback };
    this.timers.set(timer.id, timer);
    return { dispose: () => void this.timers.delete(timer.id) };
  }

  async advanceBy(delayMs: number): Promise<void> {
    const target = this.now + delayMs;
    for (;;) {
      const next = [...this.timers.values()]
        .filter(timer => timer.runAt <= target)
        .sort((left, right) => left.runAt - right.runAt || left.id - right.id)[0];
      if (!next) {
        break;
      }
      this.timers.delete(next.id);
      this.now = next.runAt;
      next.callback();
      await settle();
    }
    this.now = target;
    await settle();
  }

  /** Three microtask turns: a promise chain advances, a timer does not. */
  async flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}
