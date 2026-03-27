import path from 'node:path';
import {
  resolveCachedSupportExtensionsDir,
  resolveSupportExtensionsLockPath,
  resolveVscodeCachePath,
  resolveWindowSizeArg,
  resolveExtensionsDirForMissingDependencies,
  resolveSupportExtensionIds,
  shouldAllowLocalExtensionsDirFallback
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

describe('extensions dir fallback policy', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('keeps the isolated extensions dir by default when support extensions are still missing', () => {
    delete process.env.ALV_E2E_ALLOW_LOCAL_EXTENSIONS_DIR;

    expect(shouldAllowLocalExtensionsDirFallback()).toBe(false);
    expect(
      resolveExtensionsDirForMissingDependencies({
        isolatedExtensionsDir: '/tmp/alv-e2e-exts',
        missingExtensionIds: ['salesforce.salesforcedx-vscode-apex-replay-debugger'],
        localExtensionsRoot: '/home/test/.vscode/extensions'
      })
    ).toEqual({
      extensionsDir: '/tmp/alv-e2e-exts',
      warning:
        '[e2e] Support extensions still missing in isolated profile: salesforce.salesforcedx-vscode-apex-replay-debugger.' +
        ' Set ALV_E2E_ALLOW_LOCAL_EXTENSIONS_DIR=1 to opt into using the local VS Code extensions dir.'
    });
  });

  test('allows whole-dir fallback only when explicitly opted in', () => {
    process.env.ALV_E2E_ALLOW_LOCAL_EXTENSIONS_DIR = '1';

    expect(shouldAllowLocalExtensionsDirFallback()).toBe(true);
    expect(
      resolveExtensionsDirForMissingDependencies({
        isolatedExtensionsDir: '/tmp/alv-e2e-exts',
        missingExtensionIds: ['salesforce.salesforcedx-vscode-apex-replay-debugger'],
        localExtensionsRoot: '/home/test/.vscode/extensions'
      })
    ).toEqual({
      extensionsDir: '/home/test/.vscode/extensions',
      warning: '[e2e] Falling back to local VS Code extensions dir: /home/test/.vscode/extensions'
    });
  });
});

describe('VS Code cache paths', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('defaults the VS Code cache path to the repo-local .vscode-test directory', () => {
    delete process.env.VSCODE_TEST_CACHE_PATH;

    expect(resolveVscodeCachePath('/workspace/alv')).toBe(path.join('/workspace/alv', '.vscode-test'));
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
