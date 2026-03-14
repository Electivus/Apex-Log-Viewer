import {
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
    ).toEqual(['salesforce.salesforcedx-vscode-core', 'salesforce.salesforcedx-vscode-apex-replay-debugger']);
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
