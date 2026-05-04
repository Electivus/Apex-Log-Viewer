import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  createMissingSupportExtensionsError,
  redactPreservedVsCodeUserData,
  resolveCachedSupportExtensionsDir,
  resolveCliSpawnInvocation,
  resolveExtensionDevelopmentPath,
  resolveSupportExtensionsLockPath,
  resolveVscodeCachePath,
  resolveVscodeDownloadTimeoutMs,
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

describe('preserved VS Code user data', () => {
  test('redacts proxy credentials before preserving user settings for diagnostics', async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'alv-vscode-redact-'));
    const settingsPath = path.join(userDataDir, 'User', 'settings.json');

    try {
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            'http.proxy': 'http://username:pwd@proxy.corp.local:8080',
            'http.proxyAuthorization': 'Basic dXNlcm5hbWU6cHdk',
            'http.proxyStrictSSL': false
          },
          null,
          2
        ),
        'utf8'
      );

      await redactPreservedVsCodeUserData(userDataDir);

      const redacted = JSON.parse(await readFile(settingsPath, 'utf8'));
      expect(redacted).toEqual({
        'http.proxy': 'http://proxy.corp.local:8080',
        'http.proxyAuthorization': '[redacted]',
        'http.proxyStrictSSL': false
      });
      expect(JSON.stringify(redacted)).not.toContain('username');
      expect(JSON.stringify(redacted)).not.toContain('pwd');
      expect(JSON.stringify(redacted)).not.toContain('dXNlcm5hbWU6cHdk');
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
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

  test('wraps Windows .cmd CLIs through cmd.exe with separate arguments', () => {
    expect(
      resolveCliSpawnInvocation(
        'C:\\VS Code\\bin\\code.cmd',
        ['--extensions-dir', 'C:\\Temp\\support extensions', '--install-extension', 'publisher.extension'],
        'win32'
      )
    ).toEqual({
      command: process.env.ComSpec || 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'call',
        'C:\\VS Code\\bin\\code.cmd',
        '--extensions-dir',
        'C:\\Temp\\support extensions',
        '--install-extension',
        'publisher.extension'
      ]
    });
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

describe('resolveVscodeDownloadTimeoutMs', () => {
  test('defaults the VS Code download timeout to 120 seconds', () => {
    expect(resolveVscodeDownloadTimeoutMs({})).toBe(120_000);
  });

  test('honors VSCODE_TEST_DOWNLOAD_TIMEOUT_MS when set to a positive integer', () => {
    expect(resolveVscodeDownloadTimeoutMs({ VSCODE_TEST_DOWNLOAD_TIMEOUT_MS: '300000' })).toBe(300_000);
  });

  test('falls back to the default for invalid, empty, or non-positive values', () => {
    for (const value of ['', 'abc', '0', '-1', '1.5', 'Infinity']) {
      expect(resolveVscodeDownloadTimeoutMs({ VSCODE_TEST_DOWNLOAD_TIMEOUT_MS: value })).toBe(120_000);
    }
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
