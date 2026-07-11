const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, '..', 'apps', 'vscode-extension', 'scripts', 'copy-ripgrep-runtime.mjs');

test('copyRipgrepRuntime stages supported platform packages under the extension bin root', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-ripgrep-'));
  const sourceRoot = path.join(repoRoot, 'node_modules', '@vscode', 'ripgrep');
  const platformRoot = path.join(repoRoot, 'node_modules', '@vscode', 'ripgrep-linux-x64');
  const binaryPath = path.join(platformRoot, 'bin', 'rg');

  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"version":"1.18.0"}\n');
    fs.writeFileSync(path.join(platformRoot, 'package.json'), '{}\n');
    fs.writeFileSync(binaryPath, 'binary');

    const result = mod.copyRipgrepRuntime({ repoRoot });

    assert.deepEqual(result.packages, ['ripgrep-linux-x64']);
    assert.equal(result.destinationRoot, path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'ripgrep'));
    assert.equal(fs.existsSync(path.join(result.destinationRoot, 'linux-x64', 'bin', 'rg')), true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('copyRipgrepRuntime copies only the requested VSIX target package and removes stale packages', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-ripgrep-target-'));
  const vscodeRoot = path.join(repoRoot, 'node_modules', '@vscode');
  const sourceRoot = path.join(vscodeRoot, 'ripgrep');
  const linuxRoot = path.join(vscodeRoot, 'ripgrep-linux-x64');
  const winRoot = path.join(vscodeRoot, 'ripgrep-win32-arm64');
  const destinationRoot = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'ripgrep');

  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(path.join(linuxRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(winRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(destinationRoot, 'linux-x64'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'package.json'),
      JSON.stringify({
        version: '1.18.0',
        optionalDependencies: {
          '@vscode/ripgrep-win32-arm64': '1.18.0'
        }
      })
    );
    fs.writeFileSync(path.join(linuxRoot, 'bin', 'rg'), 'linux');
    fs.writeFileSync(path.join(winRoot, 'bin', 'rg.exe'), 'win');
    fs.writeFileSync(path.join(destinationRoot, 'linux-x64', 'stale'), 'stale');

    const result = mod.copyRipgrepRuntime({ repoRoot, target: 'win32-arm64' });

    assert.deepEqual(result.packages, ['ripgrep-win32-arm64']);
    assert.equal(fs.existsSync(path.join(destinationRoot, 'win32-arm64', 'bin', 'rg.exe')), true);
    assert.equal(fs.existsSync(path.join(destinationRoot, 'linux-x64')), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('copyRipgrepRuntime requires pnpm to materialize requested cross-platform packages', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-ripgrep-missing-'));
  const vscodeRoot = path.join(repoRoot, 'node_modules', '@vscode');
  const sourceRoot = path.join(vscodeRoot, 'ripgrep');

  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'package.json'),
      JSON.stringify({
        version: '1.18.0',
        optionalDependencies: {
          '@vscode/ripgrep-linux-arm64': '1.18.0'
        }
      })
    );

    assert.throws(
      () => mod.copyRipgrepRuntime({ repoRoot, target: 'linux-arm64' }),
      /run pnpm install --frozen-lockfile.*supportedArchitectures/
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
