#!/usr/bin/env node
'use strict';

const { spawn, execFile } = require('child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('node:os');
const { resolveDevHubConfig, validateDevHubJwt, salesforceChildEnv } = require('./devhub-auth');

const HOST_VOLUME_MOUNTPOINTS = [
  'node_modules',
  'target',
  '.vscode-test',
  'apps/vscode-extension/node_modules',
  'packages/core/node_modules',
  'packages/protocol/node_modules',
  'packages/sf-plugin/node_modules',
  'packages/webview/node_modules'
];
const SALESFORCE_CLI_PACKAGE_PATTERN = /^@salesforce\/cli@(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|nightly)$/;

function normalizeSalesforceCliPackage(value) {
  const packageName = String(value || '').trim();
  if (!SALESFORCE_CLI_PACKAGE_PATTERN.test(packageName)) {
    throw new Error(
      '--sf-cli-package must be @salesforce/cli pinned to an exact version, for example @salesforce/cli@2.150.6.'
    );
  }
  return packageName;
}

function resolveComposeArgs(commandArgs = [], options = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const composeFile = path.join(repoRoot, 'docker-compose.e2e-proxy.yml');
  const args = ['compose', '-f', composeFile];
  if (options.overrideFile) args.push('-f', options.overrideFile);
  args.push('run', '--rm', '--build', '-T');
  args.push('runner');

  if (commandArgs.length > 0) {
    args.push('bash', 'test/e2e/proxy-lab/run.sh', ...commandArgs);
  }

  return args;
}

function requestedCommandRequiresDevHub(commandArgs = [], env = process.env) {
  const command = commandArgs.length ? commandArgs.join(' ') : String(env.ALV_E2E_PROXY_LAB_COMMAND || '');
  if (!command) return true;
  return (
    /(?:^|[\s/])(?:test:e2e(?::(?:cli|telemetry))?|scratch-pool:[\w-]+)(?=\s|$)/.test(command) ||
    /(?:^|[\s/\\])(?:run-playwright-(?:cli-)?e2e(?:-telemetry)?|scratch-pool-admin)\.js(?=\s|$)/.test(command) ||
    (env.SF_SETUP_SCRATCH === '1' &&
      /(?:run-tests(?:-cli)?\.js|test(?::(?:integration|all|unit))?)(?=\s|$)/.test(command))
  );
}

function parseProxyLabArgs(argv = []) {
  const commandArgs = [];
  let sfCliPackage;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      commandArgs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '--sf-cli-package') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--sf-cli-package requires a package specifier, for example @salesforce/cli@nightly.');
      }
      sfCliPackage = normalizeSalesforceCliPackage(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--sf-cli-package=')) {
      const value = arg.slice('--sf-cli-package='.length);
      if (!value) {
        throw new Error('--sf-cli-package requires a package specifier, for example @salesforce/cli@nightly.');
      }
      sfCliPackage = normalizeSalesforceCliPackage(value);
      continue;
    }
    commandArgs.push(arg);
  }

  return { commandArgs, sfCliPackage };
}

function ensureHostVolumeMountpoints(repoRoot, fsImpl = fs) {
  for (const relativePath of HOST_VOLUME_MOUNTPOINTS) {
    fsImpl.mkdirSync(path.join(repoRoot, relativePath), { recursive: true });
  }
}

