const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const yaml = require('yaml');

const {
  ensureHostVolumeMountpoints,
  normalizeSalesforceCliPackage,
  parseProxyLabArgs,
  resolveComposeArgs,
  resolveProxyLabEnv
} = require('./run-e2e-proxy-lab');
const { main } = require('./run-e2e-proxy-lab');

async function fakeEngine(_file, args) {
  assert.equal(args[0], 'volume');
  return { stdout: '' };
}

function reportCleanExit(args) {
  const overrideFile = args[args.lastIndexOf('-f') + 1];
  const config = yaml.parse(fs.readFileSync(overrideFile, 'utf8'));
  const report = config.services.runner?.volumes.find(mount => mount.target === '/run/alv-report');
  if (report) fs.writeFileSync(path.join(report.source, 'complete'), 'clean');
  return config;
}

test('real-org lab entry point rejects missing and partial JWT before starting Compose', () => {
  for (const jwt of [{}, { SF_DEVHUB_USERNAME: 'test@example.invalid' }]) {
    const env = { ...process.env, CI: 'false', DOCKER: 'alv-compose-must-not-start', ...jwt };
    for (const name of [
      'SF_DEVHUB_CLIENT_ID',
      'SF_DEVHUB_LOGIN_URL',
      'SF_DEVHUB_PRIVATE_KEY',
      'SF_DEVHUB_PRIVATE_KEY_FILE'
    ]) {
      delete env[name];
    }
    env.SF_DEVHUB_ALIAS = 'CachedHostAlias';
    env.SF_DEVHUB_AUTH_URL = 'legacy-auth-must-not-be-used';
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'run-e2e-proxy-lab.js'), '--', 'node', 'scripts/run-playwright-cli-e2e.js'],
      { env, encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Dev Hub JWT configuration/);
    assert.doesNotMatch(result.stderr, /Failed to start|ENOENT|legacy-auth-must-not-be-used/);
  }
});

