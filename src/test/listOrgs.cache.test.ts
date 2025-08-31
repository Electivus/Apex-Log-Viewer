import assert from 'assert/strict';
import {
  listOrgs,
  __setExecFileImplForTests,
  __resetExecFileImplForTests,
  __setListOrgsCacheTTLForTests,
  __resetListOrgsCacheForTests
} from '../salesforce/cli';

suite('listOrgs caching', () => {
  teardown(() => {
    __resetExecFileImplForTests();
    __resetListOrgsCacheForTests();
  });

  test('reuses cached data within TTL', async () => {
    let called = 0;
    __setListOrgsCacheTTLForTests(1000);
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      called++;
      const payload = { result: { orgs: [{ username: 'a@example.com' }] } };
      cb(null, JSON.stringify(payload), '');
      return undefined as any;
    }) as any);
    const first = await listOrgs();
    const second = await listOrgs();
    assert.equal(first[0]!.username, 'a@example.com');
    assert.equal(second[0]!.username, 'a@example.com');
    assert.equal(called, 1, 'expected single CLI invocation');
  });

  test('refreshes after expiration', async () => {
    let called = 0;
    __setListOrgsCacheTTLForTests(50);
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      called++;
      const username = called === 1 ? 'a@example.com' : 'b@example.com';
      const payload = { result: { orgs: [{ username }] } };
      cb(null, JSON.stringify(payload), '');
      return undefined as any;
    }) as any);
    const first = await listOrgs();
    await new Promise(r => setTimeout(r, 60));
    const second = await listOrgs();
    assert.equal(first[0]!.username, 'a@example.com');
    assert.equal(second[0]!.username, 'b@example.com');
    assert.equal(called, 2, 'expected cache refresh after TTL');
  });
});
