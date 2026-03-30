const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, 'package-cli-release.mjs');

test('resolveReleaseAssetName uses platform-specific archive extensions', async () => {
  const mod = await import(pathToFileURL(modulePath).href);

  assert.equal(mod.resolveReleaseAssetName('1.2.3', 'linux-x64'), 'apex-log-viewer-1.2.3-linux-x64.tar.gz');
  assert.equal(mod.resolveReleaseAssetName('1.2.3', 'win32-x64'), 'apex-log-viewer-1.2.3-win32-x64.zip');
});

test('packageCliRelease writes platform archives and a checksum file', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-release-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-release-repo-'));
  const linuxBinary = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'linux-x64', 'apex-log-viewer');
  const windowsBinary = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'win32-x64', 'apex-log-viewer.exe');

  fs.mkdirSync(path.dirname(linuxBinary), { recursive: true });
  fs.writeFileSync(linuxBinary, 'linux-binary');
  fs.mkdirSync(path.dirname(windowsBinary), { recursive: true });
  fs.writeFileSync(windowsBinary, 'windows-binary');

  const result = mod.packageCliRelease({
    version: '1.2.3',
    outDir,
    repoRoot,
    binaries: {
      'linux-x64': linuxBinary,
      'win32-x64': windowsBinary
    }
  });

  assert.match(path.basename(result.assets[0]), /apex-log-viewer-1\.2\.3-linux-x64\.tar\.gz$/);
  assert.match(result.checksumsFile, /SHA256SUMS\.txt$/);
  assert.equal(fs.existsSync(result.assets[0]), true);
  assert.equal(fs.existsSync(result.assets[1]), true);
  assert.equal(fs.existsSync(result.checksumsFile), true);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
