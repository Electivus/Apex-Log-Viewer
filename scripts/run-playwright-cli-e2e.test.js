const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
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

test('findMissingBuildArtifacts still requires the host debug binary when CARGO_BUILD_TARGET is set', () => {
  const repoRoot = createTempRepo();
  const originalCargoBuildTarget = process.env.CARGO_BUILD_TARGET;
  process.env.CARGO_BUILD_TARGET = 'x86_64-unknown-linux-musl';

  try {
    const runner = loadRunner();
    const cliBinaryName = path.basename(runner.resolveCliBinaryRelativePath(process.platform));
    const cliBinaryPath = path.join(repoRoot, 'target', process.env.CARGO_BUILD_TARGET, 'debug', cliBinaryName);
    fs.mkdirSync(path.dirname(cliBinaryPath), { recursive: true });
    fs.writeFileSync(cliBinaryPath, '', 'utf8');

    assert.deepEqual(runner.findMissingBuildArtifacts(repoRoot), [runner.resolveCliBinaryRelativePath()]);
  } finally {
    if (originalCargoBuildTarget === undefined) {
      delete process.env.CARGO_BUILD_TARGET;
    } else {
      process.env.CARGO_BUILD_TARGET = originalCargoBuildTarget;
    }
    cleanupTempRepo(repoRoot);
  }
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
        process.nextTick(() => {
          const cliBinaryPath = path.join(repoRoot, runner.resolveCliBinaryRelativePath());
          fs.mkdirSync(path.dirname(cliBinaryPath), { recursive: true });
          fs.writeFileSync(cliBinaryPath, '', 'utf8');
          child.emit('exit', 0, null);
        });
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

test('ensureBuildArtifacts fails when build completes without producing the CLI binary', async () => {
  const repoRoot = createTempRepo();
  try {
    const runner = loadRunner();

    await assert.rejects(
      () =>
        runner.ensureBuildArtifacts(repoRoot, {
          spawnImpl() {
            const child = new EventEmitter();
            process.nextTick(() => child.emit('exit', 0, null));
            return child;
          }
        }),
      /did not produce required CLI artifact/
    );
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('ensureBuildArtifacts clears CARGO_BUILD_TARGET and requires a host debug binary', async () => {
  const repoRoot = createTempRepo();
  const originalCargoBuildTarget = process.env.CARGO_BUILD_TARGET;
  process.env.CARGO_BUILD_TARGET = 'x86_64-unknown-linux-musl';

  try {
    const runner = loadRunner();
    let recordedCall;

    await runner.ensureBuildArtifacts(repoRoot, {
      spawnImpl(command, args, options) {
        recordedCall = { command, args, options };
        const child = new EventEmitter();
        process.nextTick(() => {
          const cliBinaryPath = path.join(repoRoot, runner.resolveCliBinaryRelativePath());
          fs.mkdirSync(path.dirname(cliBinaryPath), { recursive: true });
          fs.writeFileSync(cliBinaryPath, '', 'utf8');
          child.emit('exit', 0, null);
        });
        return child;
      }
    });

    assert.ok(recordedCall, 'expected ensureBuildArtifacts to invoke the build command');
    assert.equal(recordedCall.options.env.CARGO_BUILD_TARGET, undefined);
  } finally {
    if (originalCargoBuildTarget === undefined) {
      delete process.env.CARGO_BUILD_TARGET;
    } else {
      process.env.CARGO_BUILD_TARGET = originalCargoBuildTarget;
    }
    cleanupTempRepo(repoRoot);
  }
});

test('resolvePlaywrightInvocation throws when @playwright/test/cli cannot be resolved instead of falling back to npx', () => {
  const runner = loadRunner();
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
    if (request === '@playwright/test/cli') {
      const error = new Error("Cannot find module '@playwright/test/cli'");
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }

    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  try {
    assert.throws(() => runner.resolvePlaywrightInvocation([]), /@playwright\/test\/cli/);
  } finally {
    Module._resolveFilename = originalResolveFilename;
  }
});

test('resolvePlaywrightInvocation includes --pass-with-no-tests when the CLI suite root is absent', () => {
  const repoRoot = createTempRepo();
  try {
    const runner = loadRunner();
    const invocation = runner.resolvePlaywrightInvocation(['--grep', 'smoke'], { repoRoot });

    assert.deepEqual(invocation.args.slice(0, 5), [
      require.resolve('@playwright/test/cli'),
      'test',
      '--config=playwright.cli.config.ts',
      '--pass-with-no-tests',
      '--grep'
    ]);
    assert.equal(invocation.args[5], 'smoke');
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('resolvePlaywrightInvocation omits --pass-with-no-tests when the CLI suite root exists', () => {
  const repoRoot = createTempRepo();
  try {
    const runner = loadRunner();
    fs.mkdirSync(path.join(repoRoot, 'test', 'e2e', 'cli'), { recursive: true });
    const invocation = runner.resolvePlaywrightInvocation(['--grep', 'smoke'], { repoRoot });

    assert.deepEqual(invocation.args.slice(0, 4), [
      require.resolve('@playwright/test/cli'),
      'test',
      '--config=playwright.cli.config.ts',
      '--grep'
    ]);
    assert.equal(invocation.args[4], 'smoke');
    assert.ok(!invocation.args.includes('--pass-with-no-tests'));
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('resolvePlaywrightInvocation includes a retries override when PLAYWRIGHT_RETRIES is set', () => {
  const originalRetries = process.env.PLAYWRIGHT_RETRIES;
  process.env.PLAYWRIGHT_RETRIES = '0';

  try {
    const runner = loadRunner();
    const repoRoot = createTempRepo();
    try {
      fs.mkdirSync(path.join(repoRoot, 'test', 'e2e', 'cli'), { recursive: true });
      const invocation = runner.resolvePlaywrightInvocation(['--grep', 'smoke'], { repoRoot });

      assert.deepEqual(invocation.args.slice(0, 5), [
        require.resolve('@playwright/test/cli'),
        'test',
        '--config=playwright.cli.config.ts',
        '--retries=0',
        '--grep'
      ]);
      assert.equal(invocation.args[5], 'smoke');
    } finally {
      cleanupTempRepo(repoRoot);
    }
  } finally {
    if (originalRetries === undefined) {
      delete process.env.PLAYWRIGHT_RETRIES;
    } else {
      process.env.PLAYWRIGHT_RETRIES = originalRetries;
    }
  }
});

test('package.json does not expose a separate pretest:e2e:cli build hook', () => {
  const scripts = readPackageScripts();

  assert.equal(scripts['pretest:e2e:cli'], undefined);
});

test('package.json exposes test:e2e:cli = node scripts/run-playwright-cli-e2e.js', () => {
  const scripts = readPackageScripts();

  assert.equal(scripts['test:e2e:cli'], 'node scripts/run-playwright-cli-e2e.js');
});

test('package.json test:scripts includes scripts/run-playwright-cli-e2e.test.js', () => {
  const scripts = readPackageScripts();

  assert.match(scripts['test:scripts'], /\bscripts\/run-playwright-cli-e2e\.test\.js\b/);
});
