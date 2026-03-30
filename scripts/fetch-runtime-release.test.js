const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, 'fetch-runtime-release.mjs');

test('resolveRuntimeAssetName uses the pinned CLI version and target archive format', async () => {
  const mod = await import(pathToFileURL(modulePath).href);

  assert.equal(
    mod.resolveRuntimeAssetName({ cliVersion: '1.2.3', target: 'linux-x64' }),
    'apex-log-viewer-1.2.3-linux-x64.tar.gz'
  );
  assert.equal(
    mod.resolveRuntimeAssetName({ cliVersion: '1.2.3', target: 'darwin-arm64' }),
    'apex-log-viewer-1.2.3-darwin-arm64.tar.gz'
  );
  assert.equal(
    mod.resolveRuntimeAssetName({ cliVersion: '1.2.3', target: 'win32-x64' }),
    'apex-log-viewer-1.2.3-win32-x64.zip'
  );
});

test('resolveRuntimeReleaseTag prefers the pinned tag and falls back to rust-v<cliVersion>', async () => {
  const mod = await import(pathToFileURL(modulePath).href);

  assert.equal(
    mod.resolveRuntimeReleaseTag({ tag: 'rust-v9.9.9-alpha.1', cliVersion: '1.2.3' }),
    'rust-v9.9.9-alpha.1'
  );
  assert.equal(mod.resolveRuntimeReleaseTag({ tag: '', cliVersion: '1.2.3' }), 'rust-v1.2.3');
});

test('fetchRuntimeRelease reads config/runtime-bundle.json and installs the chosen asset into the target bin directory', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-fetch-runtime-'));
  const calls = [];

  fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'config', 'runtime-bundle.json'),
    JSON.stringify({ cliVersion: '1.2.3', tag: '', channel: 'stable', protocolVersion: '1' }, null, 2)
  );

  const result = await mod.fetchRuntimeRelease({
    repoRoot,
    target: 'linux-x64',
    downloadReleaseAssetImpl: async ({ url, destinationFile, assetName, releaseTag }) => {
      calls.push({ type: 'download', url, destinationFile, assetName, releaseTag });
      fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
      fs.writeFileSync(destinationFile, 'archive');
      return destinationFile;
    },
    extractArchiveImpl: ({ archivePath, destinationDir, target }) => {
      calls.push({ type: 'extract', archivePath, destinationDir, target });
      const binaryPath = path.join(destinationDir, 'apex-log-viewer');
      fs.mkdirSync(destinationDir, { recursive: true });
      fs.writeFileSync(binaryPath, 'binary');
      return { binaryPath };
    }
  });

  assert.deepEqual(calls, [
    {
      type: 'download',
      url: 'https://github.com/Electivus/Apex-Log-Viewer/releases/download/rust-v1.2.3/apex-log-viewer-1.2.3-linux-x64.tar.gz',
      destinationFile: path.join(repoRoot, '.cache', 'runtime-release', 'apex-log-viewer-1.2.3-linux-x64.tar.gz'),
      assetName: 'apex-log-viewer-1.2.3-linux-x64.tar.gz',
      releaseTag: 'rust-v1.2.3'
    },
    {
      type: 'extract',
      archivePath: path.join(repoRoot, '.cache', 'runtime-release', 'apex-log-viewer-1.2.3-linux-x64.tar.gz'),
      destinationDir: path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'linux-x64'),
      target: 'linux-x64'
    }
  ]);
  assert.equal(result.assetName, 'apex-log-viewer-1.2.3-linux-x64.tar.gz');
  assert.equal(result.releaseTag, 'rust-v1.2.3');
  assert.equal(
    result.destinationDir,
    path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'linux-x64')
  );
  assert.equal(fs.existsSync(path.join(result.destinationDir, 'apex-log-viewer')), true);

  fs.rmSync(repoRoot, { recursive: true, force: true });
});
