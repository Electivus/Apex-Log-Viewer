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
  'copy-package-metadata.mjs'
);

test('copyPackageMetadata mirrors package docs, telemetry and the sfdx-project schema into the extension app root', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-package-metadata-'));
  const appRoot = path.join(repoRoot, 'apps', 'vscode-extension');
  fs.mkdirSync(appRoot, { recursive: true });

  for (const relativePath of mod.PACKAGE_METADATA_FILES) {
    fs.writeFileSync(path.join(repoRoot, relativePath), relativePath, 'utf8');
  }
  for (const { source } of mod.PACKAGE_SCHEMA_FILES) {
    fs.mkdirSync(path.dirname(path.join(repoRoot, source)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, source), source, 'utf8');
  }

  const result = mod.copyPackageMetadata({ repoRoot });

  for (const filePath of result.files) {
    assert.equal(fs.existsSync(filePath), true);
  }
  const schema = mod.PACKAGE_SCHEMA_FILES[0];
  assert.equal(fs.readFileSync(path.join(appRoot, schema.destination), 'utf8'), schema.source);

  fs.rmSync(repoRoot, { recursive: true, force: true });
});
