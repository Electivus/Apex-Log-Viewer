import path from 'node:path';
import {
  createMissingSupportExtensionsError,
  resolveCachedSupportExtensionsDir,
  resolveCliSpawnInvocation,
  resolveExtensionDevelopmentPath,
  resolveSupportExtensionsLockPath,
  resolveVscodeCachePath,
  resolveWindowSizeArg,
  resolveSupportExtensionIds
} from '../vscode';

describe('resolveSupportExtensionIds', () => {
  test('keeps replay debugger support local to the scenario', () => {
    expect(resolveSupportExtensionIds(['salesforce.salesforcedx-vscode-apex-replay-debugger'])).toEqual([
      'salesforce.salesforcedx-vscode-apex-replay-debugger'
    ]);
  });

  test('dedupes and trims manifest and scenario extension ids', () => {
    expect(
      resolveSupportExtensionIds(
        [' salesforce.salesforcedx-vscode-core ', '', 'salesforce.salesforcedx-vscode-core'],
        ['salesforce.salesforcedx-vscode-apex-replay-debugger', 'salesforce.salesforcedx-vscode-core']
      )
    ).toEqual(['salesforce.salesforcedx-vscode-apex-replay-debugger', 'salesforce.salesforcedx-vscode-core']);
  });
});

describe('missing support extensions', () => {
  test('fails with an explicit error instead of falling back to local user extensions', () => {
    expect(
      createMissingSupportExtensionsError([
        'salesforce.salesforcedx-vscode-core',
        'salesforce.salesforcedx-vscode-apex-replay-debugger'
      ]).message
    ).toBe(
      '[e2e] Required VS Code support extensions are missing from the isolated profile: ' +
        'salesforce.salesforcedx-vscode-core, salesforce.salesforcedx-vscode-apex-replay-debugger'
    );
  });
});

describe('resolveCliSpawnInvocation', () => {
  test('keeps direct CLI execution on non-Windows platforms', () => {
    expect(resolveCliSpawnInvocation('/usr/local/bin/code', ['--install-extension', 'publisher.extension'], 'linux')).toEqual(
      {
        command: '/usr/local/bin/code',
        args: ['--install-extension', 'publisher.extension']
      }
    );
  });

  test('wraps Windows .cmd CLIs through cmd.exe with quoted arguments', () => {
    const invocation = resolveCliSpawnInvocation(
      'C:\\VS Code\\bin\\code.cmd',
      ['--extensions-dir', 'C:\\Temp\\support extensions', '--install-extension', 'publisher.extension'],
      'win32'
    );

    expect(invocation.command).toBe(process.env.ComSpec || 'cmd.exe');
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(invocation.args[3]).toContain('"C:\\VS Code\\bin\\code.cmd"');
    expect(invocation.args[3]).toContain('--extensions-dir');
    expect(invocation.args[3]).toContain('"C:\\Temp\\support extensions"');
    expect(invocation.args[3]).toContain('publisher.extension');
  });
});

describe('VS Code cache paths', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('defaults the VS Code cache path to the monorepo root .vscode-test directory', () => {
    delete process.env.VSCODE_TEST_CACHE_PATH;

    expect(resolveVscodeCachePath('/workspace/alv/apps/vscode-extension')).toBe(path.join('/workspace/alv', '.vscode-test'));
  });

  test('honors VSCODE_TEST_CACHE_PATH when set', () => {
    process.env.VSCODE_TEST_CACHE_PATH = '../shared-vscode-cache';

    expect(resolveVscodeCachePath('/workspace/alv')).toBe(path.resolve('../shared-vscode-cache'));
  });

  test('stores support extensions under a version-scoped cache directory', () => {
    const extensionsDir = resolveCachedSupportExtensionsDir('/workspace/alv/.vscode-test', 'stable', [
      'salesforce.salesforcedx-vscode-core'
    ]);

    expect(path.dirname(extensionsDir)).toBe(path.join('/workspace/alv/.vscode-test', 'extensions', 'stable'));
  });

  test('normalizes the support extension cache key by extension set', () => {
    expect(
      resolveCachedSupportExtensionsDir('/workspace/alv/.vscode-test', 'stable', [
        ' salesforce.salesforcedx-vscode-core ',
        'salesforce.salesforcedx-vscode-apex-replay-debugger',
        'salesforce.salesforcedx-vscode-core'
      ])
    ).toBe(
      resolveCachedSupportExtensionsDir('/workspace/alv/.vscode-test', 'stable', [
        'salesforce.salesforcedx-vscode-apex-replay-debugger',
        'salesforce.salesforcedx-vscode-core'
      ])
    );
  });

  test('isolates support extension cache directories when the version or extension set changes', () => {
    expect(
      resolveCachedSupportExtensionsDir('/workspace/alv/.vscode-test', 'stable', [
        'salesforce.salesforcedx-vscode-core'
      ])
    ).not.toBe(
      resolveCachedSupportExtensionsDir('/workspace/alv/.vscode-test', 'stable', [
        'salesforce.salesforcedx-vscode-apex-replay-debugger'
      ])
    );

    expect(
      resolveCachedSupportExtensionsDir('/workspace/alv/.vscode-test', 'stable', [
        'salesforce.salesforcedx-vscode-core'
      ])
    ).not.toBe(
      resolveCachedSupportExtensionsDir('/workspace/alv/.vscode-test', 'insiders', [
        'salesforce.salesforcedx-vscode-core'
      ])
    );
  });

  test('stores the support extensions lock inside the resolved cache directory', () => {
    const extensionsDir = resolveCachedSupportExtensionsDir('/workspace/alv/.vscode-test', 'stable', [
      'salesforce.salesforcedx-vscode-core'
    ]);

    expect(resolveSupportExtensionsLockPath(extensionsDir)).toBe(path.join(extensionsDir, '.install.lock'));
  });
});

describe('extension development path', () => {
  test('resolves the extension manifest from the monorepo app package', () => {
    expect(resolveExtensionDevelopmentPath('/workspace/alv')).toBe(path.join('/workspace/alv', 'apps', 'vscode-extension'));
  });
});

describe('resolveWindowSizeArg', () => {
  test('formats a valid window size for VS Code launch args', () => {
    expect(resolveWindowSizeArg({ width: 1720, height: 1320 })).toBe('--window-size=1720,1320');
  });

  test('ignores missing or invalid dimensions', () => {
    expect(resolveWindowSizeArg()).toBeUndefined();
    expect(resolveWindowSizeArg({ width: 0, height: 1320 })).toBeUndefined();
    expect(resolveWindowSizeArg({ width: 1720, height: Number.NaN })).toBeUndefined();
  });
});
