const PURGE_INTERVAL_MS = 60 * 60 * 1000;

export class LogCachePurgeThrottle {
  private readonly blockedUntil = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  run(scope: { workspaceRoot?: string; username: string }, purge: () => Promise<unknown>): Promise<void> {
    const key = `${scope.workspaceRoot ?? ''}\u0000${scope.username}`;
    const blockedUntil = this.blockedUntil.get(key);
    if (blockedUntil !== undefined && this.now() < blockedUntil) {
      return Promise.resolve();
    }
    const runBlockedUntil = this.now() + PURGE_INTERVAL_MS;
    this.blockedUntil.set(key, runBlockedUntil);
    return Promise.resolve()
      .then(purge)
      .then(
        () => {
          this.blockedUntil.set(key, this.now() + PURGE_INTERVAL_MS);
        },
        error => {
          if (this.blockedUntil.get(key) === runBlockedUntil) {
            this.blockedUntil.delete(key);
          }
          throw error;
        }
      );
  }
}

export const logCachePurgeThrottle = new LogCachePurgeThrottle();
