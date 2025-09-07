import assert from 'assert/strict';
import { getOrgAuth, __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce/cli';

suite('getOrgAuth cancellation + dedupe', () => {
  teardown(() => {
    __resetExecFileImplForTests();
  });

  test('cancelling one caller does not abort shared exec', async () => {
    let spawnCount = 0;
    let capturedCb: ((err: any, stdout: string, stderr: string) => void) | undefined;
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>(res => (readyResolve = res));

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      spawnCount++;
      capturedCb = cb as any;
      // Let the test know the fake exec has been spawned
      readyResolve?.();
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

    // Complete the fake CLI call with valid org display JSON
    const stdout = JSON.stringify({
      result: {
        accessToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        username: 'user@example.com'
      }
    });
    capturedCb?.(null, stdout, '');

    // First caller should reject due to cancellation
    await assert.rejects(p1, (e: any) => /aborted/i.test(String(e?.message || e)));

    // Second caller resolves successfully
    const auth = await p2;
    assert.equal(auth.instanceUrl, 'https://example.my.salesforce.com');
    assert.equal(auth.accessToken, 'token');
    assert.equal(auth.username, 'user@example.com');

    // Only one spawn should have occurred (deduped)
    assert.equal(spawnCount, 1);
  });
});

