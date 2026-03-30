const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, 'publish-npm-package-if-needed.mjs');

function writePackageManifest(rootDir, {
  name = '@electivus/apex-log-viewer-linux-x64',
  version = '0.1.1'
} = {}) {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'package.json'),
    JSON.stringify({ name, version }, null, 2)
  );
}

test('publishPackageIfNeeded skips npm publish when the package version already exists', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-npm-publish-skip-'));
  const calls = [];

  try {
    writePackageManifest(packageDir);

    const result = mod.publishPackageIfNeeded(packageDir, {
      tag: 'latest',
      access: 'public',
      logger: { log() {} },
      runCommand(args) {
        calls.push(args);

        if (args[0] === 'view') {
          return { status: 0, stdout: '"0.1.1"\n', stderr: '' };
        }

        throw new Error('publish should be skipped when the version already exists');
      }
    });

    assert.deepEqual(calls, [
      ['view', '@electivus/apex-log-viewer-linux-x64@0.1.1', 'version', '--json']
    ]);
    assert.equal(result.published, false);
    assert.equal(result.name, '@electivus/apex-log-viewer-linux-x64');
    assert.equal(result.version, '0.1.1');
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('publishPackageIfNeeded publishes when npm view reports the version is missing', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-npm-publish-new-'));
  const calls = [];

  try {
    writePackageManifest(packageDir);

    const result = mod.publishPackageIfNeeded(packageDir, {
      tag: 'next',
      access: 'public',
      logger: { log() {} },
      runCommand(args) {
        calls.push(args);

        if (args[0] === 'view') {
          return {
            status: 1,
            stdout: '',
            stderr: 'npm ERR! code E404\nnpm ERR! 404 No match found for version 0.1.1\n'
          };
        }

        if (args[0] === 'publish') {
          return { status: 0, stdout: '', stderr: '' };
        }

        throw new Error(`unexpected npm command: ${args.join(' ')}`);
      }
    });

    assert.deepEqual(calls, [
      ['view', '@electivus/apex-log-viewer-linux-x64@0.1.1', 'version', '--json'],
      ['publish', packageDir, '--tag', 'next', '--access', 'public']
    ]);
    assert.equal(result.published, true);
    assert.equal(result.name, '@electivus/apex-log-viewer-linux-x64');
    assert.equal(result.version, '0.1.1');
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('isDirectExecution resolves relative CLI paths consistently with other repo scripts', async () => {
  const mod = await import(pathToFileURL(modulePath).href);

  assert.equal(
    mod.isDirectExecution('scripts/publish-npm-package-if-needed.mjs', pathToFileURL(modulePath).href),
    true
  );
  assert.equal(
    mod.isDirectExecution('scripts/not-this-script.mjs', pathToFileURL(modulePath).href),
    false
  );
});
