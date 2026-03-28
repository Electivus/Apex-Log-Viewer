import assert from 'assert/strict';
const proxyquire: any = require('proxyquire').noCallThru();

suite('cli telemetry', () => {
  test('sends telemetry on ENOENT', async () => {
    const calls: any[] = [];
    const telemetry = (name: string, properties: Record<string, string>) => {
      calls.push({ name, properties });
    };
    const cliStubs = {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
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
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
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
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
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
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
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
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
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
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
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
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
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
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
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
      ['sf'],
      'expected to stop after the first semantic failure for the sf CLI family'
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
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
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
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
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
      ['sf'],
      'expected to stop after the first semantic failure for the sf CLI family'
    );
    assert.ok(
      calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'AUTH_REQUIRED'),
      'expected semantic auth-required telemetry'
    );
    assert.ok(!calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'AUTH_FAILED'));
  });

  test('does not reuse a prior terminal auth code across CLI families on the initial PATH', async () => {
    const attempts: Array<{ program: string; args: string[] }> = [];
    const telemetry = () => undefined;
    const cliStubs = {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, '@noCallThru': true },
      '../utils/config': {
        getBooleanConfig: (_name: string, def: boolean) => def,
        getConfig: <T>(name: string, def?: T) => (name === 'sfLogs.cliPath' ? ('C:\\stale\\sf.cmd' as T) : def),
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
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
      ...cliStubs,
      './exec': execModule,
      '@noCallThru': true
    });
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      const argList = Array.isArray(args) ? [...args] : [];
      attempts.push({ program, args: argList });
      if (program === 'C:\\stale\\sf.cmd') {
        const err: any = new Error('auth required');
        err.code = 1;
        cb(err, '', 'No authorization information found. Run "sf org login web" to authorize an org.');
        return undefined as any;
      }
      if (program === 'sf') {
        if (argList.join(' ') === 'org display --json --verbose') {
          const err: any = new Error('unsupported command shape');
          err.code = 1;
          cb(err, '', 'Unexpected argument: --verbose');
          return undefined as any;
        }
        cb(
          null,
          JSON.stringify({
            result: {
              accessToken: '00D-token',
              instanceUrl: 'https://example.my.salesforce.com',
              username: 'user@example.com'
            }
          }),
          ''
        );
        return undefined as any;
      }
      const err: any = new Error('not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    const auth = await getOrgAuth(undefined);
    __resetExecFileImplForTests();

    assert.equal(auth.username, 'user@example.com');
    assert.deepEqual(
      attempts.filter(attempt => attempt.program === 'sf').map(attempt => attempt.args.join(' ')).slice(0, 2),
      ['org display --json --verbose', 'org user display --json --verbose'],
      'expected the plain sf family to continue after a non-terminal error'
    );
  });

  test('retries with login-shell PATH before surfacing a terminal auth error from a mixed failure set', async () => {
    const calls: any[] = [];
    const attempts: Array<{ program: string; path: string | undefined }> = [];
    let loginPathCalls = 0;
    const telemetry = (name: string, properties: Record<string, string>) => {
      calls.push({ name, properties });
    };
    const cliStubs = {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, '@noCallThru': true },
      '../utils/config': {
        getBooleanConfig: (_name: string, def: boolean) => def,
        getConfig: <T>(name: string, def?: T) => (name === 'sfLogs.cliPath' ? ('C:\\stale\\sf.cmd' as T) : def),
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
        resolvePATHFromLoginShell: async () => {
          loginPathCalls++;
          return 'C:\\login-shell\\bin';
        },
        '@noCallThru': true
      }
    };
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
      ...cliStubs,
      './exec': execModule,
      '@noCallThru': true
    });
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;

    __setExecFileImplForTests(((program: string, _args: readonly string[] | undefined, opts: any, cb: any) => {
      const pathValue = String(opts?.env?.PATH || '');
      attempts.push({ program, path: pathValue || undefined });
      if (!pathValue && program === 'C:\\stale\\sf.cmd') {
        const err: any = new Error('not found');
        err.code = 'ENOENT';
        cb(err, '', '');
        return undefined as any;
      }
      if (!pathValue && program === 'sf') {
        const err: any = new Error('auth required');
        err.code = 1;
        cb(err, '', 'No authorization information found. Run "sf org login web" to authorize an org.');
        return undefined as any;
      }
      if (pathValue === 'C:\\login-shell\\bin' && program === 'sf') {
        cb(
          null,
          JSON.stringify({
            result: {
              accessToken: '00D-token',
              instanceUrl: 'https://example.my.salesforce.com',
              username: 'user@example.com'
            }
          }),
          ''
        );
        return undefined as any;
      }
      const err: any = new Error('not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    const auth = await getOrgAuth(undefined);
    __resetExecFileImplForTests();

    assert.equal(auth.instanceUrl, 'https://example.my.salesforce.com');
    assert.equal(loginPathCalls, 1, 'expected login-shell PATH fallback to run');
    assert.ok(
      attempts.some(attempt => attempt.program === 'sf' && attempt.path === 'C:\\login-shell\\bin'),
      'expected a retry with the login-shell PATH'
    );
    assert.ok(
      calls.some(c => c.name === 'cli.getOrgAuth' && c.properties?.code === 'AUTH_REQUIRED'),
      'expected the mixed semantic failure to stay classified in telemetry'
    );
  });

  test('does not reuse a prior terminal auth code across CLI families on login-shell PATH', async () => {
    const attempts: Array<{ program: string; args: string[]; path: string | undefined }> = [];
    let loginPathCalls = 0;
    const telemetry = () => undefined;
    const cliStubs = {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, '@noCallThru': true },
      '../utils/config': {
        getBooleanConfig: (_name: string, def: boolean) => def,
        getConfig: <T>(name: string, def?: T) => (name === 'sfLogs.cliPath' ? ('C:\\stale\\sf.cmd' as T) : def),
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
        resolvePATHFromLoginShell: async () => {
          loginPathCalls++;
          return 'C:\\login-shell\\bin';
        },
        '@noCallThru': true
      }
    };
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
      ...cliStubs,
      './exec': execModule,
      '@noCallThru': true
    });
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, opts: any, cb: any) => {
      const argList = Array.isArray(args) ? [...args] : [];
      const pathValue = String(opts?.env?.PATH || '');
      attempts.push({ program, args: argList, path: pathValue || undefined });
      if (!pathValue) {
        const err: any = new Error('not found');
        err.code = 'ENOENT';
        cb(err, '', '');
        return undefined as any;
      }
      if (pathValue === 'C:\\login-shell\\bin' && program === 'C:\\stale\\sf.cmd') {
        const err: any = new Error('auth required');
        err.code = 1;
        cb(err, '', 'No authorization information found. Run "sf org login web" to authorize an org.');
        return undefined as any;
      }
      if (pathValue === 'C:\\login-shell\\bin' && program === 'sf') {
        if (argList.join(' ') === 'org display --json --verbose') {
          const err: any = new Error('unsupported command shape');
          err.code = 1;
          cb(err, '', 'Unexpected argument: --verbose');
          return undefined as any;
        }
        cb(
          null,
          JSON.stringify({
            result: {
              accessToken: '00D-token',
              instanceUrl: 'https://example.my.salesforce.com',
              username: 'user@example.com'
            }
          }),
          ''
        );
        return undefined as any;
      }
      const err: any = new Error('not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    const auth = await getOrgAuth(undefined);
    __resetExecFileImplForTests();

    assert.equal(auth.instanceUrl, 'https://example.my.salesforce.com');
    assert.equal(loginPathCalls, 1, 'expected one login-shell PATH resolution');
    assert.deepEqual(
      attempts
        .filter(attempt => attempt.program === 'sf' && attempt.path === 'C:\\login-shell\\bin')
        .map(attempt => attempt.args.join(' '))
        .slice(0, 2),
      ['org display --json --verbose', 'org user display --json --verbose'],
      'expected the plain sf family to continue after a non-terminal login-shell failure'
    );
  });

  test('continues to the next CLI family on login-shell PATH after a terminal failure in the current family', async () => {
    const attempts: Array<{ program: string; path: string | undefined }> = [];
    let loginPathCalls = 0;
    const telemetry = () => undefined;
    const cliStubs = {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, '@noCallThru': true },
      '../utils/config': {
        getBooleanConfig: (_name: string, def: boolean) => def,
        getConfig: <T>(name: string, def?: T) => (name === 'sfLogs.cliPath' ? ('C:\\stale\\sf.cmd' as T) : def),
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
        resolvePATHFromLoginShell: async () => {
          loginPathCalls++;
          return 'C:\\login-shell\\bin';
        },
        '@noCallThru': true
      }
    };
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
      ...cliStubs,
      './exec': execModule,
      '@noCallThru': true
    });
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;

    __setExecFileImplForTests(((program: string, _args: readonly string[] | undefined, opts: any, cb: any) => {
      const pathValue = String(opts?.env?.PATH || '');
      attempts.push({ program, path: pathValue || undefined });
      if (!pathValue) {
        const err: any = new Error('not found');
        err.code = 'ENOENT';
        cb(err, '', '');
        return undefined as any;
      }
      if (pathValue === 'C:\\login-shell\\bin' && program === 'C:\\stale\\sf.cmd') {
        const err: any = new Error('auth required');
        err.code = 1;
        cb(err, '', 'No authorization information found. Run "sf org login web" to authorize an org.');
        return undefined as any;
      }
      if (pathValue === 'C:\\login-shell\\bin' && program === 'sf') {
        cb(
          null,
          JSON.stringify({
            result: {
              accessToken: '00D-token',
              instanceUrl: 'https://example.my.salesforce.com',
              username: 'user@example.com'
            }
          }),
          ''
        );
        return undefined as any;
      }
      const err: any = new Error('not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    const auth = await getOrgAuth(undefined);
    __resetExecFileImplForTests();

    assert.equal(auth.username, 'user@example.com');
    assert.equal(loginPathCalls, 1, 'expected one login-shell PATH resolution');
    assert.ok(
      attempts.some(attempt => attempt.program === 'C:\\stale\\sf.cmd' && attempt.path === 'C:\\login-shell\\bin'),
      'expected the configured CLI family to be retried on login-shell PATH'
    );
    assert.ok(
      attempts.some(attempt => attempt.program === 'sf' && attempt.path === 'C:\\login-shell\\bin'),
      'expected the next CLI family to still run on login-shell PATH'
    );
  });

  test('classifies empty CLI output during auth parsing', async () => {
    const calls: any[] = [];
    const telemetry = (name: string, properties: Record<string, string>) => {
      calls.push({ name, properties });
    };
    const cliStubs = {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
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
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
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
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
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
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
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
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
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
    const execModule = proxyquire('../../../../src/salesforce/exec', {
      '../../apps/vscode-extension/src/shared/telemetry': { safeSendException: telemetry, '@noCallThru': true },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true }
    });
    const { getOrgAuth } = proxyquire('../../../../src/salesforce/cli', {
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
