import assert from 'assert/strict';
const proxyquire: any = require('proxyquire');

suite('cli telemetry', () => {
  test('sends telemetry on ENOENT', async () => {
    const calls: any[] = [];
    const { getOrgAuth, __setExecFileImplForTests, __resetExecFileImplForTests } = proxyquire('../salesforce/cli', {
      '../shared/telemetry': {
        safeSendException: (name: string, properties: Record<string, string>) => {
          calls.push({ name, properties });
        }
      }
    });

    __setExecFileImplForTests(((_program: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      const err: any = new Error('not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    await assert.rejects(getOrgAuth(undefined));
    __resetExecFileImplForTests();
    assert.ok(calls.some(c => c.properties?.code === 'ENOENT'));
  });

  test('sends telemetry on ETIMEDOUT', async () => {
    const calls: any[] = [];
    const { getOrgAuth, __setExecFileImplForTests, __resetExecFileImplForTests } = proxyquire('../salesforce/cli', {
      '../shared/telemetry': {
        safeSendException: (name: string, properties: Record<string, string>) => {
          calls.push({ name, properties });
        }
      }
    });

    __setExecFileImplForTests(((_program: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      const err: any = new Error('timeout');
      err.code = 'ETIMEDOUT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    await assert.rejects(getOrgAuth(undefined));
    __resetExecFileImplForTests();
    assert.ok(calls.some(c => c.properties?.code === 'ETIMEDOUT'));
  });
});
