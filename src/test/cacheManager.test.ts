import assert from 'assert/strict';
import * as vscode from 'vscode';
import { CacheManager } from '../utils/cacheManager';

class MemoryMemento implements vscode.Memento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    return defaultValue as T;
  }
  keys(): readonly string[] {
    return Array.from(this.store.keys());
  }
  async update(key: string, value: any): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }
}

function init(): MemoryMemento {
  const memento = new MemoryMemento();
  CacheManager.init(memento);
  return memento;
}

suite('CacheManager', () => {
  test('set/get with TTL expiration', async () => {
    init();
    await CacheManager.set('app', 'foo', 'bar', 20);
    assert.equal(CacheManager.get('app', 'foo'), 'bar');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(CacheManager.get('app', 'foo'), undefined);
  });

  test('tracks keys in __cacheKeys', async () => {
    const memento = init();
    await CacheManager.set('cli', 'a', 'b', 100);
    assert.deepEqual(memento.get<string[]>('__cacheKeys'), ['cli:a']);

    const orphan = new MemoryMemento();
    await orphan.update('orgs:x', { value: 'y', expiresAt: Date.now() + 100 });
    CacheManager.init(orphan);
    assert.equal(CacheManager.get('orgs', 'x'), 'y');
    assert.deepEqual(orphan.get<string[]>('__cacheKeys'), ['orgs:x']);
  });

  test('delete removes all keys in a section', async () => {
    const memento = init();
    await CacheManager.set('app', 'a', 1, 100);
    await CacheManager.set('cli', 'b', 2, 100);
    await CacheManager.set('app', 'c', 3, 100);
    await CacheManager.delete('app');
    assert.deepEqual(memento.get<string[]>('__cacheKeys'), ['cli:b']);
    assert.equal(CacheManager.get('app', 'a'), undefined);
    assert.equal(CacheManager.get('app', 'c'), undefined);
    assert.equal(CacheManager.get('cli', 'b'), 2);
  });

  test('clearExpired removes expired entries', async () => {
    const memento = init();
    await CacheManager.set('orgs', 'k1', 'v1', 10);
    await CacheManager.set('orgs', 'k2', 'v2', 100);
    await new Promise(r => setTimeout(r, 20));
    await CacheManager.clearExpired();
    assert.deepEqual(memento.get<string[]>('__cacheKeys'), ['orgs:k2']);
    assert.equal(CacheManager.get('orgs', 'k1'), undefined);
    assert.equal(CacheManager.get('orgs', 'k2'), 'v2');
  });
});
