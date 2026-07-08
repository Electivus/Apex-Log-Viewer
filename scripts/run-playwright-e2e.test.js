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
  resolveEmbeddedRunnerRelativePath,
  resolveBuildInvocation,
  resolvePlaywrightEnv,
  resolvePlaywrightInvocation
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
      resolveEmbeddedRunnerRelativePath(),
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

test('resolveEmbeddedRunnerRelativePath targets the embedded sf plugin runner inside the extension app', () => {
  assert.equal(
    resolveEmbeddedRunnerRelativePath(),
    'apps/vscode-extension/sf-plugin/electivus-runner.cjs'
  );
});

test('findMissingBuildArtifacts reports the embedded plugin runner when it has not been built yet', () => {
  const repoRoot = createTempRepo();
  try {
    writeArtifacts(repoRoot, ['apps/vscode-extension/dist/extension.js', 'apps/vscode-extension/media/main.js']);

    assert.deepEqual(findMissingBuildArtifacts(repoRoot), [
      resolveEmbeddedRunnerRelativePath(),
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

test('resolvePlaywrightInvocation defaults to two retries for three total E2E attempts', () => {
  const originalRetries = process.env.PLAYWRIGHT_RETRIES;
  delete process.env.PLAYWRIGHT_RETRIES;

  try {
    const invocation = resolvePlaywrightInvocation(['--grep', 'smoke']);

    assert.deepEqual(invocation.args.slice(0, 5), [
      require.resolve('@playwright/test/cli'),
      'test',
      '--retries=2',
      '--grep',
      'smoke'
    ]);
  } finally {
    if (originalRetries === undefined) {
      delete process.env.PLAYWRIGHT_RETRIES;
    } else {
      process.env.PLAYWRIGHT_RETRIES = originalRetries;
    }
  }
});

test('resolvePlaywrightInvocation includes a retries override when PLAYWRIGHT_RETRIES is set', () => {
  const originalRetries = process.env.PLAYWRIGHT_RETRIES;
  process.env.PLAYWRIGHT_RETRIES = '0';

  try {
    const invocation = resolvePlaywrightInvocation(['--grep', 'smoke']);

    assert.deepEqual(invocation.args.slice(0, 5), [
      require.resolve('@playwright/test/cli'),
      'test',
      '--retries=0',
      '--grep',
      'smoke'
    ]);
  } finally {
    if (originalRetries === undefined) {
      delete process.env.PLAYWRIGHT_RETRIES;
    } else {
      process.env.PLAYWRIGHT_RETRIES = originalRetries;
    }
  }
});

test('resolvePlaywrightInvocation rejects invalid PLAYWRIGHT_RETRIES values', () => {
  const originalRetries = process.env.PLAYWRIGHT_RETRIES;
  process.env.PLAYWRIGHT_RETRIES = 'abc';

  try {
    assert.throws(
      () => resolvePlaywrightInvocation([]),
      /PLAYWRIGHT_RETRIES must be a non-negative integer, got 'abc'/
    );
  } finally {
    if (originalRetries === undefined) {
      delete process.env.PLAYWRIGHT_RETRIES;
    } else {
      process.env.PLAYWRIGHT_RETRIES = originalRetries;
    }
  }
});

test('resolvePlaywrightEnv exports the current Node runtime for the extension runner', () => {
  const env = resolvePlaywrightEnv(
    { EXISTING: '1', SF_CLI_NODE_PATH: '/opt/salesforce-node/bin/node' },
    '/opt/project-node/bin/node'
  );

  assert.equal(env.EXISTING, '1');
  assert.equal(env.SF_CLI_NODE_PATH, '/opt/salesforce-node/bin/node');
  assert.equal(env.ALV_NODE_BIN_PATH, '/opt/project-node/bin/node');
});

test('resolvePlaywrightEnv preserves an explicit extension runner Node runtime', () => {
  const env = resolvePlaywrightEnv(
    { ALV_NODE_BIN_PATH: '/custom/node', SF_CLI_NODE_PATH: '/opt/salesforce-node/bin/node' },
    '/opt/project-node/bin/node'
  );

  assert.equal(env.ALV_NODE_BIN_PATH, '/custom/node');
  assert.equal(env.SF_CLI_NODE_PATH, '/opt/salesforce-node/bin/node');
});
