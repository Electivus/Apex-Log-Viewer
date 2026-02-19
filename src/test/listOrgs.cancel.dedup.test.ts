import assert from 'assert/strict';
import { listOrgs, __resetListOrgsCacheForTests } from '../salesforce/cli';
import { __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce/exec';

suite('listOrgs cancellation + dedupe', () => {
  teardown(() => {
    __resetExecFileImplForTests();
    __resetListOrgsCacheForTests();
  });

  test('cancelling one caller does not abort shared exec', async () => {
    __resetListOrgsCacheForTests();

    let spawnCount = 0;
    let capturedCb: ((err: any, stdout: string, stderr: string) => void) | undefined;
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>(res => (readyResolve = res));

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      spawnCount++;
      capturedCb = cb as any;
      // Signal that the fake process has been spawned and we captured the callback
      readyResolve?.();
      // Do not invoke the callback yet; the test will trigger it
      return undefined as any;
    }) as any);

    const c1 = new AbortController();
    const c2 = new AbortController();

    // Fire two concurrent requests that should dedupe to a single spawn
    const p1 = listOrgs(false, c1.signal);
    const p2 = listOrgs(false, c2.signal);

    // Wait until the underlying fake exec has been created
    await ready;

    // Cancel only the first caller
    c1.abort();

    // Now complete the fake exec with a valid JSON payload
    const stdout = JSON.stringify({
      result: {
        orgs: [
          {
            username: 'user@example.com',
            alias: 'alias1',
            isDefaultUsername: true
          }
        ]
      }
    });
    capturedCb?.(null, stdout, '');

    // First caller should reject with an aborted error
    await assert.rejects(p1, (e: any) => /aborted/i.test(String(e?.message || e)));

    // Second caller should resolve successfully with parsed results
    const res2 = await p2;
    assert.ok(Array.isArray(res2));
    assert.equal(res2.length, 1);
    assert.equal(res2[0]?.username, 'user@example.com');

    // Only one spawn should have occurred due to in-flight dedupe
    assert.equal(spawnCount, 1);
  });
});
