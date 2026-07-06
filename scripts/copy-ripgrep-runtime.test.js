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
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{}\n');
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
