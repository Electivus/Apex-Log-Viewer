type ScheduledCallback = (...args: any[]) => void;

interface ScheduledTimer {
  id: number;
  runAt: number;
  callback: ScheduledCallback;
  args: unknown[];
}

export class TestClock {
  private readonly originalSetTimeout = globalThis.setTimeout;
  private readonly originalClearTimeout = globalThis.clearTimeout;
  private readonly timers = new Map<number, ScheduledTimer>();
  private currentTime = 0;
  private nextId = 1;

  constructor() {
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
      if (typeof handler !== 'function') {
        throw new Error('TestClock only supports function callbacks.');
      }

      const id = this.nextId++;
      const runAt = this.currentTime + Math.max(0, Number(delay ?? 0));
      this.timers.set(id, {
        id,
        runAt,
        callback: handler as ScheduledCallback,
        args
      });

      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle === undefined) {
        return;
      }
      this.timers.delete(Number(handle));
    }) as typeof clearTimeout;
  }

  async advanceBy(ms: number): Promise<void> {
    const targetTime = this.currentTime + Math.max(0, ms);

    while (true) {
      const nextTimer = this.getNextTimer(targetTime);
      if (!nextTimer) {
        break;
      }

      this.timers.delete(nextTimer.id);
      this.currentTime = nextTimer.runAt;
      nextTimer.callback(...nextTimer.args);
      await this.flushMicrotasks();
    }

    this.currentTime = targetTime;
    await this.flushMicrotasks();
  }

  async flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  dispose(): void {
    this.timers.clear();
    globalThis.setTimeout = this.originalSetTimeout;
    globalThis.clearTimeout = this.originalClearTimeout;
  }

  private getNextTimer(targetTime: number): ScheduledTimer | undefined {
    let nextTimer: ScheduledTimer | undefined;
    for (const timer of this.timers.values()) {
      if (timer.runAt > targetTime) {
        continue;
      }
      if (!nextTimer || timer.runAt < nextTimer.runAt || (timer.runAt === nextTimer.runAt && timer.id < nextTimer.id)) {
        nextTimer = timer;
      }
    }
    return nextTimer;
  }
}
