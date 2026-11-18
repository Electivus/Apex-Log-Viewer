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

test('resolveVsceInvocation runs the local vsce entry point on Node when present', () => {
  const invocation = resolveVsceInvocation();

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.baseArgs, [
    path.join(path.resolve(__dirname, '..'), 'node_modules', '@vscode', 'vsce', 'vsce')
  ]);
});

test('runVsce uses pnpm for the workspace prepublish build', () => {
  const seen = [];
  const stageDir = path.join(os.tmpdir(), 'alv-run-vsce-pnpm-stage');

  runVsce(['package', '--no-dependencies'], {
    createPackagingStage: () => stageDir,
    resolveVsceInvocation: () => ({ command: 'vsce', baseArgs: [] }),
    runCommand(command, args, options) {
      seen.push({ command, args, cwd: options.cwd });
    },
    preservePackagedArtifacts() {},
    removeDir() {}
  });

  assert.deepEqual(seen[0], {
    command: 'pnpm',
    args: ['run', 'package'],
    cwd: path.resolve(__dirname, '..')
  });
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

test('runVsce hands a Windows --out path with spaces and cmd.exe metacharacters to vsce as one argument', () => {
  const out = 'D:\\Temp Files\\R&D 100% ^!\\alv-vscode-1\\apex-log-viewer-smoke.vsix';
  const probe = `
    const path = require('node:path');
    const { readFileSync } = require('node:fs');
    const { runInNewContext } = require('node:vm');
    const calls = [];
    process.binding('spawn_sync').spawn = options => {
      calls.push({ file: options.file, args: options.args, verbatim: !!options.windowsVerbatimArguments });
      return { status: 0, signal: null, pid: 1, output: [] };
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'execPath', { value: 'C:\\\\Program Files\\\\nodejs\\\\node.exe' });
    process.env.ComSpec = 'C:\\\\Windows\\\\System32\\\\cmd.exe';
    const module = { exports: {} };
    runInNewContext(readFileSync(${JSON.stringify(path.join(__dirname, 'run-vsce.js'))}, 'utf8'), {
      module,
      process,
      __dirname: 'C:\\\\checkout\\\\scripts',
      require(name) {
        if (name === 'path') return path.win32;
        if (name === 'fs') return { existsSync: () => true };
        if (name === 'os') return { tmpdir: () => 'D:\\\\Temp Files' };
        return require(require.resolve(name, { paths: [${JSON.stringify(path.resolve(__dirname, '..'))}] }));
      }
    });
    module.exports.runVsce(['package', '--no-dependencies', '--skip-prepublish', '--no-yarn', '--out', process.argv[1]], {
      createPackagingStage: () => 'D:\\\\Temp Files\\\\alv-vsce-stage-1',
      removeDir() {}
    });
    process.stdout.write(JSON.stringify(calls));
  `;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', probe, out], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH }
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = JSON.parse(result.stdout);

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0],
    {
      file: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\checkout\\node_modules\\@vscode\\vsce\\vsce',
        'package',
        '--no-dependencies',
        '--no-yarn',
        '--out',
        out
      ],
      verbatim: false
    },
    'Node starts vsce without cmd.exe, so the path cannot be split or expanded'
  );
});
