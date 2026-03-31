const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, 'build-cli-npm-packages.mjs');
const launcherPath = path.join(__dirname, '..', 'packages', 'cli-npm', 'bin', 'apex-log-viewer.js');

function makeBinary(rootDir, target) {
  const binaryName = target.startsWith('win32-') ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  const binaryPath = path.join(rootDir, target, binaryName);
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, `binary:${target}`);
  return binaryPath;
}

test('buildCliNpmPackages generates the meta package with all native optionalDependencies', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-npm-'));
  const binariesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-binaries-'));

  const result = mod.buildCliNpmPackages({
    version: '1.2.3',
    outDir,
    binaries: {
      'linux-x64': makeBinary(binariesRoot, 'linux-x64'),
      'darwin-arm64': makeBinary(binariesRoot, 'darwin-arm64')
    }
  });

  const metaPackage = JSON.parse(fs.readFileSync(path.join(result.metaDir, 'package.json'), 'utf8'));
  const linuxNativePackage = JSON.parse(
    fs.readFileSync(path.join(result.nativeDirs['linux-x64'], 'package.json'), 'utf8')
  );

  assert.equal(metaPackage.name, '@electivus/apex-log-viewer');
  assert.equal(metaPackage.version, '1.2.3');
  assert.deepEqual(metaPackage.bin, {
    alv: 'bin/apex-log-viewer.js',
    'apex-log-viewer': 'bin/apex-log-viewer.js'
  });
  assert.equal(metaPackage.optionalDependencies['@electivus/apex-log-viewer-linux-x64'], '1.2.3');
  assert.equal(metaPackage.optionalDependencies['@electivus/apex-log-viewer-darwin-arm64'], '1.2.3');
  assert.equal(
    fs.existsSync(path.join(result.metaDir, 'bin', 'apex-log-viewer.js')),
    true,
    'expected meta package launcher to be copied'
  );
  assert.equal(linuxNativePackage.name, '@electivus/apex-log-viewer-linux-x64');
  assert.deepEqual(linuxNativePackage.os, ['linux']);
  assert.deepEqual(linuxNativePackage.cpu, ['x64']);
  assert.equal(
    fs.existsSync(path.join(result.nativeDirs['linux-x64'], 'bin', 'apex-log-viewer')),
    true,
    'expected native package binary to be copied'
  );

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(binariesRoot, { recursive: true, force: true });
});

test('buildCliNpmPackages removes stale native package directories when rerun with fewer binaries', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-npm-'));
  const binariesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-binaries-'));

  const firstResult = mod.buildCliNpmPackages({
    version: '1.2.3',
    outDir,
    binaries: {
      'linux-x64': makeBinary(binariesRoot, 'linux-x64'),
      'darwin-arm64': makeBinary(binariesRoot, 'darwin-arm64')
    }
  });

  assert.equal(fs.existsSync(firstResult.nativeDirs['linux-x64']), true);
  assert.equal(fs.existsSync(firstResult.nativeDirs['darwin-arm64']), true);

  const secondResult = mod.buildCliNpmPackages({
    version: '1.2.3',
    outDir,
    binaries: {
      'linux-x64': makeBinary(binariesRoot, 'linux-x64')
    }
  });

  assert.equal(fs.existsSync(secondResult.nativeDirs['linux-x64']), true);
  assert.equal(
    fs.existsSync(path.join(outDir, 'darwin-arm64')),
    false,
    'expected stale native package directory to be removed on rerun'
  );

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(binariesRoot, { recursive: true, force: true });
});

test('resolvePackageForTarget maps supported platform and arch pairs to native package names', async () => {
  const launcher = await import(pathToFileURL(launcherPath).href);

  assert.equal(
    launcher.resolvePackageForTarget('linux', 'x64'),
    '@electivus/apex-log-viewer-linux-x64'
  );
  assert.equal(
    launcher.resolvePackageForTarget('darwin', 'arm64'),
    '@electivus/apex-log-viewer-darwin-arm64'
  );
  assert.throws(
    () => launcher.resolvePackageForTarget('freebsd', 'x64'),
    /unsupported platform\/arch target/i
  );
});

test('resolveExitCode falls back to 1 when the native binary exits via signal', async () => {
  const launcher = await import(pathToFileURL(launcherPath).href);

  assert.equal(launcher.resolveExitCode({ status: 3, signal: null }), 3);
  assert.equal(launcher.resolveExitCode({ status: null, signal: 'SIGTERM' }), 1);
});

test('isDirectExecution treats npm-style symlink entrypoints as direct execution', async (t) => {
  const launcher = await import(pathToFileURL(launcherPath).href);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-symlink-'));
  const symlinkPath = path.join(tempDir, 'alv');

  try {
    if (process.platform === 'win32') {
      t.skip('Windows symlink creation may require Developer Mode or elevated privileges');
    }

    try {
      fs.symlinkSync(launcherPath, symlinkPath);
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
        t.skip('Symlink creation is not permitted in this environment');
      }
      throw error;
    }

    assert.equal(typeof launcher.isDirectExecution, 'function');
    assert.equal(launcher.isDirectExecution(symlinkPath, pathToFileURL(launcherPath).href), true);
    assert.equal(
      launcher.isDirectExecution(path.join(tempDir, 'different-entry.js'), pathToFileURL(launcherPath).href),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('discoverBinaries finds packaged runtime binaries under apps/vscode-extension/bin', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-discover-'));
  const linuxBinary = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'linux-x64', 'apex-log-viewer');
  const windowsBinary = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'win32-arm64', 'apex-log-viewer.exe');

  fs.mkdirSync(path.dirname(linuxBinary), { recursive: true });
  fs.mkdirSync(path.dirname(windowsBinary), { recursive: true });
  fs.writeFileSync(linuxBinary, 'linux');
  fs.writeFileSync(windowsBinary, 'windows');

  assert.deepEqual(mod.discoverBinaries(repoRoot), {
    'linux-x64': linuxBinary,
    'win32-arm64': windowsBinary
  });

  fs.rmSync(repoRoot, { recursive: true, force: true });
});
