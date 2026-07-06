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

test('ensureSfPluginBuildArtifacts runs npm run build:sf-plugin when the plugin command is missing', async () => {
  const repoRoot = createTempRepo();
  try {
    const runner = loadRunner();
    let recordedCall;

    await runner.ensureSfPluginBuildArtifacts(repoRoot, {
      spawnImpl(command, args, options) {
        recordedCall = { command, args, options };
        const child = new EventEmitter();
        process.nextTick(() => {
          const pluginCommandPath = path.join(repoRoot, runner.resolveSfPluginCommandRelativePath());
          fs.mkdirSync(path.dirname(pluginCommandPath), { recursive: true });
          fs.writeFileSync(pluginCommandPath, '', 'utf8');
          child.emit('exit', 0, null);
        });
        return child;
      }
    });

    assert.ok(recordedCall, 'expected ensureSfPluginBuildArtifacts to invoke the plugin build command');
    if (process.platform === 'win32') {
      assert.equal(recordedCall.command, process.env.ComSpec || 'cmd.exe');
      assert.deepEqual(recordedCall.args, ['/d', '/s', '/c', 'npm.cmd', 'run', 'build:sf-plugin']);
    } else {
      assert.equal(recordedCall.command, 'npm');
      assert.deepEqual(recordedCall.args, ['run', 'build:sf-plugin']);
    }
    assert.equal(recordedCall.options.cwd, repoRoot);
    assert.equal(recordedCall.options.stdio, 'inherit');
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('ensureSfPluginBuildArtifacts skips npm run build:sf-plugin when the plugin command exists', async () => {
  const repoRoot = createTempRepo();
  try {
    const runner = loadRunner();
    const pluginCommandPath = path.join(repoRoot, runner.resolveSfPluginCommandRelativePath());
    fs.mkdirSync(path.dirname(pluginCommandPath), { recursive: true });
    fs.writeFileSync(pluginCommandPath, '', 'utf8');

    await runner.ensureSfPluginBuildArtifacts(repoRoot, {
      spawnImpl() {
        throw new Error('unexpected plugin build');
      }
    });
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('ensureSfPluginBuildArtifacts fails when build completes without producing the plugin command', async () => {
  const repoRoot = createTempRepo();
  try {
    const runner = loadRunner();

    await assert.rejects(
      () =>
        runner.ensureSfPluginBuildArtifacts(repoRoot, {
          spawnImpl() {
            const child = new EventEmitter();
            process.nextTick(() => child.emit('exit', 0, null));
            return child;
          }
        }),
      /did not produce required sf plugin artifact/
    );
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('resolvePlaywrightEnv passes the local sf plugin bin to Playwright', () => {
  const runner = loadRunner();
  const repoRoot = createTempRepo();
  const env = runner.resolvePlaywrightEnv({ EXISTING: '1', ALV_SF_BIN_PATH: '/opt/salesforce/bin/sf' }, repoRoot);

  assert.equal(env.EXISTING, '1');
  assert.equal(env.ALV_SF_BIN_PATH, '/opt/salesforce/bin/sf');
  assert.equal(
    env.ALV_ELECTIVUS_PLUGIN_BIN_PATH,
    path.join(repoRoot, 'packages', 'sf-plugin', 'bin', 'run.js')
  );
  cleanupTempRepo(repoRoot);
});

test('resolveSalesforceCliPath skips the workspace plugin sf shim', () => {
  const repoRoot = createTempRepo();
  try {
    const runner = loadRunner();
    const pluginShimPath = path.join(repoRoot, 'node_modules', '.bin', 'sf');
    const pluginPackageJson = path.join(repoRoot, 'node_modules', '@electivus', 'plugin-electivus', 'package.json');
    const salesforceCliPath = path.join(repoRoot, 'tools', 'sf');

    fs.mkdirSync(path.dirname(pluginShimPath), { recursive: true });
    fs.mkdirSync(path.dirname(pluginPackageJson), { recursive: true });
    fs.mkdirSync(path.dirname(salesforceCliPath), { recursive: true });
    fs.writeFileSync(pluginShimPath, '');
    fs.writeFileSync(pluginPackageJson, '{}');
    fs.writeFileSync(salesforceCliPath, '');

    assert.equal(
      runner.resolveSalesforceCliPath(repoRoot, {
        env: {},
        spawnSyncImpl() {
          return {
            status: 0,
            stdout: `${pluginShimPath}\n${salesforceCliPath}\n`
          };
        }
      }),
      salesforceCliPath
    );
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('resolveSalesforceCliPath prefers sf.cmd over the bare Windows shim', () => {
  const repoRoot = createTempRepo();
  try {
    const runner = loadRunner();
    const bareSfPath = String.raw`C:\Tools\sf`;
    const cmdSfPath = String.raw`C:\Tools\sf.cmd`;

    assert.equal(
      runner.resolveSalesforceCliPath(repoRoot, {
        env: {},
        targetPlatform: 'win32',
        spawnSyncImpl(command, args) {
          assert.equal(
            path.basename(command).toLowerCase(),
            path.basename(process.env.ComSpec || 'cmd.exe').toLowerCase()
          );
          assert.deepEqual(args, ['/d', '/s', '/c', 'where sf']);
          return {
            status: 0,
            stdout: `${bareSfPath}\r\n${cmdSfPath}\r\n`
          };
        }
      }),
      cmdSfPath
    );
  } finally {
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

test('resolvePlaywrightInvocation validates PLAYWRIGHT_RETRIES when provided', () => {
  const runner = loadRunner();

  assert.throws(
    () => runner.resolvePlaywrightInvocation([], { env: { PLAYWRIGHT_RETRIES: 'sometimes' } }),
    /PLAYWRIGHT_RETRIES/
  );
  assert.deepEqual(
    runner.resolvePlaywrightInvocation([], { env: { PLAYWRIGHT_RETRIES: '2' } }).args.filter(arg =>
      String(arg).startsWith('--retries=')
    ),
    ['--retries=2']
  );
});
