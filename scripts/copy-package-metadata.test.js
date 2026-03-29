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
  'copy-package-metadata.mjs'
);

test('copyPackageMetadata mirrors package docs and telemetry into the extension app root', async () => {
  const mod = await import(modulePath);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-package-metadata-'));
  const appRoot = path.join(repoRoot, 'apps', 'vscode-extension');
  fs.mkdirSync(appRoot, { recursive: true });

  for (const relativePath of mod.PACKAGE_METADATA_FILES) {
    fs.writeFileSync(path.join(repoRoot, relativePath), relativePath, 'utf8');
  }

  const result = mod.copyPackageMetadata({ repoRoot });

  for (const filePath of result.files) {
    assert.equal(fs.existsSync(filePath), true);
  }

  fs.rmSync(repoRoot, { recursive: true, force: true });
});
