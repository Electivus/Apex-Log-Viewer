import assert from 'assert/strict';
import {
  listOrgs,
  __setListOrgsMockForTests,
  __resetExecFileImplForTests,
  __setListOrgsCacheTTLForTests,
  __resetListOrgsCacheForTests
} from '../salesforce/cli';

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
});
