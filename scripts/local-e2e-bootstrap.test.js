const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootstrapLocalE2e } = require('./local-e2e-bootstrap');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-local-bootstrap-'));
  const config = path.join(home, '.config', 'electivus', 'apex-log-viewer', 'e2e.sh');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, '# operator configuration\n', { mode: 0o600 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, config };
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
