const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alv-run-playwright-cli-e2e-'));
}

function cleanupTempRepo(repoRoot) {
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

function loadRunner() {
  const runnerPath = path.join(__dirname, 'run-playwright-cli-e2e.js');
  assert.ok(fs.existsSync(runnerPath), 'expected scripts/run-playwright-cli-e2e.js to exist');
  const resolvedRunnerPath = require.resolve(runnerPath);
  delete require.cache[resolvedRunnerPath];
  return require(resolvedRunnerPath);
}

function readPackageScripts() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts;
}

test('resolveCliBinaryRelativePath targets the debug CLI binary on Linux', () => {
  const runner = loadRunner();

  assert.equal(typeof runner.resolveCliBinaryRelativePath, 'function');
  assert.equal(runner.resolveCliBinaryRelativePath('linux'), 'target/debug/apex-log-viewer');
});

test('resolveCliBinaryRelativePath targets the debug CLI binary on Windows', () => {
  const runner = loadRunner();

  assert.equal(typeof runner.resolveCliBinaryRelativePath, 'function');
  assert.equal(runner.resolveCliBinaryRelativePath('win32'), 'target/debug/apex-log-viewer.exe');
});

test('ensureBuildArtifacts runs npm run build:runtime when the CLI binary is missing', async () => {
  const repoRoot = createTempRepo();
  try {
    const runner = loadRunner();
    let recordedCall;

    await runner.ensureBuildArtifacts(repoRoot, {
      spawnImpl(command, args, options) {
        recordedCall = { command, args, options };
        const child = new EventEmitter();
        process.nextTick(() => child.emit('exit', 0, null));
        return child;
      }
    });

    assert.ok(recordedCall, 'expected ensureBuildArtifacts to invoke the build command');

    if (process.platform === 'win32') {
      assert.equal(recordedCall.command, process.env.ComSpec || 'cmd.exe');
      assert.deepEqual(recordedCall.args, ['/d', '/s', '/c', 'npm.cmd', 'run', 'build:runtime']);
    } else {
      assert.equal(recordedCall.command, 'npm');
      assert.deepEqual(recordedCall.args, ['run', 'build:runtime']);
    }

    assert.equal(recordedCall.options.cwd, repoRoot);
    assert.equal(recordedCall.options.stdio, 'inherit');
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('package.json exposes pretest:e2e:cli = npm run build:runtime', () => {
  const scripts = readPackageScripts();

  assert.equal(scripts['pretest:e2e:cli'], 'npm run build:runtime');
});

test('package.json exposes test:e2e:cli = node scripts/run-playwright-cli-e2e.js', () => {
  const scripts = readPackageScripts();

  assert.equal(scripts['test:e2e:cli'], 'node scripts/run-playwright-cli-e2e.js');
});

test('package.json test:scripts includes scripts/run-playwright-cli-e2e.test.js', () => {
  const scripts = readPackageScripts();

  assert.match(scripts['test:scripts'], /\bscripts\/run-playwright-cli-e2e\.test\.js\b/);
});
