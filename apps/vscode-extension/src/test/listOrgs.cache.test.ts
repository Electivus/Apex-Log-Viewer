import assert from 'assert/strict';
import {
  listOrgs,
  __setListOrgsMockForTests,
  __setListOrgsCacheTTLForTests,
  __resetListOrgsCacheForTests
} from '../salesforce/cli';
import { CacheManager } from '../utils/cacheManager';
import type * as vscode from 'vscode';
import { __test__ as extensionTestUtils } from '../extension';

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
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }
}

function makeContext(memento: MemoryMemento): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: memento
  } as unknown as vscode.ExtensionContext;
}
import { __resetExecFileImplForTests } from '../salesforce/exec';

suite('listOrgs caching', () => {
  teardown(() => {
    __resetExecFileImplForTests();
    __resetListOrgsCacheForTests();
    __setListOrgsMockForTests(undefined);
  });

  test('reuses cached data within TTL', async () => {
    let called = 0;
    __setListOrgsCacheTTLForTests(1000);
    __setListOrgsMockForTests(() => {
      called++;
      return [{ username: 'a@example.com' } as any];
    });
    const first = await listOrgs();
    const second = await listOrgs();
    assert.equal(first[0]!.username, 'a@example.com');
    assert.equal(second[0]!.username, 'a@example.com');
    assert.equal(called, 1, 'expected single CLI invocation');
  });

  test('refreshes after expiration (or when forceRefresh=true)', async () => {
    let called = 0;
    __setListOrgsCacheTTLForTests(50);
    __setListOrgsMockForTests(() => {
      called++;
      const username = called === 1 ? 'a@example.com' : 'b@example.com';
      return [{ username } as any];
    });
    const first = await listOrgs();
    // Give a bit more leeway to avoid timer jitter across environments
    await new Promise(r => setTimeout(r, 120));
    // Use forceRefresh to avoid any interference from persistent caches in new implementation
    const second = await listOrgs(true);
    assert.equal(first[0]!.username, 'a@example.com');
    assert.equal(second[0]!.username, 'b@example.com');
    assert.equal(called, 2, 'expected cache refresh after TTL');
  });

  test('non-expired CLI cache persists through activation init', async () => {
    const memento = new MemoryMemento();
    const entry = { value: [{ username: 'persisted@example.com' }], expiresAt: Date.now() + 60_000 };
    await memento.update('__cacheKeys', ['cli:orgList']);
    await memento.update('cli:orgList', entry);
    const context = makeContext(memento);

    await extensionTestUtils.initializePersistentCache(context);

    const stored = memento.get<typeof entry>('cli:orgList');
    assert.deepEqual(stored, entry, 'expected CLI cache entry to remain after init');
    assert.deepEqual(CacheManager.get('cli', 'orgList'), entry.value);
  });

  test('manual CLI cache reset clears entries after init', async () => {
    const memento = new MemoryMemento();
    const entry = { value: [{ username: 'manual@example.com' }], expiresAt: Date.now() + 60_000 };
    await memento.update('__cacheKeys', ['cli:orgList']);
    await memento.update('cli:orgList', entry);
    const context = makeContext(memento);

    await extensionTestUtils.initializePersistentCache(context);
    await CacheManager.delete('cli');

    assert.equal(memento.get('cli:orgList'), undefined, 'expected persisted entry to be removed');
    assert.deepEqual(memento.get('__cacheKeys'), [], 'expected cache index to be cleared');
    assert.equal(CacheManager.get('cli', 'orgList'), undefined, 'expected cache manager to drop CLI cache');
  });
});
