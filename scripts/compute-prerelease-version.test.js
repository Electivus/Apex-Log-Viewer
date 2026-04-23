const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, 'compute-prerelease-version.mjs');

function prereleaseProperties() {
  return [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }];
}

test('computeNextPrereleaseVersion increments from the latest published prerelease patch across target variants', async () => {
  const mod = await import(pathToFileURL(modulePath).href);

  const nextVersion = mod.computeNextPrereleaseVersion({
    baseVersion: '0.42.0',
    marketplaceVersions: [
      { version: '0.43.1', targetPlatform: 'linux-x64', properties: prereleaseProperties() },
      { version: '0.43.1', targetPlatform: 'linux-arm64', properties: prereleaseProperties() },
      { version: '0.43.1', targetPlatform: 'win32-x64', properties: prereleaseProperties() },
      { version: '0.42.9', targetPlatform: 'linux-x64', properties: [] },
      { version: '0.45.7', targetPlatform: 'linux-x64', properties: prereleaseProperties() }
    ]
  });

  assert.equal(nextVersion, '0.43.2');
});

test('computeNextPrereleaseVersion advances from the manifest patch when it is already ahead of the marketplace', async () => {
  const mod = await import(pathToFileURL(modulePath).href);

  const nextVersion = mod.computeNextPrereleaseVersion({
    baseVersion: '0.43.5',
    marketplaceVersions: [
      { version: '0.43.4', targetPlatform: 'linux-x64', properties: prereleaseProperties() }
    ]
  });

  assert.equal(nextVersion, '0.43.6');
});

test('fetchMarketplaceVersions invokes vsce show via node with a larger max buffer', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  let call;

  const versions = mod.fetchMarketplaceVersions('electivus.apex-log-viewer', {
    processExecPath: '/usr/bin/node',
    vsceCliPath: '/repo/node_modules/@vscode/vsce/vsce',
    spawnSyncImpl(command, args, options) {
      call = { command, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({
          versions: [{ version: '0.43.1', properties: prereleaseProperties() }]
        }),
        stderr: ''
      };
    }
  });

  assert.deepEqual(versions, [{ version: '0.43.1', properties: prereleaseProperties() }]);
  assert.deepEqual(call, {
    command: '/usr/bin/node',
    args: ['/repo/node_modules/@vscode/vsce/vsce', 'show', 'electivus.apex-log-viewer', '--json'],
    options: {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: mod.VSCE_SHOW_MAX_BUFFER
    }
  });
});

test('main reads the extension manifest and writes the computed version', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-prerelease-version-'));
  let stdout = '';

  try {
    fs.mkdirSync(path.join(repoRoot, 'apps', 'vscode-extension'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'apps', 'vscode-extension', 'package.json'),
      JSON.stringify({
        name: 'apex-log-viewer',
        publisher: 'electivus',
        version: '0.42.0'
      }, null, 2)
    );

    const nextVersion = mod.main(
      ['--manifest', 'apps/vscode-extension/package.json'],
      {
        cwd: repoRoot,
        stdout: {
          write(chunk) {
            stdout += chunk;
          }
        },
        processExecPath: '/usr/bin/node',
        vsceCliPath: '/repo/node_modules/@vscode/vsce/vsce',
        spawnSyncImpl() {
          return {
            status: 0,
            stdout: JSON.stringify({
              versions: [{ version: '0.43.1', properties: prereleaseProperties() }]
            }),
            stderr: ''
          };
        }
      }
    );

    assert.equal(nextVersion, '0.43.2');
    assert.equal(stdout, '0.43.2');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
