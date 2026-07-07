const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(
  __dirname,
  '..',
  'apps',
  'vscode-extension',
  'scripts',
  'copy-ripgrep-runtime.mjs'
);

test('copyRipgrepRuntime mirrors ripgrep meta and platform packages into the extension app root', async () => {
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

    assert.deepEqual(result.packages, ['ripgrep', 'ripgrep-linux-x64']);
    assert.equal(
      result.destinationNamespaceRoot,
      path.join(repoRoot, 'apps', 'vscode-extension', 'node_modules', '@vscode')
    );
    assert.equal(fs.existsSync(path.join(result.destinationNamespaceRoot, 'ripgrep', 'package.json')), true);
    assert.equal(fs.existsSync(path.join(result.destinationNamespaceRoot, 'ripgrep-linux-x64', 'bin', 'rg')), true);
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
  const destinationRoot = path.join(repoRoot, 'apps', 'vscode-extension', 'node_modules', '@vscode');

  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(path.join(linuxRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(winRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(destinationRoot, 'ripgrep-linux-x64'), { recursive: true });
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
    fs.writeFileSync(path.join(destinationRoot, 'ripgrep-linux-x64', 'stale'), 'stale');

    const result = mod.copyRipgrepRuntime({ repoRoot, target: 'win32-arm64' });

    assert.deepEqual(result.packages, ['ripgrep', 'ripgrep-win32-arm64']);
    assert.equal(fs.existsSync(path.join(destinationRoot, 'ripgrep', 'package.json')), true);
    assert.equal(fs.existsSync(path.join(destinationRoot, 'ripgrep-win32-arm64', 'bin', 'rg.exe')), true);
    assert.equal(fs.existsSync(path.join(destinationRoot, 'ripgrep-linux-x64')), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('copyRipgrepRuntime installs the requested VSIX target package when npm omitted it', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-ripgrep-install-'));
  const vscodeRoot = path.join(repoRoot, 'node_modules', '@vscode');
  const sourceRoot = path.join(vscodeRoot, 'ripgrep');
  const armRoot = path.join(vscodeRoot, 'ripgrep-linux-arm64');
  const destinationRoot = path.join(repoRoot, 'apps', 'vscode-extension', 'node_modules', '@vscode');
  const installCalls = [];

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

    const execFileSyncFn = (cmd, args, options) => {
      installCalls.push({ cmd, args, options });
      assert.ok(args.includes('@vscode/ripgrep-linux-arm64@1.18.0'));
      assert.equal(options.cwd, repoRoot);
      fs.mkdirSync(path.join(armRoot, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(armRoot, 'package.json'), '{}\n');
      fs.writeFileSync(path.join(armRoot, 'bin', 'rg'), 'arm');
    };

    const result = mod.copyRipgrepRuntime({ repoRoot, target: 'linux-arm64', execFileSyncFn });

    assert.equal(installCalls.length, 1);
    assert.deepEqual(result.packages, ['ripgrep', 'ripgrep-linux-arm64']);
    assert.equal(fs.existsSync(path.join(destinationRoot, 'ripgrep-linux-arm64', 'bin', 'rg')), true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('copyRipgrepRuntime installs missing target packages through cmd.exe on Windows', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-ripgrep-install-win-'));
  const vscodeRoot = path.join(repoRoot, 'node_modules', '@vscode');
  const sourceRoot = path.join(vscodeRoot, 'ripgrep');
  const armRoot = path.join(vscodeRoot, 'ripgrep-win32-arm64');
  const installCalls = [];

  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'package.json'),
      JSON.stringify({
        version: '1.18.0',
        optionalDependencies: {
          '@vscode/ripgrep-win32-arm64': '1.18.0'
        }
      })
    );

    const execFileSyncFn = (cmd, args, options) => {
      installCalls.push({ cmd, args, options });
      fs.mkdirSync(path.join(armRoot, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(armRoot, 'package.json'), '{}\n');
      fs.writeFileSync(path.join(armRoot, 'bin', 'rg.exe'), 'arm');
    };

    const result = mod.copyRipgrepRuntime({
      repoRoot,
      target: 'win32-arm64',
      execFileSyncFn,
      platform: 'win32'
    });

    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0].cmd, 'cmd.exe');
    assert.deepEqual(installCalls[0].args.slice(0, 4), ['/d', '/s', '/c', 'npm.cmd']);
    assert.ok(installCalls[0].args.includes('@vscode/ripgrep-win32-arm64@1.18.0'));
    assert.equal(installCalls[0].options.cwd, repoRoot);
    assert.deepEqual(result.packages, ['ripgrep', 'ripgrep-win32-arm64']);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
