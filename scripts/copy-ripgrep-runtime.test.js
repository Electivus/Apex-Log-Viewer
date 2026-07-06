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

test('copyRipgrepRuntime mirrors the ripgrep package into the extension app root', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-ripgrep-'));
  const sourceRoot = path.join(repoRoot, 'node_modules', '@vscode', 'ripgrep');
  const binaryPath = path.join(sourceRoot, 'bin', 'rg');

  try {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{}\n');
    fs.writeFileSync(binaryPath, 'binary');

    const result = mod.copyRipgrepRuntime({ repoRoot });

    assert.equal(
      result.destinationRoot,
      path.join(repoRoot, 'apps', 'vscode-extension', 'node_modules', '@vscode', 'ripgrep')
    );
    assert.equal(fs.existsSync(path.join(result.destinationRoot, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(result.destinationRoot, 'bin', 'rg')), true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
