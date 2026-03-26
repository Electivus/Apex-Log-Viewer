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

  test('classifies default-org CLI failures without leaking exit code 1', async () => {
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
      const err: any = new Error('default org missing');
      err.code = 1;
      cb(err, '', 'No default username found. Use -o or set a default org.');
      return undefined as any;
    }) as any);

    await assert.rejects(getOrgAuth(undefined));
    __resetExecFileImplForTests();
    assert.ok(
      calls.some(c => c.name === 'cli.exec' && c.properties?.code === 'DEFAULT_ORG_MISSING'),
      'expected cli.exec to classify the error'
    );
    assert.ok(
      calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'DEFAULT_ORG_MISSING'),
      'expected cli.getOrgAuth to reuse the classified code'
    );
    assert.ok(!calls.some(c => c.properties?.code === '1'), 'should not emit the raw exit code 1');
  });

  test('stops retrying redundant sf auth commands after a default-org failure and surfaces a specific error', async () => {
    const calls: any[] = [];
    const attempts: Array<{ program: string; args: string[] }> = [];
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

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      attempts.push({ program, args: Array.isArray(args) ? [...args] : [] });
      const err: any = new Error('default org missing');
      err.code = 1;
      cb(err, '', 'No default username found. Use -o or set a default org.');
      return undefined as any;
    }) as any);

    await assert.rejects(getOrgAuth(undefined), (e: any) => {
      assert.match(String(e?.message || ''), /default org|default username|set a default org/i);
      return true;
    });
    __resetExecFileImplForTests();

    assert.deepEqual(
      attempts.map(attempt => attempt.program),
      ['sf', 'sfdx'],
      'expected to stop after the first semantic failure for each CLI family'
    );
    assert.ok(
      calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'DEFAULT_ORG_MISSING'),
      'expected semantic auth failure telemetry'
    );
    assert.ok(!calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'AUTH_FAILED'));
  });

  test('stops retrying redundant sf auth commands after an auth-required failure and surfaces login guidance', async () => {
    const calls: any[] = [];
    const attempts: Array<{ program: string; args: string[] }> = [];
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

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      attempts.push({ program, args: Array.isArray(args) ? [...args] : [] });
      const err: any = new Error('auth required');
      err.code = 1;
      cb(err, '', 'No authorization information found. Run "sf org login web" to authorize an org.');
      return undefined as any;
    }) as any);

    await assert.rejects(getOrgAuth(undefined), (e: any) => {
      assert.match(String(e?.message || ''), /org login web|authenticate|authorization/i);
      return true;
    });
    __resetExecFileImplForTests();

    assert.deepEqual(
      attempts.map(attempt => attempt.program),
      ['sf', 'sfdx'],
      'expected to stop after the first semantic failure for each CLI family'
    );
    assert.ok(
      calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'AUTH_REQUIRED'),
      'expected semantic auth-required telemetry'
    );
    assert.ok(!calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'AUTH_FAILED'));
  });

  test('classifies empty CLI output during auth parsing', async () => {
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
      cb(null, '   ', '');
      return undefined as any;
    }) as any);

    await assert.rejects(getOrgAuth(undefined));
    __resetExecFileImplForTests();
    assert.ok(calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'EMPTY_OUTPUT'));
    assert.ok(!calls.some(c => c.properties?.code === '1'), 'should not emit the raw exit code 1');
  });

  test('classifies invalid CLI JSON during auth parsing', async () => {
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
      cb(null, 'not-json', '');
      return undefined as any;
    }) as any);

    await assert.rejects(getOrgAuth(undefined));
    __resetExecFileImplForTests();
    assert.ok(calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'INVALID_JSON'));
    assert.ok(!calls.some(c => c.properties?.code === '1'), 'should not emit the raw exit code 1');
  });

  test('classifies missing auth fields when CLI JSON lacks credentials', async () => {
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
      cb(null, JSON.stringify({ result: { username: 'user@example.com' } }), '');
      return undefined as any;
    }) as any);

    await assert.rejects(getOrgAuth(undefined));
    __resetExecFileImplForTests();
    assert.ok(calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'MISSING_AUTH_FIELDS'));
    assert.ok(!calls.some(c => c.properties?.code === '1'), 'should not emit the raw exit code 1');
  });
});
