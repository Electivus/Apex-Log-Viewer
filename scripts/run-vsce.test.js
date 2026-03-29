const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  addRepoLocalBinToPath,
  createPackagingStage,
  normalizePathArgs,
  resolveVsceInvocation,
  runVsce
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

test('runVsce preserves packaged VSIX artifacts when package runs in a temp stage dir', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-run-vsce-stage-'));
  const stageDir = path.join(tempRoot, 'stage');
  const outputDir = path.join(tempRoot, 'out');
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const artifactName = 'electivus.apex-log-viewer-0.38.0.vsix';
  const seen = [];

  try {
    runVsce(['package', '--skip-prepublish', '--no-yarn'], {
      createPackagingStage: () => stageDir,
      resolveVsceInvocation: () => ({ command: 'vsce', baseArgs: [] }),
      runCommand(command, args, options) {
        seen.push({ command, args, cwd: options.cwd });
        if (command === 'vsce') {
          fs.writeFileSync(path.join(options.cwd, artifactName), 'vsix');
        }
      },
      packageOutputDir: outputDir,
      removeDir(target, options) {
        fs.rmSync(target, options);
      }
    });

    assert.deepEqual(seen, [
      {
        command: 'vsce',
        args: ['package', '--no-yarn'],
        cwd: stageDir
      }
    ]);
    assert.equal(fs.existsSync(path.join(outputDir, artifactName)), true);
    assert.equal(fs.existsSync(path.join(stageDir, artifactName)), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
