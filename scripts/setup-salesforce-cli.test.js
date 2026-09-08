const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const modulePath = path.join(__dirname, 'setup-salesforce-cli.mjs');

async function loadModule() {
  return import(pathToFileURL(modulePath).href);
}

function tempDir(name = 'alv-sf-cli-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function silentStdout() {
  return { write() {} };
}

test('default Salesforce CLI cache selects the JWT signup and export validated release', async () => {
  const mod = await loadModule();
  assert.equal(mod.resolveSalesforceCliCacheConfig({ env: {} }).packageName, '@salesforce/cli@2.150.6');
});

test('normalizeSalesforceCliPackage accepts exact and nightly official package specs only', async () => {
  const mod = await loadModule();

  assert.equal(mod.normalizeSalesforceCliPackage('@salesforce/cli@2.136.8'), '@salesforce/cli@2.136.8');
  assert.equal(mod.normalizeSalesforceCliPackage('@salesforce/cli@nightly'), '@salesforce/cli@nightly');
  assert.throws(
    () => mod.normalizeSalesforceCliPackage('@salesforce/cli@latest'),
    /must be @salesforce\/cli pinned to an exact version/
  );
  assert.throws(() => mod.normalizeSalesforceCliPackage('sfdx-cli@latest'), /must be @salesforce\/cli/);
});