function resolveProxyLabEnv(env = process.env, processImpl = process, options = {}) {
  const resolved = { ...env };
  if (options.sfCliPackage) {
    resolved.ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE = options.sfCliPackage;
  }
  if (!resolved.ALV_E2E_PROXY_LAB_HOST_UID && typeof processImpl.getuid === 'function') {
    resolved.ALV_E2E_PROXY_LAB_HOST_UID = String(processImpl.getuid());
  }
  if (!resolved.ALV_E2E_PROXY_LAB_HOST_GID && typeof processImpl.getgid === 'function') {
    resolved.ALV_E2E_PROXY_LAB_HOST_GID = String(processImpl.getgid());
  }
  return resolved;
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  spawnImpl = spawn,
  files = fs,
  execFileAsync = promisify(execFile)
} = {}) {
  const repoRoot = path.join(__dirname, '..');
  const docker = env.DOCKER || 'docker';
  const parsedArgs = parseProxyLabArgs(argv);
  const config = requestedCommandRequiresDevHub(parsedArgs.commandArgs, env)
    ? resolveDevHubConfig({ ...env, CI: 'true' })
    : undefined;
  let secretDirectory;
  let operationDirectory;
  let reportDirectory;
  let stateVolume;
  let composeAttempted = false;
  let configDirectory;
  let overrideFile;
  const services = {};
  const volumes = {};
  const composeEnv = resolveProxyLabEnv(salesforceChildEnv(env), process, { sfCliPackage: parsedArgs.sfCliPackage });
  delete composeEnv.SF_DEVHUB_ALIAS;
  try {
    const upstreamCa = env.ALV_E2E_PROXY_LAB_UPSTREAM_CA_FILE || env.SSL_CERT_FILE;
    if (upstreamCa) {
      const source = path.resolve(upstreamCa);
      try {
        files.accessSync(source, fs.constants.R_OK);
        if (!files.statSync(source).isFile()) throw new Error();
      } catch {
        throw new Error(
          'Proxy-lab upstream CA bundle is not a readable file. Check ALV_E2E_PROXY_LAB_UPSTREAM_CA_FILE or SSL_CERT_FILE.'
        );
      }
      services.proxy = { volumes: [{ type: 'bind', source, target: '/run/alv-upstream-ca.pem', read_only: true }] };
    }
    if (config) {
      validateDevHubJwt(config, files);
      // Copy caller-owned files outside the repository/build context. Compose
      // receives only the mount path, never credential values or the host alias.
      const key = config.privateKey || files.readFileSync(path.resolve(config.privateKeyFile), 'utf8');
      operationDirectory = files.mkdtempSync(path.join(tmpdir(), 'alv-proxy-lab-jwt-'));
      files.chmodSync(operationDirectory, 0o700);
      secretDirectory = path.join(operationDirectory, 'input');
      reportDirectory = path.join(operationDirectory, 'report');
      files.mkdirSync(secretDirectory, { mode: 0o700 });
      files.mkdirSync(reportDirectory, { mode: 0o700 });
      files.writeFileSync(path.join(secretDirectory, 'private-key.pem'), key, { mode: 0o600 });
      files.writeFileSync(
        path.join(secretDirectory, 'devhub.json'),
        JSON.stringify({
          SF_DEVHUB_CLIENT_ID: config.clientId,
          SF_DEVHUB_USERNAME: config.username,
          SF_DEVHUB_LOGIN_URL: config.loginUrl
        }),
        { mode: 0o600 }
      );
      // Windows bind mounts do not provide the strict Unix permissions required
      // by Salesforce secret files. Own a fresh native volume, never a cache.
      const volumeName = `alv-proxy-lab-jwt-${randomUUID()}`;
      try {
        await execFileAsync(docker, ['volume', 'create', volumeName], { env: composeEnv, timeout: 120000 });
      } catch {
        throw new Error('Failed to create the operation-scoped proxy-lab state volume.');
      }
      stateVolume = volumeName;
      files.writeFileSync(path.join(reportDirectory, 'operation.json'), JSON.stringify({ stateVolume }));
      console.info(`[proxy-lab] Operation recovery report: ${reportDirectory}`);
      volumes.alv_jwt_state = { external: true, name: stateVolume };
      services.runner = {
        volumes: [
          { type: 'bind', source: secretDirectory, target: '/run/alv-devhub', read_only: true },
          { type: 'volume', source: 'alv_jwt_state', target: '/run/alv-state' },
          { type: 'bind', source: reportDirectory, target: '/run/alv-report' }
        ]
      };
    }
    if (Object.keys(services).length) {
      configDirectory = files.mkdtempSync(path.join(tmpdir(), 'alv-proxy-lab-config-'));
      overrideFile = path.join(configDirectory, 'compose.json');
      files.writeFileSync(overrideFile, JSON.stringify({ services, volumes }));
    }
    ensureHostVolumeMountpoints(repoRoot, files);
    return await new Promise((resolve, reject) => {
      composeAttempted = true;
      const child = spawnImpl(docker, resolveComposeArgs(parsedArgs.commandArgs, { repoRoot, overrideFile }), {
        cwd: repoRoot,
        env: composeEnv,
        stdio: 'inherit'
      });
      const interrupt = () => child.kill('SIGINT');
      const terminate = () => child.kill('SIGTERM');
      const stopListening = () => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', terminate);
      child.once('close', code => {
        stopListening();
        resolve(typeof code === 'number' ? code : 1);
      });
      child.once('error', () => {
        stopListening();
        composeAttempted = false;
        reject(new Error('Failed to start Docker compose. Check DOCKER and the container engine.'));
      });
    });
  } finally {
    if (configDirectory) {
      try {
        files.rmSync(configDirectory, { recursive: true, force: true });
      } catch {
        console.error(`[proxy-lab] Configuration cleanup failed. Remove the owned directory: ${configDirectory}`);
      }
    }
    if (operationDirectory) {
      const cleanupErrors = [];
      try {
        files.rmSync(secretDirectory, { recursive: true, force: true });
      } catch {
        cleanupErrors.push(`Proxy-lab credential cleanup failed. Remove the owned directory: ${secretDirectory}`);
      }
      if (stateVolume) {
        if (composeAttempted && !files.existsSync(path.join(reportDirectory, 'complete'))) {
          cleanupErrors.push(
            `Proxy-lab credential state retained for scratch recovery or interrupted cleanup in volume ${stateVolume}. Inspect the owned report: ${reportDirectory}`
          );
        } else {
          try {
            await execFileAsync(docker, ['volume', 'rm', stateVolume], { env: composeEnv, timeout: 120000 });
          } catch {
            cleanupErrors.push(`Proxy-lab credential cleanup failed. Remove the owned volume: ${stateVolume}`);
          }
        }
      }
      if (!cleanupErrors.length) {
        try {
          files.rmSync(operationDirectory, { recursive: true, force: true });
        } catch {
          cleanupErrors.push(`Proxy-lab credential cleanup failed. Remove the owned directory: ${operationDirectory}`);
        }
      }
      if (cleanupErrors.length) throw new Error(cleanupErrors.join('\n'));
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

module.exports = {
  main,
  requestedCommandRequiresDevHub,
  ensureHostVolumeMountpoints,
  normalizeSalesforceCliPackage,
  parseProxyLabArgs,
  resolveProxyLabEnv,
  resolveComposeArgs
};