test('lab transports validated JWT in an owned read-only mount and cleans it after either Compose result', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-lab-caller-'));
  const sourceKey = path.join(source, 'caller.pem');
  fs.writeFileSync(sourceKey, privateKey);
  try {
    for (const exitCode of [0, 19]) {
      let secretDirectory;
      const engineCalls = [];
      const result = await main({
        execFileAsync: async (...args) => {
          engineCalls.push(args[1]);
          return fakeEngine(...args);
        },
        argv: ['--', 'node', 'scripts/run-playwright-cli-e2e.js'],
        env: {
          ...process.env,
          SF_DEVHUB_CLIENT_ID: 'TestEca',
          SF_DEVHUB_USERNAME: 'test@example.invalid',
          SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
          SF_DEVHUB_PRIVATE_KEY_FILE: sourceKey,
          SF_DEVHUB_PRIVATE_KEY: '',
          SF_DEVHUB_AUTH_URL: 'must-not-propagate',
          SF_SCRATCH_SIGNUP_CONNECTED_APP: 'PlatformCLI',
          SF_TEMP_SHOW_SECRETS: 'true'
        },
        spawnImpl: (_command, args, options) => {
          const overrideFile = args[args.lastIndexOf('-f') + 1];
          const volumes = yaml.parse(fs.readFileSync(overrideFile, 'utf8')).services.runner.volumes;
          const state = volumes.find(value => value.target === '/run/alv-state');
          assert.equal(state.type, 'volume', 'CLI secret state needs native Linux permissions');
          reportCleanExit(args);
          const mount = volumes.find(value => value.target === '/run/alv-devhub');
          assert.equal(mount.read_only, true, 'the input mount must be read-only');
          secretDirectory = mount.source;
          assert.equal(path.resolve(secretDirectory).startsWith(path.resolve(__dirname, '..') + path.sep), false);
          assert.equal(fs.existsSync(path.join(secretDirectory, 'private-key.pem')), true);
          assert.equal(fs.readFileSync(path.join(secretDirectory, 'private-key.pem'), 'utf8') === privateKey, true);
          for (const name of [
            'SF_DEVHUB_PRIVATE_KEY',
            'SF_DEVHUB_PRIVATE_KEY_FILE',
            'SF_DEVHUB_CLIENT_ID',
            'SF_DEVHUB_USERNAME',
            'SF_DEVHUB_AUTH_URL',
            'SF_TEMP_SHOW_SECRETS',
            'SF_SCRATCH_SIGNUP_CONNECTED_APP'
          ]) {
            assert.equal(options.env[name], undefined, `${name} must not enter Compose`);
          }
          assert.equal(
            args.some(value => value.includes(privateKey)),
            false
          );
          const child = new EventEmitter();
          process.nextTick(() => child.emit('close', exitCode, null));
          return child;
        }
      });
      assert.equal(result, exitCode);
      assert.equal(fs.existsSync(secretDirectory), false);
      assert.equal(fs.existsSync(sourceKey), true, 'caller-owned material survives');
      assert.equal(engineCalls.length, 2);
      assert.deepEqual(engineCalls[1], ['volume', 'rm', engineCalls[0][2]]);
    }
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('interrupted runner reports its owned volume and removes input without destroying recovery state', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const engineCalls = [];
  let operation;
  let stateVolume;
  try {
    await assert.rejects(
      () =>
        main({
          argv: [],
          env: {
            SF_DEVHUB_CLIENT_ID: 'TestEca',
            SF_DEVHUB_USERNAME: 'test@example.invalid',
            SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
            SF_DEVHUB_PRIVATE_KEY: privateKey
          },
          execFileAsync: async (...args) => {
            engineCalls.push(args[1]);
            return fakeEngine(...args);
          },
          spawnImpl: (_file, args) => {
            const config = JSON.parse(fs.readFileSync(args[args.lastIndexOf('-f') + 1], 'utf8'));
            operation = path.dirname(
              config.services.runner.volumes.find(mount => mount.target === '/run/alv-devhub').source
            );
            stateVolume = config.volumes.alv_jwt_state.name;
            const child = new EventEmitter();
            process.nextTick(() => child.emit('close', null, 'SIGTERM'));
            return child;
          }
        }),
      error => error.message.includes(stateVolume) && error.message.includes(path.join(operation, 'report'))
    );
    assert.equal(engineCalls.length, 1, 'retained volume must not be removed');
    assert.equal(fs.existsSync(path.join(operation, 'input')), false);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(operation, 'report', 'operation.json'), 'utf8')).stateVolume,
      stateVolume
    );
  } finally {
    if (operation) fs.rmSync(operation, { recursive: true, force: true });
  }
});

