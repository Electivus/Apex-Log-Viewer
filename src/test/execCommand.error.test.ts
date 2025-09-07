import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { __execCommandForTests, __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce/cli';

suite('execCommand error messages', () => {
  teardown(() => {
    __resetExecFileImplForTests();
  });

  test('includes command in missing CLI error', async () => {
    __setExecFileImplForTests(((_p: string, _a: readonly string[] | undefined, _o: any, cb: any) => {
      const err: any = new Error('not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    await assert.rejects(__execCommandForTests('sf', ['org', 'list'], undefined, 50), (e: any) => {
      assert.match(String(e?.message || ''), /CLI not found: sf org list/);
      return true;
    });
  });

  test('includes command and exit code on failure', async () => {
    __setExecFileImplForTests(((_p: string, _a: readonly string[] | undefined, _o: any, cb: any) => {
      const err: any = new Error('boom');
      err.code = 2;
      cb(err, '', 'boom');
      return undefined as any;
    }) as any);

    await assert.rejects(__execCommandForTests('sf', ['org', 'list', '--json'], undefined, 50), (e: any) => {
      assert.match(String(e?.message || ''), /"sf org list --json" exited with code 2/);
      return true;
    });
  });

  test('includes command in timeout error', async () => {
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _o: any, _cb: any) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      return child;
    }) as any);

    await assert.rejects(__execCommandForTests('sf', ['org', 'list', '--foo'], undefined, 10), (e: any) => {
      assert.equal(e.code, 'ETIMEDOUT');
      assert.match(String(e?.message || ''), /sf org list --foo/);
      return true;
    });
  });
});
