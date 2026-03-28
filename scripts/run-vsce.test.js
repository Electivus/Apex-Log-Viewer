const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  addRepoLocalBinToPath,
  createPackagingStage,
  normalizePathArgs,
  resolveVsceInvocation
} = require('./run-vsce');

test('resolveVsceInvocation prefers the local workspace binary when present', () => {
  const invocation = resolveVsceInvocation(process.platform);

  assert.match(invocation.command, /node_modules[\\/]\.bin[\\/]vsce(?:\.cmd)?$/);
  assert.deepEqual(invocation.baseArgs, []);
});

test('addRepoLocalBinToPath prepends the workspace local bin exactly once', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-run-vsce-'));
  const fakeEnv = { PATH: path.join(tempRoot, 'bin') };

  const first = addRepoLocalBinToPath(fakeEnv);
  const second = addRepoLocalBinToPath({ PATH: first });
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const parts = second.split(delimiter);
  const localBin = path.join(path.resolve(__dirname, '..'), 'node_modules', '.bin');

  assert.equal(parts.filter(part => part === localBin).length, 1);
  assert.equal(parts[0], localBin);
});

test('normalizePathArgs resolves vsce output paths from the repo root', () => {
  assert.deepEqual(
    normalizePathArgs(['package', '--out', 'artifacts/test.vsix', '--packagePath', 'bundle/test.vsix']),
    [
      'package',
      '--out',
      path.join(path.resolve(__dirname, '..'), 'artifacts', 'test.vsix'),
      '--packagePath',
      path.join(path.resolve(__dirname, '..'), 'bundle', 'test.vsix')
    ]
  );
});

test('createPackagingStage copies the extension app outside the git workspace root', () => {
  const stageDir = createPackagingStage();

  try {
    assert.equal(stageDir.startsWith(path.resolve(__dirname, '..', 'apps', 'vscode-extension')), false);
    assert.equal(fs.existsSync(path.join(stageDir, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'package.nls.json')), true);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});
