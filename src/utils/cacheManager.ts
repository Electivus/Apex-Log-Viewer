import * as vscode from 'vscode';

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export type CacheSection = 'app' | 'cli' | 'orgs';

/**
 * Lightweight TTL cache backed by VS Code memento storage.
 * When not initialized, get() returns undefined and set() is a no-op.
 */
export class CacheManager {
  private static store: vscode.Memento | undefined;
  private static readonly KEYS_INDEX = '__cacheKeys';

  static init(store: vscode.Memento): void {
    this.store = store;
    if (!this.store.get<string[]>(this.KEYS_INDEX)) {
      void this.store.update(this.KEYS_INDEX, []);
    }
  }

  private static makeKey(section: CacheSection, key: string): string {
    return `${section}:${key}`;
  }

  private static async trackKey(fullKey: string): Promise<void> {
    if (!this.store) return;
    const keys = this.store.get<string[]>(this.KEYS_INDEX) || [];
    if (!keys.includes(fullKey)) {
      keys.push(fullKey);
      await this.store.update(this.KEYS_INDEX, keys);
    }
  }

  static async set<T>(section: CacheSection, key: string, value: T, ttlMs: number): Promise<void> {
    if (!this.store) return;
    const fullKey = this.makeKey(section, key);
    const entry: CacheEntry<T> = { value, expiresAt: Date.now() + Math.max(0, ttlMs) };
    await this.store.update(fullKey, entry);
    await this.trackKey(fullKey);
  }

  static get<T>(section: CacheSection, key: string): T | undefined {
    if (!this.store) return undefined;
    const fullKey = this.makeKey(section, key);
    const entry = this.store.get<CacheEntry<T>>(fullKey);
    // Best-effort: keep index accurate even on get()
    void this.trackKey(fullKey);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      void this.delete(section, key);
      return undefined;
    }
    return entry.value;
  }

  static has(section: CacheSection, key: string): boolean {
    return this.get(section, key) !== undefined;
  }

  static async delete(section?: CacheSection, key?: string): Promise<void> {
    if (!this.store) return;
    const keys = this.store.get<string[]>(this.KEYS_INDEX) || [];
    let toDelete: string[] = [];
    if (!section && !key) {
      toDelete = [...keys];
    } else if (section && !key) {
      toDelete = keys.filter(k => k.startsWith(section + ':'));
    } else if (section && key) {
      toDelete = [this.makeKey(section, key)];
    }
    for (const k of toDelete) {
      await this.store.update(k, undefined);
    }
  }

  static async clearExpired(): Promise<void> {
    if (!this.store) return;
    const keys = this.store.get<string[]>(this.KEYS_INDEX) || [];
    const now = Date.now();
    for (const k of keys) {
      const entry = this.store.get<CacheEntry<unknown>>(k);
      if (entry && typeof (entry as CacheEntry<unknown>).expiresAt === 'number' && (entry as CacheEntry<unknown>).expiresAt < now) {
        await this.store.update(k, undefined);
      }
    }
  }
}

