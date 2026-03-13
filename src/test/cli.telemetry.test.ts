import assert from 'assert/strict';
const proxyquire: any = require('proxyquire').noCallThru();

suite('cli telemetry', () => {
  test('sends telemetry on ENOENT', async () => {
    const calls: any[] = [];
    const telemetry = (name: string, properties: Record<string, string>) => {
      calls.push({ name, properties });
    };
    const cliStubs = {
      '../shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, '@noCallThru': true },
      '../utils/config': {
        getBooleanConfig: (_name: string, def: boolean) => def,
        getConfig: <T>(_name: string, def?: T) => def,
        getNumberConfig: (_name: string, def: number) => def,
        '@noCallThru': true
      },
      '../utils/cacheManager': {
        CacheManager: {
          get: () => undefined,
          set: async () => undefined,
          delete: async () => undefined
        },
        '@noCallThru': true
      },
      './path': {
        resolvePATHFromLoginShell: async () => undefined,
        '@noCallThru': true
      }
    };
    const execModule = proxyquire('../salesforce/exec', {
      '../shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../salesforce/cli', {
      ...cliStubs,
      './exec': execModule,
      '@noCallThru': true
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
    const cliStubs = {
      '../shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, '@noCallThru': true },
      '../utils/config': {
        getBooleanConfig: (_name: string, def: boolean) => def,
        getConfig: <T>(_name: string, def?: T) => def,
        getNumberConfig: (_name: string, def: number) => def,
        '@noCallThru': true
      },
      '../utils/cacheManager': {
        CacheManager: {
          get: () => undefined,
          set: async () => undefined,
          delete: async () => undefined
        },
        '@noCallThru': true
      },
      './path': {
        resolvePATHFromLoginShell: async () => undefined,
        '@noCallThru': true
      }
    };
    const execModule = proxyquire('../salesforce/exec', {
      '../shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../salesforce/cli', {
      ...cliStubs,
      './exec': execModule,
      '@noCallThru': true
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
