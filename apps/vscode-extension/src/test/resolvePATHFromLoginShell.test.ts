import assert from 'assert/strict';
import { resolvePATHFromLoginShell, __resetLoginShellPATHForTests } from '../salesforce/path';
import { __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce/exec';

suite('resolvePATHFromLoginShell', () => {
  setup(() => {
    __resetLoginShellPATHForTests();
  });
  teardown(() => {
    __resetExecFileImplForTests();
    __resetLoginShellPATHForTests();
  });

  test('caches PATH on success', async () => {
    let calls = 0;
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      calls++;
      cb(null, '/usr/bin', '');
      return undefined as any;
    }) as any);

    const path1 = await resolvePATHFromLoginShell();
    assert.equal(path1, '/usr/bin');

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      calls++;
      cb(new Error('should not run'), '', '');
      return undefined as any;
    }) as any);

    const path2 = await resolvePATHFromLoginShell();
    assert.equal(path2, '/usr/bin');
    assert.equal(calls, 1);
  });

  test('retries after failure', async () => {
    let callCount = 0;
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        cb(new Error('spawn fail'), '', '');
      } else {
        cb(null, '/custom/path', '');
      }
      return undefined as any;
    }) as any);

    const first = await resolvePATHFromLoginShell();
    assert.equal(first, undefined);

    const second = await resolvePATHFromLoginShell();
    assert.equal(second, '/custom/path');
    assert.equal(callCount, 2);
  });
});
