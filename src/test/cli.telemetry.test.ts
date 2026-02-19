import assert from 'assert/strict';
const proxyquire: any = require('proxyquire');

suite('cli telemetry', () => {
  test('sends telemetry on ENOENT', async () => {
    const calls: any[] = [];
    const telemetry = (name: string, properties: Record<string, string>) => {
      calls.push({ name, properties });
    };
    const execModule = proxyquire('../salesforce/exec', {
      '../shared/telemetry': { safeSendException: telemetry }
    });
    const { getOrgAuth } = proxyquire('../salesforce/cli', {
      '../shared/telemetry': { safeSendException: telemetry },
      './exec': execModule
    });
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;

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
    const telemetry = (name: string, properties: Record<string, string>) => {
      calls.push({ name, properties });
    };
    const execModule = proxyquire('../salesforce/exec', {
      '../shared/telemetry': { safeSendException: telemetry }
    });
    const { getOrgAuth } = proxyquire('../salesforce/cli', {
      '../shared/telemetry': { safeSendException: telemetry },
      './exec': execModule
    });
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;

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
