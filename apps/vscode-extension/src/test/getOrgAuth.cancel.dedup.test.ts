import assert from 'assert/strict';
import { getOrgAuth } from '../host/salesforce/cli';
import {
  __setExecFileImplForTests,
  __resetExecFileImplForTests,
  __resetExecDedupeCacheForTests
} from '../host/salesforce/exec';

suite('getOrgAuth cancellation + dedupe', () => {
  setup(() => {
    __resetExecDedupeCacheForTests();
  });
  teardown(() => {
    __resetExecFileImplForTests();
    __resetExecDedupeCacheForTests();
  });

  test('cancelling one caller does not abort shared exec', async () => {
    let spawnCount = 0;
    const capturedCbs: Array<(err: any, stdout: string, stderr: string) => void> = [];
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>(res => (readyResolve = res));

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      spawnCount++;
      capturedCbs.push(cb as any);
      // Let the test know the fake exec has been spawned
      if (spawnCount === 1) {
        readyResolve?.();
      }
      // Do not invoke the callback yet; the test will resolve it later
      return undefined as any;
    }) as any);

    const c1 = new AbortController();
    const c2 = new AbortController();

    // Two concurrent calls for same target (default org) should dedupe
    const p1 = getOrgAuth(undefined, undefined, c1.signal);
    const p2 = getOrgAuth(undefined, undefined, c2.signal);

    // Wait until the underlying fake exec was spawned
    await ready;

    // Cancel only the first caller
    c1.abort();

    // Complete the shared org display call, then the shared explicit token call.
    const displayStdout = JSON.stringify({
      result: {
        instanceUrl: 'https://example.my.salesforce.com',
        username: 'user@example.com'
      }
    });
    capturedCbs[0]?.(null, displayStdout, '');
    while (capturedCbs.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    capturedCbs[1]?.(null, JSON.stringify({ result: { accessToken: 'token' } }), '');

    // First caller should reject due to cancellation
    await assert.rejects(p1, (e: any) => /aborted/i.test(String(e?.message || e)));

    // Second caller resolves successfully
    const auth = await p2;
    assert.equal(auth.instanceUrl, 'https://example.my.salesforce.com');
    assert.equal(auth.accessToken, 'token');
    assert.equal(auth.username, 'user@example.com');

    // One shared spawn per CLI command should have occurred.
    assert.equal(spawnCount, 2);
  });
});