test('child validates the same strict policy and keeps a credential-free non-org smoke usable', async () => {
  const { main: childMain } = require('./run-e2e-proxy-lab-child');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-lab-child-test-'));
  try {
    await assert.rejects(
      () =>
        childMain({
          argv: ['--validate', 'node', 'scripts/run-playwright-cli-e2e.js'],
          inputDirectory: root,
          env: { CI: 'false', SF_DEVHUB_ALIAS: 'CachedAlias', SF_DEVHUB_AUTH_URL: 'legacy-value' }
        }),
      /Dev Hub JWT configuration/
    );
    fs.writeFileSync(path.join(root, 'devhub.json'), JSON.stringify({ SF_DEVHUB_USERNAME: 'test@example.invalid' }));
    await assert.rejects(
      () => childMain({ argv: ['--validate', 'pnpm', 'run', 'test:e2e:cli'], inputDirectory: root, env: {} }),
      /Incomplete Dev Hub JWT configuration/
    );
    let spawned = false;
    const code = await childMain({
      argv: ['node', '-e', 'process.exit(0)'],
      inputDirectory: root,
      env: {
        CI: 'false',
        SF_DEVHUB_PRIVATE_KEY: 'unused-sensitive-value',
        SF_DEVHUB_ALIAS: 'CachedAlias',
        SF_TEMP_SHOW_SECRETS: 'true'
      },
      spawnImpl: (_command, _args, options) => {
        spawned = true;
        assert.equal(options.env.SF_DEVHUB_PRIVATE_KEY, undefined);
        assert.equal(options.env.SF_DEVHUB_ALIAS, undefined);
        assert.equal(options.env.SF_TEMP_SHOW_SECRETS, undefined);
        assert.equal(options.env.CI, 'true');
        const child = new EventEmitter();
        process.nextTick(() => child.emit('close', 0));
        return child;
      }
    });
    assert.equal(code, 0);
    assert.equal(spawned, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JWT preflight and child retain separate Dev Hub and scratch clients with owned state until child exit', async () => {
  const { main: childMain } = require('./run-e2e-proxy-lab-child');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-lab-child-test-'));
  fs.writeFileSync(
    path.join(root, 'devhub.json'),
    JSON.stringify({
      SF_DEVHUB_CLIENT_ID: 'TestEca',
      SF_DEVHUB_USERNAME: 'test@example.invalid',
      SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com'
    })
  );
  fs.writeFileSync(path.join(root, 'private-key.pem'), privateKey);
  try {
    for (const exitCode of [0, 23]) {
      let ownedHome;
      let authenticated = false;
      const code = await childMain({
        argv: ['node', 'scripts/run-playwright-cli-e2e.js'],
        inputDirectory: root,
        stateDirectory: root,
        reportDirectory: root,
        env: {
          ...process.env,
          CI: 'false',
          SF_DEVHUB_ALIAS: 'HostAlias',
          SF_SCRATCH_SIGNUP_CONNECTED_APP: 'PlatformCLI',
          SF_SCRATCH_SIGNUP_CALLBACK_URL: 'http://localhost:1717/OauthRedirect',
          SF_TEMP_SHOW_SECRETS: 'true'
        },
        execFileAsync: async (_file, args, options) => {
          assert.deepEqual(args.slice(0, 3), ['org', 'login', 'jwt']);
          assert.equal(args[args.indexOf('--client-id') + 1], 'TestEca');
          assert.equal(options.env.SF_SCRATCH_SIGNUP_CONNECTED_APP, undefined);
          assert.equal(options.env.SF_TEMP_SHOW_SECRETS, undefined);
          authenticated = true;
          return { stdout: JSON.stringify({ status: 0, result: { username: 'test@example.invalid' } }) };
        },
        spawnImpl: (_file, _args, options) => {
          assert.equal(authenticated, true);
          const config = require('./devhub-auth').resolveDevHubConfig(options.env);
          assert.equal(config.mode, 'jwt');
          assert.equal(config.clientId, 'TestEca');
          assert.equal(Boolean(config.privateKey), true);
          assert.equal(options.env.SF_SCRATCH_SIGNUP_CONNECTED_APP, undefined);
          assert.equal(options.env.SF_TEMP_SHOW_SECRETS, undefined);
          ownedHome = process.platform === 'win32' ? options.env.USERPROFILE : options.env.HOME;
          assert.notEqual(ownedHome, process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME);
          assert.equal(fs.existsSync(ownedHome), true);
          fs.mkdirSync(path.join(ownedHome, '.sf'));
          fs.writeFileSync(path.join(ownedHome, '.sf', 'auth.json'), '{}');
          const child = new EventEmitter();
          process.nextTick(() => child.emit('close', exitCode));
          return child;
        }
      });
      assert.equal(code, exitCode);
      assert.equal(fs.existsSync(ownedHome), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lab configuration isolates auth from reusable caches and uses the validated Salesforce CLI pin', () => {
  const compose = yaml.parse(readComposeFile());
  const runner = compose.services.runner;
  assert.equal(
    runner.build.args.ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE,
    '${SALESFORCE_CLI_PACKAGE:-@salesforce/cli@2.150.6}'
  );
  assert.deepEqual(runner.networks, ['e2e_proxy_internal']);
  assert.equal(compose.networks.e2e_proxy_internal.internal, true);
  assert.equal(
    runner.volumes.some(value => /:\/root\/\.(?:sf|sfdx)$/.test(value)),
    false
  );
  assert.equal(runner.environment.SF_DEVHUB_AUTH_URL, undefined);
  for (const packagePath of [
    'apps/vscode-extension',
    'packages/core',
    'packages/protocol',
    'packages/sf-plugin',
    'packages/webview'
  ]) {
    assert.ok(
      runner.volumes.some(value => value.endsWith(`:/workspace/${packagePath}/node_modules`)),
      'Linux package links must not overwrite the host workspace'
    );
  }
  assert.equal(runner.environment.SF_DEVHUB_ALIAS, undefined);
  assert.equal(runner.environment.CI, 'true');
  assert.equal(runner.environment.SF_TEST_KEEP_ORG, '${SF_TEST_KEEP_ORG:-0}');
  for (const service of Object.values(compose.services)) {
    assert.equal(service.build.context, './test/e2e/proxy-lab');
  }
});

test('lab makes the approved upstream CA available read-only without adding it to image build inputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-lab-ca-test-'));
  const caFile = path.join(root, 'approved-ca.pem');
  fs.writeFileSync(caFile, require('node:tls').rootCertificates[0]);
  let overrideFile;
  try {
    const code = await main({
      argv: ['node', '-e', 'process.exit(0)'],
      env: { ALV_E2E_PROXY_LAB_UPSTREAM_CA_FILE: caFile },
      spawnImpl: (_file, args) => {
        const files = args.flatMap((value, index) => (value === '-f' ? [args[index + 1]] : []));
        assert.equal(files.length, 2);
        overrideFile = files[1];
        const config = yaml.parse(fs.readFileSync(overrideFile, 'utf8'));
        assert.deepEqual(config.services.proxy.volumes, [
          { type: 'bind', source: caFile, target: '/run/alv-upstream-ca.pem', read_only: true }
        ]);
        assert.equal(config.services.proxy.build, undefined);
        const child = new EventEmitter();
        process.nextTick(() => child.emit('close', 0));
        return child;
      }
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(overrideFile), false);
    assert.equal(fs.existsSync(caFile), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid JWT material fails at the lab boundary without spawning or exposing its value', async () => {
  let spawned = false;
  const secret = 'invalid-key-material-must-not-appear';
  await assert.rejects(
    () =>
      main({
        argv: [],
        env: {
          SF_DEVHUB_CLIENT_ID: 'TestEca',
          SF_DEVHUB_USERNAME: 'test@example.invalid',
          SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
          SF_DEVHUB_PRIVATE_KEY: secret
        },
        spawnImpl: () => {
          spawned = true;
          throw new Error('must not spawn');
        }
      }),
    error => /Invalid SF_DEVHUB_PRIVATE_KEY/.test(error.message) && !error.message.includes(secret)
  );
  assert.equal(spawned, false);
});

test('Compose startup failure still removes the operation credential mount', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  let directory;
  await assert.rejects(
    () =>
      main({
        env: {
          SF_DEVHUB_CLIENT_ID: 'TestEca',
          SF_DEVHUB_USERNAME: 'test@example.invalid',
          SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
          SF_DEVHUB_PRIVATE_KEY: privateKey
        },
        argv: [],
        execFileAsync: fakeEngine,
        spawnImpl: (_file, args) => {
          const overrideFile = args[args.lastIndexOf('-f') + 1];
          directory = yaml
            .parse(fs.readFileSync(overrideFile, 'utf8'))
            .services.runner.volumes.find(mount => mount.target === '/run/alv-devhub').source;
          const child = new EventEmitter();
          process.nextTick(() => child.emit('error', new Error('engine unavailable')));
          return child;
        }
      }),
    /Failed to start Docker compose/
  );
  assert.equal(fs.existsSync(path.dirname(directory)), false);
});

test('blocked credential removal reports the exact owned directory and does not retry it', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  let directory;
  let attempts = 0;
  try {
    await assert.rejects(
      () =>
        main({
          env: {
            SF_DEVHUB_CLIENT_ID: 'TestEca',
            SF_DEVHUB_USERNAME: 'test@example.invalid',
            SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
            SF_DEVHUB_PRIVATE_KEY: privateKey
          },
          argv: [],
          execFileAsync: fakeEngine,
          files: {
            ...fs,
            rmSync: (target, options) => {
              if (path.basename(target) !== 'input') return fs.rmSync(target, options);
              attempts += 1;
              directory = target;
              throw new Error('simulated EPERM');
            }
          },
          spawnImpl: (_file, args) => {
            reportCleanExit(args);
            const child = new EventEmitter();
            process.nextTick(() => child.emit('close', 0));
            return child;
          }
        }),
      error => error.message.endsWith(directory) && /credential cleanup failed/.test(error.message)
    );
    assert.equal(attempts, 1);
    assert.equal(fs.existsSync(path.join(directory, 'private-key.pem')), true);
  } finally {
    // Dispose of this generated test fixture after the simulated filesystem failure.
    if (directory) fs.rmSync(path.dirname(directory), { recursive: true, force: true });
  }
});

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function readComposeFile() {
  return read('docker-compose.e2e-proxy.yml');
}

function readProxyLabScript() {
  return read('test/e2e/proxy-lab/run.sh');
}

function readRunnerDockerfile() {
  return read('test/e2e/proxy-lab/Dockerfile.runner');
}

function readProxyDockerfile() {
  return read('test/e2e/proxy-lab/Dockerfile.proxy');
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

test('resolveComposeArgs runs the proxy lab runner with the compose file', () => {
  const repoRoot = path.join('/workspace', 'apex-log-viewer');
  assert.deepEqual(resolveComposeArgs([], { repoRoot }), [
    'compose',
    '-f',
    path.join(repoRoot, 'docker-compose.e2e-proxy.yml'),
    'run',
    '--rm',
    '--build',
    '-T',
    'runner'
  ]);
});

test('resolveComposeArgs forwards an explicit E2E command through the lab script', () => {
  const repoRoot = path.join('/workspace', 'apex-log-viewer');
  assert.deepEqual(resolveComposeArgs(['npm', 'run', 'test:e2e:cli'], { repoRoot }), [
    'compose',
    '-f',
    path.join(repoRoot, 'docker-compose.e2e-proxy.yml'),
    'run',
    '--rm',
    '--build',
    '-T',
    'runner',
    'bash',
    'test/e2e/proxy-lab/run.sh',
    'npm',
    'run',
    'test:e2e:cli'
  ]);
});

test('parseProxyLabArgs captures Salesforce CLI package override before the child command', () => {
  assert.deepEqual(parseProxyLabArgs(['--sf-cli-package', '@salesforce/cli@nightly', 'npm', 'run', 'test:e2e:cli']), {
    commandArgs: ['npm', 'run', 'test:e2e:cli'],
    sfCliPackage: '@salesforce/cli@nightly'
  });
});

test('parseProxyLabArgs supports equals syntax and command delimiter', () => {
  assert.deepEqual(parseProxyLabArgs(['--sf-cli-package=@salesforce/cli@nightly', '--', 'npm', 'run', 'test:e2e']), {
    commandArgs: ['npm', 'run', 'test:e2e'],
    sfCliPackage: '@salesforce/cli@nightly'
  });
});

test('parseProxyLabArgs requires a Salesforce CLI package value', () => {
  assert.throws(() => parseProxyLabArgs(['--sf-cli-package']), /--sf-cli-package requires a package specifier/);
});

test('Salesforce CLI package overrides are constrained to the official CLI package', () => {
  assert.equal(normalizeSalesforceCliPackage(' @salesforce/cli@2.150.6 '), '@salesforce/cli@2.150.6');
  assert.equal(normalizeSalesforceCliPackage('@salesforce/cli@nightly'), '@salesforce/cli@nightly');
  assert.throws(
    () => normalizeSalesforceCliPackage('evil-package@1.0.0'),
    /must be @salesforce\/cli pinned to an exact version/
  );
  assert.throws(
    () => normalizeSalesforceCliPackage('@salesforce/cli'),
    /must be @salesforce\/cli pinned to an exact version/
  );
});

test('ensureHostVolumeMountpoints creates Docker volume mountpoints before compose runs', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-proxy-lab-'));

  try {
    ensureHostVolumeMountpoints(repoRoot);

    for (const relativePath of ['node_modules', 'target', '.vscode-test']) {
      const fullPath = path.join(repoRoot, relativePath);
      assert.equal(fs.statSync(fullPath).isDirectory(), true, `expected ${relativePath} to be a directory`);
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('resolveProxyLabEnv forwards the host uid and gid for bind-mounted cleanup', () => {
  const env = resolveProxyLabEnv(
    { EXISTING_ENV: '1' },
    {
      getuid: () => 1001,
      getgid: () => 1002
    }
  );

  assert.equal(env.EXISTING_ENV, '1');
  assert.equal(env.ALV_E2E_PROXY_LAB_HOST_UID, '1001');
  assert.equal(env.ALV_E2E_PROXY_LAB_HOST_GID, '1002');
});

test('resolveProxyLabEnv forwards a Salesforce CLI package override', () => {
  const env = resolveProxyLabEnv({ EXISTING_ENV: '1' }, {}, { sfCliPackage: '@salesforce/cli@nightly' });

  assert.equal(env.EXISTING_ENV, '1');
  assert.equal(env.ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE, '@salesforce/cli@nightly');
});

test('proxy lab compose forwards host ownership ids into the runner', () => {
  const compose = readComposeFile();

  assert.match(compose, /^\s+ALV_E2E_PROXY_LAB_HOST_UID: \$\{ALV_E2E_PROXY_LAB_HOST_UID:-\}$/m);
  assert.match(compose, /^\s+ALV_E2E_PROXY_LAB_HOST_GID: \$\{ALV_E2E_PROXY_LAB_HOST_GID:-\}$/m);
});

test('proxy lab compose forwards the Salesforce CLI package override into the runner', () => {
  const compose = readComposeFile();

  assert.match(
    compose,
    /^\s+ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE: \$\{SALESFORCE_CLI_PACKAGE:-@salesforce\/cli@2\.150\.6\}$/m
  );
  assert.match(compose, /^\s+ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE: \$\{ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE:-\}$/m);
});

test('proxy lab compose forwards Playwright controls into the runner', () => {
  const compose = readComposeFile();

  assert.match(compose, /^\s+PLAYWRIGHT_WORKERS: \$\{PLAYWRIGHT_WORKERS:-1\}$/m);
  assert.match(compose, /^\s+PLAYWRIGHT_SHARD: \$\{PLAYWRIGHT_SHARD:-\}$/m);
  assert.match(compose, /^\s+PLAYWRIGHT_RETRIES: \$\{PLAYWRIGHT_RETRIES:-0\}$/m);
  assert.match(compose, /^\s+PLAYWRIGHT_TIMEOUT_MS: \$\{PLAYWRIGHT_TIMEOUT_MS:-\}$/m);
  assert.match(compose, /^\s+PLAYWRIGHT_EXPECT_TIMEOUT_MS: \$\{PLAYWRIGHT_EXPECT_TIMEOUT_MS:-\}$/m);
});

test('proxy lab compose persists noncredential runner caches', () => {
  const compose = readComposeFile();

  for (const [volume, mountPath] of [
    ['e2e_proxy_node_modules', '/workspace/node_modules'],
    ['e2e_proxy_vscode_test', '/workspace/.vscode-test'],
    ['e2e_proxy_npm_cache', '/root/.npm'],
    ['e2e_proxy_pnpm_store', '/root/.local/share/pnpm/store']
  ]) {
    assert.match(compose, new RegExp(`^\\s+- ${escapeRegExp(volume)}:${escapeRegExp(mountPath)}$`, 'm'));
    assert.match(compose, new RegExp(`^\\s{2}${escapeRegExp(volume)}: \\{\\}$`, 'm'));
  }
});

test('proxy lab runner restores ownership of bind-mounted generated outputs on exit', () => {
  const script = readProxyLabScript();

  assert.match(script, /restore_host_ownership\(\)/);
  assert.match(script, /trap restore_host_ownership EXIT/);
  assert.match(script, /ALV_E2E_PROXY_LAB_HOST_UID/);
  assert.match(script, /apps\/vscode-extension\/bin/);
  assert.match(script, /packages\/core\/lib/);
  assert.match(script, /packages\/protocol\/lib/);
  assert.match(script, /packages\/sf-plugin\/lib/);
  assert.doesNotMatch(script, /packages\/sf-plugin\/skills/);
  assert.match(script, /packages\/sf-plugin\/oclif\.manifest\.json/);
  assert.match(script, /output/);
  assert.doesNotMatch(script, /exec "\$@"/);
  assert.doesNotMatch(script, /exec bash -lc/);
  assert.doesNotMatch(script, /exec npm run test:e2e/);
});

test('proxy lab compose uses mitmproxy with a shared CA volume instead of Tinyproxy', () => {
  const compose = readComposeFile();
  const dockerfile = readProxyDockerfile();

  assert.equal(yaml.parse(compose).services.proxy.build.dockerfile, 'Dockerfile.proxy');
  assert.match(compose, /^\s+- e2e_proxy_mitmproxy_ca:\/mitmproxy$/m);
  assert.match(compose, /^\s+- e2e_proxy_mitmproxy_ca:\/mitmproxy:ro$/m);
  assert.match(compose, /mitmproxy-ca-cert\.cer/);
  assert.match(compose, /ALV_TEST_TELEMETRY_CONNECTION_STRING:/);
  assert.match(compose, /ALV_TEST_TELEMETRY_RUN_ID:/);
  assert.match(compose, /^\s+VSCODE_TEST_DOWNLOAD_TIMEOUT_MS: \$\{VSCODE_TEST_DOWNLOAD_TIMEOUT_MS:-\}$/m);
  assert.doesNotMatch(compose, /tinyproxy/i);
  assert.match(dockerfile, /COPY proxy.sh/);
  assert.match(read('test/e2e/proxy-lab/proxy.sh'), /--set stream_large_bodies=1m/);
});

test('proxy lab runner script validates MITM trust before running E2E commands', () => {
  const script = readProxyLabScript();

  assert.match(script, /wait_for_mitm_ca/);
  assert.match(script, /Verifying authenticated HTTPS fails before trusting the MITM CA/);
  assert.match(script, /update-ca-certificates/);
  assert.match(script, /NODE_EXTRA_CA_CERTS/);
  assert.match(script, /SSL_CERT_FILE/);
  assert.match(script, /Verifying internet egress works through the authenticated MITM proxy/);
  assert.match(script, /verify_node_https_proxy/);
  assert.match(script, /Node HTTPS through the configured MITM proxy/);
  assert.doesNotMatch(script, /Node fetch/);
});

test('proxy lab runner can install an explicit Salesforce CLI package before preflight', () => {
  const script = readProxyLabScript();

  assert.match(script, /install_salesforce_cli_override\(\)/);
  assert.match(script, /ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE/);
  assert.match(script, /validate_salesforce_cli_package/);
  assert.match(script, /npm install --global "\$\{package_name\}"/);
  assert.match(script, /sf --version/);
  assert.match(
    script,
    /verify_node_https_proxy\s*\ninstall_salesforce_cli_override\s*\nnode scripts\/run-e2e-proxy-lab-child\.js/,
    'expected the Salesforce CLI override install to run after proxy validation and before Salesforce preflight'
  );
});

test('proxy lab runner installs the pnpm workspace from the frozen lockfile', () => {
  const script = readProxyLabScript();
  const gitignore = read('.gitignore');

  assert.match(
    script,
    /PNPM_STORE_PATH="\$\{ALV_E2E_PROXY_LAB_PNPM_STORE_PATH:-\/root\/\.local\/share\/pnpm\/store\}"/
  );
  assert.match(script, /pnpm install --frozen-lockfile --store-dir "\$\{PNPM_STORE_PATH\}"/);
  assert.match(script, /ALV_E2E_PROXY_LAB_SKIP_PNPM_INSTALL/);
  assert.doesNotMatch(script, /\bnpm ci\b/);
  assert.match(gitignore, /^\.pnpm-store\/$/m);
});

test('proxy lab runner guards against proxy auth and Node dependency regressions', () => {
  const script = readProxyLabScript();
  const unauthenticatedProxyCheck = script.match(/verify_unauthenticated_proxy_blocked\(\) \{(?<body>[\s\S]*?)\n\}/)
    ?.groups.body;
  const connectParser = script.match(
    /function readProxyConnectResponse\(socket\) \{(?<body>[\s\S]*?)\n\}\n\nfunction connectTls/
  )?.groups.body;

  assert.ok(unauthenticatedProxyCheck);
  assert.match(unauthenticatedProxyCheck, /http:\/\/example\.com/);
  assert.match(unauthenticatedProxyCheck, /407/);
  assert.doesNotMatch(unauthenticatedProxyCheck, /https:\/\/example\.com/);
  assert.ok(connectParser);
  assert.match(connectParser, /let settled = false/);
  assert.match(connectParser, /function settle/);
  assert.match(connectParser, /function onEnd/);
  assert.match(connectParser, /function onClose/);
  assert.match(connectParser, /socket\.off\('end', onEnd\)/);
  assert.match(connectParser, /socket\.off\('close', onClose\)/);
  assert.match(connectParser, /socket\.once\('end', onEnd\)/);
  assert.match(connectParser, /socket\.once\('close', onClose\)/);
  assert.doesNotMatch(script, /require\(['"]undici['"]\)/);
  assert.match(script, /require\(['"]node:net['"]\)/);
  assert.match(script, /require\(['"]node:tls['"]\)/);
  assert.match(script, /require\(['"]node:buffer['"]\)/);
  assert.match(script, /require\(['"]node:url['"]\)/);
});

test('proxy lab runner image installs xauth for xvfb-run', () => {
  const dockerfile = readRunnerDockerfile();
  const aptInstallBlock = dockerfile.match(
    /apt-get install -y --no-install-recommends \\\r?\n(?<packages>[\s\S]*?)\r?\n\s*&& rm -rf \/var\/lib\/apt\/lists\/\*/
  )?.groups.packages;

  assert.ok(aptInstallBlock, 'expected runner Dockerfile to contain an apt package list');
  assert.match(aptInstallBlock, /^\s+xvfb\s+\\$/m);
  assert.match(aptInstallBlock, /^\s+xauth\s+\\$/m);
});

test('proxy lab Docker images are pinned by digest without a Rust toolchain stage', () => {
  const runnerDockerfile = readRunnerDockerfile();
  const proxyDockerfile = readProxyDockerfile();

  assert.match(runnerDockerfile, /^FROM node:24\.15\.0-bookworm@sha256:[0-9a-f]{64}$/m);
  assert.doesNotMatch(runnerDockerfile, /\brust\b/i);
  assert.doesNotMatch(runnerDockerfile, /\bcargo\b/i);
  assert.doesNotMatch(runnerDockerfile, /\brustup\b/i);
  assert.doesNotMatch(runnerDockerfile, /\blibssl-dev\b/);
  assert.doesNotMatch(runnerDockerfile, /\bpkg-config\b/);
  assert.match(proxyDockerfile, /^FROM debian:bookworm-slim@sha256:[0-9a-f]{64}$/m);
});

test('proxy lab runner image installs the configured Salesforce CLI package', () => {
  const runnerDockerfile = readRunnerDockerfile();

  assert.match(runnerDockerfile, /^ARG ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE=@salesforce\/cli@2\.150\.6$/m);
  assert.match(runnerDockerfile, /npm install -g "\$\{ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE\}" --no-audit --no-fund/);
  assert.match(runnerDockerfile, /^ARG ALV_PNPM_VERSION=11\.11\.0$/m);
  assert.match(runnerDockerfile, /npm install -g "pnpm@\$\{ALV_PNPM_VERSION\}" --no-audit --no-fund/);
});

test('proxy lab Dockerfiles bound apt network waits during image builds', () => {
  for (const [name, dockerfile] of [
    ['runner', readRunnerDockerfile()],
    ['proxy', readProxyDockerfile()]
  ]) {
    assert.match(
      dockerfile,
      /ALV_E2E_PROXY_LAB_APT_TIMEOUT_SECONDS=20/,
      `expected ${name} Dockerfile to define a short apt network timeout`
    );
    assert.match(
      dockerfile,
      /ALV_E2E_PROXY_LAB_APT_RETRIES=3/,
      `expected ${name} Dockerfile to define bounded apt retries`
    );
    assert.match(
      dockerfile,
      /Acquire::Retries \\"\$\{ALV_E2E_PROXY_LAB_APT_RETRIES\}\\";/,
      `expected ${name} Dockerfile apt-get calls to retry transient apt failures`
    );
    assert.match(
      dockerfile,
      /Acquire::http::Timeout \\"\$\{ALV_E2E_PROXY_LAB_APT_TIMEOUT_SECONDS\}\\";/,
      `expected ${name} Dockerfile apt-get calls to time out stalled HTTP mirrors`
    );
    assert.match(
      dockerfile,
      /Acquire::https::Timeout \\"\$\{ALV_E2E_PROXY_LAB_APT_TIMEOUT_SECONDS\}\\";/,
      `expected ${name} Dockerfile apt-get calls to time out stalled HTTPS mirrors`
    );
    assert.match(
      dockerfile,
      /\/etc\/apt\/apt\.conf\.d\/99alv-proxy-lab-timeouts/,
      `expected ${name} Dockerfile to apply the apt timeout config before apt-get`
    );
  }
});
