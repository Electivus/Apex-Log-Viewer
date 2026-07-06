const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, 'stage-sf-plugin-npm-package.mjs');

async function loadModule() {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
}

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

test('stageSfPluginPackage writes a publishable manifest and copies declared files', async () => {
  const mod = await loadModule();
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-plugin-stage-'));
  const packageDir = path.join(repoRoot, 'packages', 'sf-plugin');
  const outDir = path.join(repoRoot, 'dist', 'sf-plugin-npm');

  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: '@electivus/plugin-electivus',
        version: '1.2.3',
        private: true,
        files: ['/bin', '/lib', '/messages', '/skills', '/oclif.manifest.json']
      },
      null,
      2
    )
  );
  await writeFile(path.join(packageDir, 'bin', 'run.js'), 'runner');
  await writeFile(path.join(packageDir, 'lib', 'index.js'), 'module');
  await writeFile(path.join(packageDir, 'messages', 'electivus.json'), '{}');
  await writeFile(path.join(packageDir, 'skills', 'apex-log-viewer-cli', 'SKILL.md'), 'skill');
  await writeFile(path.join(packageDir, 'oclif.manifest.json'), '{}');

  const result = await mod.stageSfPluginPackage({ repoRoot, outDir });

  const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@electivus/plugin-electivus');
  assert.equal('private' in manifest, false);
  assert.deepEqual(result.files, ['bin', 'lib', 'messages', 'skills', 'oclif.manifest.json']);
  assert.equal(await fs.readFile(path.join(outDir, 'bin', 'run.js'), 'utf8'), 'runner');
  assert.equal(await fs.readFile(path.join(outDir, 'skills', 'apex-log-viewer-cli', 'SKILL.md'), 'utf8'), 'skill');
});

test('stageSfPluginPackage fails when build artifacts are missing', async () => {
  const mod = await loadModule();
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-plugin-stage-missing-'));
  const packageDir = path.join(repoRoot, 'packages', 'sf-plugin');

  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@electivus/plugin-electivus',
      version: '1.2.3',
      private: true,
      files: ['/lib']
    })
  );

  await assert.rejects(
    mod.stageSfPluginPackage({ repoRoot }),
    /missing plugin package artifact .*packages\/sf-plugin\/lib/
  );
});
