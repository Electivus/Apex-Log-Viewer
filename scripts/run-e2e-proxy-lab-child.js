#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { requestedCommandRequiresDevHub } = require('./run-e2e-proxy-lab');
const { resolveDevHubConfig, validateDevHubJwt, salesforceChildEnv } = require('./devhub-auth');

function readConfiguration(inputDirectory, commandArgs, commandEnv) {
  const env = salesforceChildEnv(commandEnv, { CI: 'true' });
  delete env.SF_DEVHUB_ALIAS;
  const manifest = path.join(inputDirectory, 'devhub.json');
  if (fs.existsSync(manifest)) {
    let values;
    try {
      values = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    } catch {
      throw new Error('Invalid proxy-lab Dev Hub credential manifest. Run scripts/run-e2e-proxy-lab.js again.');
    }
    for (const name of ['SF_DEVHUB_CLIENT_ID', 'SF_DEVHUB_USERNAME', 'SF_DEVHUB_LOGIN_URL']) {
      if (typeof values[name] === 'string') env[name] = values[name];
    }
  }
  const keyFile = path.join(inputDirectory, 'private-key.pem');
  if (fs.existsSync(keyFile)) env.SF_DEVHUB_PRIVATE_KEY_FILE = keyFile;
  // Mounted JWT presence is itself a direct-runner scratch opt-in. Derive the
  // decision from the transported inputs, never from stripped Compose values.
  const config = resolveDevHubConfig(env, { required: requestedCommandRequiresDevHub(commandArgs, env) });
  if (config) validateDevHubJwt(config);
  return config;
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  inputDirectory = '/run/alv-devhub',
  stateDirectory = '/run/alv-state',
  reportDirectory = '/run/alv-report',
  spawnImpl = spawn,
  execFileAsync
} = {}) {
  const validateOnly = argv[0] === '--validate';
  const commandArgs = validateOnly ? argv.slice(1) : argv;
  const config = readConfiguration(inputDirectory, commandArgs, env);
  if (validateOnly) return 0;

  const childEnv = salesforceChildEnv(env, { CI: 'true' });
  delete childEnv.SF_DEVHUB_ALIAS;
  let ownedDirectory;
  let interrupted = false;
  if (config) {
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    ownedDirectory = fs.mkdtempSync(path.join(stateDirectory, 'run-'));
    const home = path.join(ownedDirectory, 'home');
    const temporary = path.join(ownedDirectory, 'tmp');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(temporary, { mode: 0o700 });
    Object.assign(childEnv, {
      ...(process.platform === 'win32' ? { USERPROFILE: home } : { HOME: home }),
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      SF_DEVHUB_CLIENT_ID: config.clientId,
      SF_DEVHUB_USERNAME: config.username,
      SF_DEVHUB_LOGIN_URL: config.loginUrl,
      SF_DEVHUB_PRIVATE_KEY: fs.readFileSync(config.privateKeyFile, 'utf8')
    });
  }
  const command = commandArgs.length
    ? commandArgs
    : env.ALV_E2E_PROXY_LAB_COMMAND
      ? ['bash', '-lc', env.ALV_E2E_PROXY_LAB_COMMAND]
      : ['pnpm', 'run', 'test:e2e'];
  const originalEnv = { ...process.env };
  const applyEnvironment = values => {
    for (const name of Object.keys(process.env)) {
      if (!(name in values)) delete process.env[name];
    }
    Object.assign(process.env, values);
  };
  try {
    if (config) {
      // This executable owns the process environment. Shared auth's temporary
      // homes and renewal state must also live in the operation's mounted state.
      // Keep Node's native environment synchronized: os.tmpdir() on Linux
      // reads native environment values, not a replacement process.env object.
      applyEnvironment(childEnv);
      // Reuse the direct runner's CLI adapter and shared policy. The child
      // authenticates independently under that policy, never through this cache.
      const { ensureDevHub } = require('./run-tests');
      console.info('[proxy-lab] Verifying Dev Hub JWT through the authenticated MITM proxy...');
      const preflight = await ensureDevHub('sf', resolveDevHubConfig(childEnv), { execFileAsync });
      await preflight.cleanup();
      applyEnvironment(originalEnv);
    }
    console.info('[proxy-lab] Running requested child command.');
    return await new Promise((resolve, reject) => {
      const child = spawnImpl(command[0], command.slice(1), { env: childEnv, stdio: 'inherit' });
      child.once('close', code => {
        interrupted = typeof code !== 'number';
        resolve(interrupted ? 1 : code);
      });
      child.once('error', () => reject(new Error('Proxy-lab child command failed to start.')));
    });
  } finally {
    applyEnvironment(originalEnv);
    if (ownedDirectory) {
      // Direct runners retain a credential home when scratch recovery is
      // needed. Keep that state reachable from the host rather than allowing
      // --rm to destroy the only usable authorization after failed teardown.
      const retained = fs
        .readdirSync(path.join(ownedDirectory, 'tmp'))
        .filter(name => /^(alv-devhub-jwt-|alv-(?:pool-)?jwt-smoke-)/.test(name));
      if (interrupted || retained.length) {
        fs.writeFileSync(path.join(reportDirectory, 'recovery-required'), path.basename(ownedDirectory));
        throw new Error(
          'Proxy-lab child retained temporary state for recovery. See the host credential cleanup report.'
        );
      }
      try {
        fs.rmSync(ownedDirectory, { recursive: true, force: true });
      } catch {
        fs.writeFileSync(path.join(reportDirectory, 'recovery-required'), path.basename(ownedDirectory));
        throw new Error('Proxy-lab child state cleanup failed. See the host credential cleanup report.');
      }
      fs.writeFileSync(path.join(reportDirectory, 'complete'), 'clean');
    }
  }
}

if (require.main === module) {
  main()
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      console.error(`[proxy-lab] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { main };