test('resolveSalesforceCliCacheConfig builds a sanitized OS and package scoped cache key', async () => {
  const mod = await loadModule();
  const root = tempDir();

  try {
    const config = mod.resolveSalesforceCliCacheConfig({
      env: {
        RUNNER_TOOL_CACHE: root,
        SALESFORCE_CLI_CACHE_KEY_OS: 'Windows',
        SALESFORCE_CLI_PACKAGE: '@salesforce/cli@2.136.8'
      },
      platform: 'win32',
      nodeVersion: '24.15.0'
    });

    assert.equal(config.cacheKey, 'alv-sf-cli-windows-node-24.15.0-salesforce-cli-2.136.8');
    assert.equal(config.cacheDir, path.join(root, config.cacheKey));
    assert.equal(config.packageName, '@salesforce/cli@2.136.8');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setupSalesforceCli installs into the managed prefix and exports bin paths on cold cache', async () => {
  const mod = await loadModule();
  const root = tempDir();
  const githubEnv = path.join(root, 'github-env');
  const githubPath = path.join(root, 'github-path');
  const calls = [];

  try {
    const result = mod.setupSalesforceCli({
      env: {
        RUNNER_TOOL_CACHE: root,
        GITHUB_ENV: githubEnv,
        GITHUB_PATH: githubPath,
        SALESFORCE_CLI_PACKAGE: '@salesforce/cli@2.136.8'
      },
      platform: 'linux',
      spawnSyncFn(command, args) {
        calls.push({ command, args });
        return { status: 0 };
      },
      execFileSyncFn(command, args) {
        calls.push({ command, args, version: true });
        return '@salesforce/cli/2.136.8 linux-x64 node-v24.15.0\n';
      },
      stdout: silentStdout()
    });

    assert.equal(calls[0].command, 'npm');
    assert.deepEqual(calls[0].args.slice(0, 5), [
      'install',
      '-g',
      '--prefix',
      result.cacheDir,
      '@salesforce/cli@2.136.8'
    ]);
    assert.equal(result.sfBinPath, path.join(result.cacheDir, 'bin', 'sf'));
    assert.match(fs.readFileSync(githubEnv, 'utf8'), /SF_CLI_BIN_PATH=.*[\\/]bin[\\/]sf/);
    assert.match(fs.readFileSync(githubEnv, 'utf8'), /ALV_SF_BIN_PATH=.*[\\/]bin[\\/]sf/);
    assert.equal(fs.readFileSync(githubPath, 'utf8').trim(), path.join(result.cacheDir, 'bin'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setupSalesforceCli invokes npm without a shell for an environment-derived Windows cache path', async () => {
  const mod = await loadModule();
  const root = tempDir();
  const nodePath = path.join(root, 'node.exe');
  const npmCliPath = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const runnerToolCache = path.join(root, 'cache & echo compromised');
  const calls = [];

  try {
    fs.mkdirSync(path.dirname(npmCliPath), { recursive: true });
    fs.writeFileSync(npmCliPath, '#!/usr/bin/env node\n');

    const result = mod.setupSalesforceCli({
      env: {
        RUNNER_TOOL_CACHE: runnerToolCache,
        SALESFORCE_CLI_PACKAGE: '@salesforce/cli@2.136.8'
      },
      platform: 'win32',
      nodePath,
      spawnSyncFn(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      execFileSyncFn() {
        return '@salesforce/cli/2.136.8 win32-x64 node-v24.15.0\n';
      },
      stdout: silentStdout()
    });

    assert.equal(calls[0].command, nodePath);
    assert.equal(calls[0].args[0], npmCliPath);
    assert.deepEqual(calls[0].args.slice(1, 6), [
      'install',
      '-g',
      '--prefix',
      result.cacheDir,
      '@salesforce/cli@2.136.8'
    ]);
    assert.equal(calls[0].options.shell, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setupSalesforceCli reuses an exact cached package when sf --version matches', async () => {
  const mod = await loadModule();
  const root = tempDir();
  const config = mod.resolveSalesforceCliCacheConfig({
    env: { RUNNER_TOOL_CACHE: root, SALESFORCE_CLI_PACKAGE: '@salesforce/cli@2.136.8' },
    platform: 'linux',
    nodeVersion: process.versions.node
  });
  const sfBinPath = mod.resolveSalesforceCliBinPath(config.cacheDir, 'linux');
  const entryPoint = mod.resolveSalesforceCliEntryPoint(config.cacheDir, 'linux');
  const installCalls = [];

  try {
    fs.mkdirSync(path.dirname(sfBinPath), { recursive: true });
    fs.writeFileSync(sfBinPath, '#!/usr/bin/env node\n');
    fs.mkdirSync(path.dirname(entryPoint), { recursive: true });
    fs.writeFileSync(entryPoint, '#!/usr/bin/env node\n');

    mod.setupSalesforceCli({
      env: {
        RUNNER_TOOL_CACHE: root,
        SALESFORCE_CLI_PACKAGE: '@salesforce/cli@2.136.8'
      },
      platform: 'linux',
      spawnSyncFn(command, args) {
        installCalls.push({ command, args });
        return { status: 0 };
      },
      execFileSyncFn() {
        return '@salesforce/cli/2.136.8 linux-x64 node-v24.15.0\n';
      },
      stdout: silentStdout()
    });

    assert.deepEqual(installCalls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setupSalesforceCli reinstalls nightly even when a cached binary exists', async () => {
  const mod = await loadModule();
  const root = tempDir();
  const config = mod.resolveSalesforceCliCacheConfig({
    env: { RUNNER_TOOL_CACHE: root, SALESFORCE_CLI_PACKAGE: '@salesforce/cli@nightly' },
    platform: 'linux',
    nodeVersion: process.versions.node
  });
  const sfBinPath = mod.resolveSalesforceCliBinPath(config.cacheDir, 'linux');
  const installCalls = [];

  try {
    fs.mkdirSync(path.dirname(sfBinPath), { recursive: true });
    fs.writeFileSync(sfBinPath, '#!/usr/bin/env node\n');

    mod.setupSalesforceCli({
      env: {
        RUNNER_TOOL_CACHE: root,
        SALESFORCE_CLI_PACKAGE: '@salesforce/cli@nightly'
      },
      platform: 'linux',
      spawnSyncFn(command, args) {
        installCalls.push({ command, args });
        return { status: 0 };
      },
      execFileSyncFn() {
        return '@salesforce/cli/2.141.6 linux-x64 node-v24.15.0\n';
      },
      stdout: silentStdout()
    });

    assert.equal(installCalls.length, 1);
    assert.ok(installCalls[0].args.includes('@salesforce/cli@nightly'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setupSalesforceCli writes a sanitized Node wrapper when SALESFORCE_CLI_WRAP_NODE is enabled', async () => {
  const mod = await loadModule();
  const root = tempDir();
  const runnerTemp = path.join(root, 'runner-temp');
  const githubEnv = path.join(root, 'github-env');
  const githubPath = path.join(root, 'github-path');

  try {
    const result = mod.setupSalesforceCli({
      env: {
        RUNNER_TOOL_CACHE: root,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: githubEnv,
        GITHUB_PATH: githubPath,
        SALESFORCE_CLI_PACKAGE: '@salesforce/cli@2.136.8',
        SALESFORCE_CLI_WRAP_NODE: '1'
      },
      platform: 'darwin',
      nodePath: '/opt/hostedtoolcache/node/20/bin/node',
      spawnSyncFn() {
        return { status: 0 };
      },
      execFileSyncFn() {
        return '@salesforce/cli/2.136.8 darwin-arm64 node-v20.19.0\n';
      },
      stdout: silentStdout()
    });

    assert.equal(result.exportedSfBinPath, path.join(runnerTemp, 'alv-sf-node', 'sf'));
    const wrapper = fs.readFileSync(result.exportedSfBinPath, 'utf8');
    assert.match(wrapper, /unset ELECTRON_RUN_AS_NODE/);
    assert.match(wrapper, /export PATH='\/opt\/hostedtoolcache\/node\/20\/bin':"\$\{PATH:-\}"/);
    assert.match(wrapper, /exec '.*[\\/]bin[\\/]sf' "\$@"/);

    const envFile = fs.readFileSync(githubEnv, 'utf8');
    assert.match(envFile, /SF_CLI_BIN_PATH=.*alv-sf-node[\\/]sf/);
    assert.match(envFile, /ALV_SF_BIN_PATH=.*alv-sf-node[\\/]sf/);
    assert.match(envFile, /SF_CLI_NODE_PATH=\/opt\/hostedtoolcache\/node\/20\/bin\/node/);
    assert.match(fs.readFileSync(githubPath, 'utf8'), /[\\/]bin$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeGitHubCacheOutputs emits cache key and path outputs', async () => {
  const mod = await loadModule();
  const root = tempDir();
  const outputFile = path.join(root, 'github-output');

  try {
    const text = mod.writeGitHubCacheOutputs({
      env: { GITHUB_OUTPUT: outputFile },
      cacheKey: 'alv-sf-cli-linux-node-24-salesforce-cli-2.136.8',
      cacheDir: path.join(root, 'cache')
    });

    assert.match(text, /cache-key=alv-sf-cli-linux-node-24-salesforce-cli-2\.136\.8/);
    assert.match(fs.readFileSync(outputFile, 'utf8'), /cache-dir=.*cache/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('macOS wrapper shares private Salesforce state with the desktop without overriding isolated JWT homes', async t => {
  const bash =
    process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/bash.exe'),
          path.join(process.env.ProgramFiles || '', 'Git/bin/bash.exe')
        ].find(fs.existsSync)
      : 'bash';
  if (!bash) return t.skip('Requires a native POSIX shell for the macOS wrapper.');
  const mod = await loadModule();
  const root = tempDir();
  try {
    fs.writeFileSync(
      path.join(root, 'fake-sf'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$HOME" "$SF_USE_GENERIC_UNIX_KEYCHAIN"\n',
      { mode: 0o755 }
    );
    mod.writeMacOSNodeWrapper({
      nodePath: '/usr/bin/node',
      sfBinPath: './fake-sf',
      wrapperPath: path.join(root, 'wrapper')
    });
    for (const dir of ['desktop', 'runner/alv-sf-home.test', 'jwt-operation', 'importer']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
    }
    const unixRoot = spawnSync(bash, ['-c', 'pwd -P'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const desktop = `${unixRoot}/desktop`;
    const privateAuth = `${unixRoot}/runner/alv-sf-home.test`;
    const baseEnv = {
      ...process.env,
      GITHUB_ACTIONS: 'true',
      RUNNER_OS: 'macOS',
      RUNNER_TEMP: `${unixRoot}/runner`,
      SF_USE_GENERIC_UNIX_KEYCHAIN: 'true',
      MSYS_NO_PATHCONV: '1'
    };
    for (const [home, privateHome, desktopHome, expected] of [
      [desktop, privateAuth, desktop, privateAuth],
      [privateAuth, privateAuth, desktop, privateAuth],
      [`${unixRoot}/jwt-operation`, privateAuth, desktop, `${unixRoot}/jwt-operation`],
      [`${unixRoot}/importer`, privateAuth, desktop, `${unixRoot}/importer`],
      [desktop, '', '', desktop]
    ]) {
      const result = spawnSync(bash, ['wrapper'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...baseEnv,
          HOME: home,
          ALV_CI_AUTH_HOME: privateHome,
          ALV_E2E_DESKTOP_HOME: desktopHome,
          SF_USE_GENERIC_UNIX_KEYCHAIN: 'true',
          MSYS_NO_PATHCONV: '1'
        }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split(/\r?\n/), [expected, 'true']);
    }
    for (const [privateHome, desktopHome] of [
      ['', desktop],
      [privateAuth, ''],
      ['relative', desktop],
      [privateAuth, 'relative'],
      [desktop, desktop],
      [`${unixRoot}/missing`, desktop],
      [`${unixRoot}/jwt-operation`, desktop],
      [privateAuth, `${unixRoot}/missing`],
      [`${unixRoot}/runner/../desktop`, desktop]
    ]) {
      const result = spawnSync(bash, ['wrapper'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...baseEnv,
          HOME: desktop,
          ALV_CI_AUTH_HOME: privateHome,
          ALV_E2E_DESKTOP_HOME: desktopHome,
          SF_USE_GENERIC_UNIX_KEYCHAIN: 'true',
          MSYS_NO_PATHCONV: '1'
        }
      });
      assert.notEqual(result.status, 0, `Invalid CI authentication homes must not invoke Salesforce: ${privateHome}`);
      assert.equal(result.stdout, '');
    }
    const outsideCI = spawnSync(bash, ['wrapper'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...baseEnv, GITHUB_ACTIONS: '', HOME: desktop, ALV_CI_AUTH_HOME: 'invalid', ALV_E2E_DESKTOP_HOME: desktop }
    });
    assert.equal(outsideCI.status, 0, outsideCI.stderr);
    assert.deepEqual(outsideCI.stdout.trim().split(/\r?\n/), [desktop, 'true']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
