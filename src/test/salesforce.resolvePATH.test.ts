import assert from 'assert/strict';

function freshCli() {
  delete require.cache[require.resolve('../salesforce/cli')];
  return require('../salesforce/cli') as typeof import('../salesforce/cli');
}

suite('resolvePATHFromLoginShell', () => {
  test('caches PATH on success', async () => {
    const sf = freshCli();
    let calls = 0;
    sf.__setExecFileImplForTests(((_file: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      calls++;
      cb(null, '/usr/bin', '');
      return undefined as any;
    }) as any);

    const path1 = await sf.resolvePATHFromLoginShell();
    assert.equal(path1, '/usr/bin');

    sf.__setExecFileImplForTests(((_file: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      calls++;
      cb(new Error('should not run'), '', '');
      return undefined as any;
    }) as any);

    const path2 = await sf.resolvePATHFromLoginShell();
    assert.equal(path2, '/usr/bin');
    assert.equal(calls, 1);
    sf.__resetExecFileImplForTests();
  });

  test('retries after failure', async () => {
    const sf = freshCli();
    let calls = 0;
    sf.__setExecFileImplForTests(((_file: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      calls++;
      if (calls === 1) {
        cb(new Error('fail'), '', '');
      } else {
        cb(null, '/bin', '');
      }
      return undefined as any;
    }) as any);

    const path1 = await sf.resolvePATHFromLoginShell();
    assert.equal(path1, undefined);

    const path2 = await sf.resolvePATHFromLoginShell();
    assert.equal(path2, '/bin');
    assert.equal(calls, 2);
    sf.__resetExecFileImplForTests();
  });
});
