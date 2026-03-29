import assert from 'assert/strict';
const proxyquire: any = require('proxyquire').noCallThru().noPreserveCache();

type ExecModule = typeof import('../../../../src/salesforce/exec');

function loadExecModule(): ExecModule {
  return proxyquire('../../../../src/salesforce/exec', {
    '../../../../src/utils/logger': { logTrace: () => {}, logWarn: () => {}, '@noCallThru': true },
    '../../../../src/utils/localize': { localize: (_key: string, fallback: string) => fallback, '@noCallThru': true },
    '../shared/telemetry': { safeSendException: () => {}, '@noCallThru': true }
  }) as ExecModule;
}

function loadPathModule(params: { platform: 'win32' | 'linux' | 'darwin'; execModule: ExecModule }) {
  return proxyquire('../../../../src/salesforce/path', {
    os: { platform: () => params.platform, '@noCallThru': true },
    './exec': params.execModule,
    '../../../../src/utils/logger': { logTrace: () => {}, '@noCallThru': true }
  }) as typeof import('../../../../src/salesforce/path');
}

suite('resolvePATHFromLoginShell', () => {
  test('resolves PATH from PowerShell login shell on win32', async () => {
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
      assert.equal(program, 'pwsh');
      assert.deepEqual(args, ['-NoLogo', '-Login', '-Command', '$env:PATH']);
      cb(null, 'C:\\Users\\k2\\AppData\\Roaming\\fnm\\current\\bin', '');
      return undefined as any;
    }) as any);

    const pathValue = await resolvePATHFromLoginShell();
    assert.equal(pathValue, 'C:\\Users\\k2\\AppData\\Roaming\\fnm\\current\\bin');
    assert.equal(calls, 1);
    __resetExecFileImplForTests();
  });

  test('getLoginShellEnv uses the login-shell PATH when the current PATH does not resolve sf on win32', async () => {
    const execModule = loadExecModule();
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;
    const { getLoginShellEnv, __resetLoginShellPATHForTests } = loadPathModule({
      platform: 'win32',
      execModule
    });
    __resetLoginShellPATHForTests();

    const originalPath = process.env.PATH;
    const originalPathCase = process.env.Path;
    const originalComSpec = process.env.ComSpec;
    const currentPath = 'C:\\Users\\k2\\AppData\\Roaming\\fnm\\aliases\\default';
    const loginPath = 'C:\\Users\\k2\\AppData\\Roaming\\fnm\\current\\bin';
    const sfShim = `${loginPath}\\sf.cmd`;
    process.env.PATH = currentPath;
    process.env.Path = currentPath;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

    let calls = 0;
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, opts: any, cb: any) => {
      calls++;
      if (calls === 1) {
        assert.match(program.toLowerCase(), /cmd\.exe$/);
        assert.deepEqual(args, ['/d', '/s', '/c', 'where sf']);
        assert.equal(opts?.env?.PATH, currentPath);
        assert.equal(opts?.env?.Path, currentPath);
        cb(new Error('where failed'), '', '');
        return undefined as any;
      }

      if (calls === 2) {
        assert.equal(program, 'C:\\Program Files\\Git\\bin\\bash.exe');
        assert.deepEqual(args, [
          '-lc',
          'command -v sf.cmd >/dev/null 2>&1 && cygpath -w "$(command -v sf.cmd)" || command -v sf >/dev/null 2>&1 && cygpath -w "$(command -v sf)"'
        ]);
        assert.equal(opts?.env?.PATH, currentPath);
        assert.equal(opts?.env?.Path, currentPath);
        cb(undefined, '', '');
        return undefined as any;
      }

      if (calls === 3) {
        assert.equal(program, 'pwsh');
        assert.deepEqual(args, ['-NoLogo', '-Login', '-Command', '$env:PATH']);
        cb(null, loginPath, '');
        return undefined as any;
      }

      assert.match(program.toLowerCase(), /cmd\.exe$/);
      assert.deepEqual(args, ['/d', '/s', '/c', 'where sf']);
      assert.equal(opts?.env?.PATH, loginPath);
      assert.equal(opts?.env?.Path, loginPath);
      cb(null, `${loginPath}\\sf\r\n${sfShim}`, '');
      return undefined as any;
    }) as any);

    try {
      const envValue = await getLoginShellEnv();
      assert.equal(envValue?.PATH, loginPath);
      assert.equal(envValue?.Path, loginPath);
      assert.equal(envValue?.ALV_SF_BIN_PATH, sfShim);
      assert.equal(calls, 4);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathCase === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalPathCase;
      }
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      __resetExecFileImplForTests();
    }
  });

  test('getLoginShellEnv skips login-shell probing when current PATH already resolves sf.cmd on win32', async () => {
    const execModule = loadExecModule();
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;
    const { getLoginShellEnv, __resetLoginShellPATHForTests } = loadPathModule({
      platform: 'win32',
      execModule
    });
    __resetLoginShellPATHForTests();

    const originalPath = process.env.PATH;
    const originalPathCase = process.env.Path;
    const originalComSpec = process.env.ComSpec;
    const currentPath = 'C:\\Users\\k2\\AppData\\Roaming\\fnm\\aliases\\default';
    const sfShim = `${currentPath}\\sf.cmd`;
    process.env.PATH = currentPath;
    process.env.Path = currentPath;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

    let calls = 0;
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, opts: any, cb: any) => {
      calls++;
      assert.match(program.toLowerCase(), /cmd\.exe$/);
      assert.deepEqual(args, ['/d', '/s', '/c', 'where sf']);
      assert.equal(opts?.env?.PATH, currentPath);
      assert.equal(opts?.env?.Path, currentPath);
      cb(null, `${currentPath}\\sf\r\n${sfShim}`, '');
      return undefined as any;
    }) as any);

    try {
      const envValue = await getLoginShellEnv();
      assert.equal(envValue?.PATH, currentPath);
      assert.equal(envValue?.Path, currentPath);
      assert.equal(envValue?.ALV_SF_BIN_PATH, sfShim);
      assert.equal(calls, 1);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathCase === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalPathCase;
      }
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      __resetExecFileImplForTests();
    }
  });

  test('getLoginShellEnv falls back to Git Bash when where sf fails on win32', async () => {
    const execModule = loadExecModule();
    const { __setExecFileImplForTests, __resetExecFileImplForTests } = execModule;
    const { getLoginShellEnv, __resetLoginShellPATHForTests } = loadPathModule({
      platform: 'win32',
      execModule
    });
    __resetLoginShellPATHForTests();

    const originalPath = process.env.PATH;
    const originalPathCase = process.env.Path;
    const currentPath = 'C:\\Users\\k2\\AppData\\Roaming\\fnm\\aliases\\default';
    const sfShim = `${currentPath}\\sf.cmd`;
    process.env.PATH = currentPath;
    process.env.Path = currentPath;

    let calls = 0;
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, opts: any, cb: any) => {
      calls++;
      if (calls === 1) {
        assert.match(program.toLowerCase(), /cmd\.exe$/);
        assert.deepEqual(args, ['/d', '/s', '/c', 'where sf']);
        assert.equal(opts?.env?.PATH, currentPath);
        assert.equal(opts?.env?.Path, currentPath);
        cb(new Error('where failed'), '', '');
        return undefined as any;
      }

      if (calls === 2) {
        assert.equal(program, 'C:\\Program Files\\Git\\bin\\bash.exe');
        assert.deepEqual(args, [
          '-lc',
          'command -v sf.cmd >/dev/null 2>&1 && cygpath -w "$(command -v sf.cmd)" || command -v sf >/dev/null 2>&1 && cygpath -w "$(command -v sf)"'
        ]);
        assert.equal(opts?.env?.PATH, currentPath);
        assert.equal(opts?.env?.Path, currentPath);
        cb(undefined, '', '');
        return undefined as any;
      }

      if (calls === 3) {
        assert.equal(program, 'pwsh');
        assert.deepEqual(args, ['-NoLogo', '-Login', '-Command', '$env:PATH']);
        cb(null, currentPath, '');
        return undefined as any;
      }

      if (calls === 4) {
        assert.match(program.toLowerCase(), /cmd\.exe$/);
        assert.deepEqual(args, ['/d', '/s', '/c', 'where sf']);
        assert.equal(opts?.env?.PATH, currentPath);
        assert.equal(opts?.env?.Path, currentPath);
        cb(new Error('where failed'), '', '');
        return undefined as any;
      }

      assert.equal(program, 'C:\\Program Files\\Git\\bin\\bash.exe');
      assert.deepEqual(args, [
        '-lc',
        'command -v sf.cmd >/dev/null 2>&1 && cygpath -w "$(command -v sf.cmd)" || command -v sf >/dev/null 2>&1 && cygpath -w "$(command -v sf)"'
      ]);
      assert.equal(opts?.env?.PATH, currentPath);
      assert.equal(opts?.env?.Path, currentPath);
      cb(null, sfShim, '');
      return undefined as any;
    }) as any);

    try {
      const envValue = await getLoginShellEnv();
      assert.equal(envValue?.ALV_SF_BIN_PATH, sfShim);
      assert.equal(calls, 5);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathCase === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalPathCase;
      }
      __resetExecFileImplForTests();
    }
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
