import assert from 'assert/strict';
import { execCommand, __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce/exec';

suite('execCommand cancel and timeout', () => {
  teardown(() => {
    __resetExecFileImplForTests();
  });

  test('cancelling one deduped call does not cancel the other', async () => {
    let spawnCount = 0;
    let capturedCb: ((err: any, stdout: string, stderr: string) => void) | undefined;
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>(res => (readyResolve = res));

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      spawnCount++;
      capturedCb = cb as any;
      readyResolve?.();
      return { kill() {} } as any;
    }) as any);

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = execCommand('sf', ['org', 'list'], undefined, 1000, c1.signal);
    const p2 = execCommand('sf', ['org', 'list'], undefined, 1000, c2.signal);
    await ready;
    c1.abort();
    capturedCb?.(null, 'ok', '');
    await assert.rejects(p1, /aborted/i);
    const res2 = await p2;
    assert.equal(res2.stdout, 'ok');
    assert.equal(spawnCount, 1);
  });

  test('times out when command runs too long', async () => {
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, _cb: any) => {
      return { kill() {} } as any;
    }) as any);
    await assert.rejects(execCommand('sf', ['org', 'list'], undefined, 10), (e: any) => e.code === 'ETIMEDOUT');
  });
});
