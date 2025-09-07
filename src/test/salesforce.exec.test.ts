import assert from 'assert/strict';
import {
  getOrgAuth,
  __setExecFileImplForTests,
  __resetExecFileImplForTests,
  __getInFlightExecsSizeForTests
} from '../salesforce/cli';

suite('salesforce exec safety', () => {
  teardown(() => {
    __resetExecFileImplForTests();
  });

  test('passes alias with spaces/special chars as single argv', async () => {
    const alias = "My Alias; echo 'oops' | cat";
    let capturedProgram: string | undefined;
    let capturedArgs: readonly string[] | undefined;

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      capturedProgram = program;
      capturedArgs = args;
      // Return a minimal successful JSON payload similar to sf/sfdx
      const stdout = JSON.stringify({
        result: {
          accessToken: 'token',
          instanceUrl: 'https://example.my.salesforce.com',
          username: 'user@example.com'
        }
      });
      cb(null, stdout, '');
      return undefined as any;
    }) as any);

    const auth = await getOrgAuth(alias);
    assert.equal(auth.instanceUrl, 'https://example.my.salesforce.com');
    assert.equal(auth.accessToken, 'token');

    assert.equal(capturedProgram, 'sf');
    assert.ok(Array.isArray(capturedArgs));
    const args = capturedArgs as string[];
    // Ensure -o and the exact alias value are consecutive args
    const idx = args.indexOf('-o');
    assert.ok(idx >= 0, 'expected -o flag to be present');
    assert.equal(args[idx + 1], alias, 'alias should be single argv item, unchanged');
  });

  test('reports missing CLI when ENOENT is raised', async () => {
    __setExecFileImplForTests(((_program: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      const err: any = new Error('command not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    // Should surface a friendly error after trying both sf and sfdx
    await assert.rejects(getOrgAuth(undefined), (e: any) => {
      assert.match(String(e?.message || ''), /CLI não encontrada|CLI not found|Salesforce CLI/);
      return true;
    });
  });

  test('cleans up inFlightExecs on sync throw', async () => {
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, _cb: any) => {
      throw new Error('boom');
    }) as any);

    const before = __getInFlightExecsSizeForTests();
    await assert.rejects(getOrgAuth(undefined, true));
    assert.equal(__getInFlightExecsSizeForTests(), before);
  });
});
