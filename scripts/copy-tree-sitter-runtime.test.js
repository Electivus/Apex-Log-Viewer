const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const modulePath = path.join(
  __dirname,
  '..',
  'apps',
  'vscode-extension',
  'scripts',
  'copy-tree-sitter-runtime.mjs'
);

test('copyTreeSitterRuntime vendors the minimal parser runtime into the extension app', async () => {
  const mod = await import(modulePath);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-tree-sitter-'));
  const sourceRoot = path.join(repoRoot, 'node_modules', 'tree-sitter-sfapex');

  for (const relativePath of mod.TREE_SITTER_RUNTIME_FILES) {
    const source = path.join(sourceRoot, relativePath);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, relativePath, 'utf8');
  }

  const result = mod.copyTreeSitterRuntime({ repoRoot });

  for (const filePath of result.files) {
    assert.equal(fs.existsSync(filePath), true);
  }
  assert.equal(
    result.destinationRoot,
    path.join(repoRoot, 'apps', 'vscode-extension', 'node_modules', 'tree-sitter-sfapex')
  );

  fs.rmSync(repoRoot, { recursive: true, force: true });
});
