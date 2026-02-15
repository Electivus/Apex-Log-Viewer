import assert from 'assert/strict';
const proxyquire: any = require('proxyquire').noCallThru().noPreserveCache();

type ExecModule = typeof import('../salesforce/exec');

function loadExecModule(): ExecModule {
  return proxyquire('../salesforce/exec', {
    '../utils/logger': { logTrace: () => {}, logWarn: () => {}, '@noCallThru': true },
    '../utils/localize': { localize: (_key: string, fallback: string) => fallback, '@noCallThru': true },
    '../shared/telemetry': { safeSendException: () => {}, '@noCallThru': true }
  }) as ExecModule;
}

function loadPathModule(params: { platform: 'win32' | 'linux' | 'darwin'; execModule: ExecModule }) {
  return proxyquire('../salesforce/path', {
    os: { platform: () => params.platform, '@noCallThru': true },
    './exec': params.execModule,
    '../utils/logger': { logTrace: () => {}, '@noCallThru': true }
  }) as typeof import('../salesforce/path');
}

suite('resolvePATHFromLoginShell', () => {
  test('returns undefined on win32 without spawning', async () => {
    const execModule = loadExecModule();
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;
    const { resolvePATHFromLoginShell, __resetLoginShellPATHForTests } = loadPathModule({
      platform: 'win32',
      execModule
    });
    __resetLoginShellPATHForTests();

    let calls = 0;
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      calls++;
      cb(null, '/custom/path', '');
      return undefined as any;
    }) as any);

    const pathValue = await resolvePATHFromLoginShell();
    assert.equal(pathValue, undefined);
    assert.equal(calls, 0);
    __resetExecFileImplForTests();
  });

  test('caches PATH on success', async () => {
    const execModule = loadExecModule();
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;
    const { resolvePATHFromLoginShell, __resetLoginShellPATHForTests } = loadPathModule({
      platform: 'linux',
      execModule
    });
    __resetLoginShellPATHForTests();

    let calls = 0;
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      calls++;
      cb(null, '/custom/path', '');
      return undefined as any;
    }) as any);

    const path1 = await resolvePATHFromLoginShell();
    assert.equal(path1, '/custom/path');

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      calls++;
      cb(new Error('should not run'), '', '');
      return undefined as any;
    }) as any);

    const path2 = await resolvePATHFromLoginShell();
    assert.equal(path2, '/custom/path');
    assert.equal(calls, 1);
    __resetExecFileImplForTests();
  });

  test('retries after failure', async () => {
    const execModule = loadExecModule();
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;
    const { resolvePATHFromLoginShell, __resetLoginShellPATHForTests } = loadPathModule({
      platform: 'linux',
      execModule
    });
    __resetLoginShellPATHForTests();

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
    __resetExecFileImplForTests();
  });
});
