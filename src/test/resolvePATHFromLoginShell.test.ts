import assert from 'assert/strict';
import { resolvePATHFromLoginShell, __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce';

suite('resolvePATHFromLoginShell', () => {
  teardown(() => {
    __resetExecFileImplForTests();
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
