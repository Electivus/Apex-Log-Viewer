const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertSupportedNode, bootstrapLocalE2e } = require('./local-e2e-bootstrap');

test('selected Node follows the pinned LTS major and minimum release', () => {
  for (const version of ['24.15.0', '24.15.1', '24.21.0']) {
    assert.doesNotThrow(() => assertSupportedNode(version, '24.15.0'));
  }
  for (const version of ['26.8.2', '22.21.0', '24.14.9', '24.21.0-nightly']) {
    assert.throws(() => assertSupportedNode(version, '24.15.0'), /requires Node 24.x at least 24.15.0/);
  }
  assert.throws(() => assertSupportedNode('24.21.0', '24'), /complete Node version in .nvmrc/);
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-local-bootstrap-'));
  const config = path.join(home, '.config', 'electivus', 'apex-log-viewer', 'e2e.sh');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, '# operator configuration\n', { mode: 0o600 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, config };
}

for (const selectedPnpm of [true, false]) {
  test(
    `Linux launcher preserves the selected Node and uses ${selectedPnpm ? 'selected' : 'fallback'} pnpm`,
    { skip: process.platform !== 'linux' },
    t => {
      const { home, config } = fixture(t);
      const scripts = path.join(home, 'checkout', 'scripts');
      const runtimeBin = path.join(home, 'selected runtime', 'bin');
      const localBin = path.join(home, '.local', 'bin');
      const toolsBin = path.join(home, 'tools');
      const sfCache = path.join(home, 'sf-cache');
      for (const directory of [scripts, runtimeBin, localBin, toolsBin, path.join(sfCache, 'bin')]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      const executable = (file, content) => fs.writeFileSync(file, content, { mode: 0o755 });
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
      executable(
        path.join(runtimeBin, 'node'),
        `#!/bin/sh\nexport ALV_TEST_SELECTED_NODE=1\nexec ${quote(process.execPath)} "$@"\n`
      );
      // A user-tool fallback must not override the caller's runtime selection.
      executable(path.join(localBin, 'node'), '#!/bin/sh\nexit 97\n');
      executable(path.join(localBin, 'pnpm'), '#!/bin/sh\nprintf fallback-pnpm\n');
      if (selectedPnpm) executable(path.join(runtimeBin, 'pnpm'), '#!/bin/sh\nprintf selected-pnpm\n');
      fs.symlinkSync('/usr/bin/dirname', path.join(toolsBin, 'dirname'));
      fs.copyFileSync(path.join(__dirname, 'run-wsl-e2e.sh'), path.join(scripts, 'run-wsl-e2e.sh'));
      fs.symlinkSync(path.join(__dirname, 'local-e2e-bootstrap.js'), path.join(scripts, 'local-e2e-bootstrap.js'));
      fs.writeFileSync(config, 'export SF_SCRATCH_POOL_NAME=test-pool\n');
      executable(path.join(sfCache, 'bin', 'sf'), '#!/bin/sh\nexit 0\n');
      fs.writeFileSync(
        path.join(scripts, 'setup-salesforce-cli.mjs'),
        'export const resolveSalesforceCliCacheConfig = () => ({cacheDir: process.env.SALESFORCE_CLI_CACHE_ROOT});\n' +
          'export const resolveSalesforceCliBinPath = cacheDir => `${cacheDir}/bin/sf`;\n'
      );
      // Stub only JWT/network work; run the real launcher, version guard and child.
      fs.writeFileSync(
        path.join(scripts, 'devhub-local.js'),
        'const {spawnSync} = require("node:child_process");\n' +
          'const args = process.argv.slice(process.argv.indexOf("--") + 1);\n' +
          'process.exit(spawnSync(args[0], args.slice(1), {stdio: "inherit"}).status ?? 1);\n'
      );
      const result = spawnSync(
        '/bin/bash',
        [
          path.join(scripts, 'run-wsl-e2e.sh'),
          'run',
          '--',
          'node',
          '-e',
          'console.log(JSON.stringify({selectedNode: process.env.ALV_TEST_SELECTED_NODE, ' +
            'pnpm: require("node:child_process").execFileSync("pnpm", {encoding: "utf8"})}));'
        ],
        {
          env: {
            HOME: home,
            PATH: `${runtimeBin}:${toolsBin}`,
            SALESFORCE_CLI_CACHE_ROOT: sfCache
          },
          encoding: 'utf8',
          timeout: 10000
        }
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.deepEqual(JSON.parse(result.stdout), {
        selectedNode: '1',
        pnpm: selectedPnpm ? 'selected-pnpm' : 'fallback-pnpm'
      });
    }
  );
}

test('configured GUI bootstrap forwards literal arguments and the child exit code without another package build', async t => {
  const { home } = fixture(t);
  const args = ['--grep', 'viewer $HOME; echo wrong', 'test with spaces.e2e.spec.ts'];
  const env = { NODE_USE_SYSTEM_CA: '1' };
  const entrypoint = path.join(__dirname, 'run-playwright-e2e.js');
  let invocation;
  const result = await bootstrapLocalE2e(
    { entrypoint, args, gui: true },
    {
      home,
      env,
      platform: 'linux',
      spawnImpl(file, argv, options) {
        invocation = { file, argv, options };
        const child = new EventEmitter();
        process.nextTick(() => child.emit('close', 37, null));
        return child;
      }
    }
  );
  assert.deepEqual(result, { code: 37, signal: null });
  assert.equal(invocation.file, 'bash');
  assert.deepEqual(invocation.argv, [
    path.join(__dirname, 'run-wsl-e2e.sh'),
    'run',
    '--',
    'xvfb-run',
    '-a',
    '-s',
    '-screen 0 1280x1024x24',
    'node',
    entrypoint,
    ...args
  ]);
  assert.equal(invocation.options.cwd, path.join(__dirname, '..'));
  assert.equal(invocation.options.env, env);
  assert.equal(invocation.options.stdio, 'inherit');
});

test('CLI bootstrap supports XDG configuration and preserves a child signal without starting Xvfb', async t => {
  const { home, config } = fixture(t);
  const xdgConfigHome = path.join(home, 'operator config');
  const destination = path.join(xdgConfigHome, 'electivus', 'apex-log-viewer', 'e2e.sh');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(config, destination);
  const entrypoint = path.join(__dirname, 'run-playwright-cli-e2e.js');
  const result = await bootstrapLocalE2e(
    { entrypoint },
    {
      home,
      platform: 'linux',
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      spawnImpl(_file, argv) {
        assert.deepEqual(argv.slice(1), ['run', '--', 'node', entrypoint]);
        const child = new EventEmitter();
        process.nextTick(() => child.emit('close', null, 'SIGTERM'));
        return child;
      }
    }
  );
  assert.deepEqual(result, { code: null, signal: 'SIGTERM' });
});

for (const [name, overrides, args] of [
  ['CI', { env: { CI: 'true' } }],
  ['GitHub Actions', { env: { GITHUB_ACTIONS: 'true' } }],
  ['Windows', { platform: 'win32' }],
  ['macOS', { platform: 'darwin' }],
  ['partial JWT', { env: { SF_DEVHUB_CLIENT_ID: 'explicit-client' } }],
  ['file JWT input', { env: { SF_DEVHUB_PRIVATE_KEY_FILE: '/private/key.pem' } }],
  ['legacy alias', { env: { SF_DEVHUB_ALIAS: 'host-alias' } }],
  ['legacy auth URL', { env: { SF_DEVHUB_AUTH_URL: 'explicit-legacy-input' } }],
  ['legacy SFDX auth URL', { env: { SFDX_AUTH_URL: 'explicit-legacy-input' } }],
  ['help', {}, ['--help']],
  ['test listing', {}, ['--list']],
  ['custom configuration', {}, ['--config=playwright.docs.config.ts']],
  ['separate custom configuration', {}, ['--config', 'playwright.docs.config.ts']]
]) {
  test(`${name} never starts operator authentication or reads local shell configuration`, async t => {
    const { home } = fixture(t);
    assert.equal(
      await bootstrapLocalE2e(
        { entrypoint: __filename, args },
        {
          home,
          platform: 'linux',
          env: {},
          ...overrides,
          spawnImpl() {
            throw new Error('Must not start local authentication');
          }
        }
      ),
      undefined
    );
  });
}

test('the JWT supplied by the verified wrapper prevents recursive bootstrap', async t => {
  const { home } = fixture(t);
  const env = {
    SF_DEVHUB_CLIENT_ID: 'client',
    SF_DEVHUB_USERNAME: 'operator@example.com',
    SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
    SF_DEVHUB_PRIVATE_KEY_FILE: '/private/active-key.pem'
  };
  assert.equal(
    await bootstrapLocalE2e(
      { entrypoint: __filename },
      {
        home,
        platform: 'linux',
        env,
        spawnImpl() {
          throw new Error('Recursive authentication');
        }
      }
    ),
    undefined
  );
});

for (const env of [{ CI: 'false' }, { CI: '0' }, { CI: ' FALSE ' }, { GITHUB_ACTIONS: 'false' }]) {
  test(`false CI flags permit configured local authentication: ${JSON.stringify(env)}`, async t => {
    const { home } = fixture(t);
    const result = await bootstrapLocalE2e(
      { entrypoint: __filename },
      {
        home,
        platform: 'linux',
        env,
        spawnImpl() {
          const child = new EventEmitter();
          process.nextTick(() => child.emit('close', 0, null));
          return child;
        }
      }
    );
    assert.deepEqual(result, { code: 0, signal: null });
  });
}

test('an unconfigured machine retains the existing runner behavior', async t => {
  const { home, config } = fixture(t);
  fs.unlinkSync(config);
  assert.equal(
    await bootstrapLocalE2e(
      { entrypoint: __filename },
      {
        home,
        platform: 'linux',
        env: {},
        spawnImpl() {
          throw new Error('Unexpected local authentication');
        }
      }
    ),
    undefined
  );
});

test('bootstrap startup errors do not forward process details', async t => {
  const { home } = fixture(t);
  await assert.rejects(
    bootstrapLocalE2e(
      { entrypoint: __filename },
      {
        home,
        platform: 'linux',
        env: {},
        spawnImpl() {
          const child = new EventEmitter();
          process.nextTick(() => child.emit('error', new Error('sensitive process details')));
          return child;
        }
      }
    ),
    { message: 'Cannot start the configured local E2E environment.' }
  );
});
