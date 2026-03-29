const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureBuildArtifacts,
  findMissingBuildArtifacts,
  requiredBuildArtifacts,
  resolveRuntimeBinaryRelativePath,
  resolveBuildInvocation
} = require('./run-playwright-e2e');

function createTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alv-run-playwright-e2e-'));
}

function cleanupTempRepo(repoRoot) {
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

function writeArtifacts(repoRoot, artifactPaths) {
  for (const relativePath of artifactPaths) {
    const absolutePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, '// test artifact\n', 'utf8');
  }
}

test('findMissingBuildArtifacts reports the missing build outputs', () => {
  const repoRoot = createTempRepo();
  try {
    writeArtifacts(repoRoot, [
      resolveRuntimeBinaryRelativePath(),
      'apps/vscode-extension/dist/extension.js',
      'apps/vscode-extension/media/main.js'
    ]);

    assert.deepEqual(findMissingBuildArtifacts(repoRoot), [
      'apps/vscode-extension/media/webview.css',
      'apps/vscode-extension/media/tail.js',
      'apps/vscode-extension/media/logViewer.js',
      'apps/vscode-extension/media/debugFlags.js'
    ]);
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('resolveRuntimeBinaryRelativePath targets the embedded platform binary inside the extension app', () => {
  assert.equal(resolveRuntimeBinaryRelativePath('linux', 'x64'), 'apps/vscode-extension/bin/linux-x64/apex-log-viewer');
});

test('resolveRuntimeBinaryRelativePath uses target-style separators for Windows binaries too', () => {
  assert.equal(
    resolveRuntimeBinaryRelativePath('win32', 'x64'),
    'apps/vscode-extension/bin/win32-x64/apex-log-viewer.exe'
  );
});

test('findMissingBuildArtifacts reports the runtime binary when it has not been copied yet', () => {
  const repoRoot = createTempRepo();
  try {
    writeArtifacts(repoRoot, ['apps/vscode-extension/dist/extension.js', 'apps/vscode-extension/media/main.js']);

    assert.deepEqual(findMissingBuildArtifacts(repoRoot), [
      resolveRuntimeBinaryRelativePath(),
      'apps/vscode-extension/media/webview.css',
      'apps/vscode-extension/media/tail.js',
      'apps/vscode-extension/media/logViewer.js',
      'apps/vscode-extension/media/debugFlags.js'
    ]);
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('ensureBuildArtifacts skips npm run build when all required outputs already exist', async () => {
  const repoRoot = createTempRepo();
  try {
    writeArtifacts(repoRoot, requiredBuildArtifacts);

    let spawnCalls = 0;
    await ensureBuildArtifacts(repoRoot, {
      spawnImpl() {
        spawnCalls += 1;
        return new EventEmitter();
      }
    });

    assert.equal(spawnCalls, 0);
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('ensureBuildArtifacts runs npm run build when required outputs are missing', async () => {
  const repoRoot = createTempRepo();
  try {
    let recordedCall;

    await ensureBuildArtifacts(repoRoot, {
      spawnImpl(command, args, options) {
        recordedCall = { command, args, options };
        const child = new EventEmitter();
        process.nextTick(() => child.emit('exit', 0, null));
        return child;
      }
    });

    assert.ok(recordedCall);
    assert.equal(recordedCall.command, resolveBuildInvocation().command);
    assert.deepEqual(recordedCall.args, resolveBuildInvocation().args);
    assert.equal(recordedCall.options.cwd, repoRoot);
    assert.equal(recordedCall.options.stdio, 'inherit');
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('resolveBuildInvocation uses cmd.exe on Windows to avoid npm.cmd spawn issues', () => {
  const invocation = resolveBuildInvocation('win32');

  assert.equal(invocation.command, process.env.ComSpec || 'cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'npm.cmd', 'run', 'build']);
});
