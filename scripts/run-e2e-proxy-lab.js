#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOST_VOLUME_MOUNTPOINTS = ['node_modules', 'target', '.vscode-test'];

function resolveComposeArgs(commandArgs = [], options = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const composeFile = path.join(repoRoot, 'docker-compose.e2e-proxy.yml');
  const args = ['compose', '-f', composeFile, 'run', '--rm', '--build', 'runner'];

  if (commandArgs.length > 0) {
    args.push('bash', 'test/e2e/proxy-lab/run.sh', ...commandArgs);
  }

  return args;
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
      sfCliPackage = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--sf-cli-package=')) {
      const value = arg.slice('--sf-cli-package='.length);
      if (!value) {
        throw new Error('--sf-cli-package requires a package specifier, for example @salesforce/cli@nightly.');
      }
      sfCliPackage = value;
      continue;
    }
    commandArgs.push(arg);
  }

  return { commandArgs, sfCliPackage };
}

function exitWithChildResult(code, signal) {
  if (typeof code === 'number') {
    process.exit(code);
    return;
  }
  if (signal) {
    console.error(`[proxy-lab] Docker compose exited via signal: ${signal}`);
  } else {
    console.error('[proxy-lab] Docker compose exited with null exit code.');
  }
  process.exit(1);
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

function main() {
  const repoRoot = path.join(__dirname, '..');
  const docker = process.env.DOCKER || 'docker';
  let parsedArgs;
  try {
    parsedArgs = parseProxyLabArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[proxy-lab] ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
  ensureHostVolumeMountpoints(repoRoot);
  const child = spawn(docker, resolveComposeArgs(parsedArgs.commandArgs, { repoRoot }), {
    cwd: repoRoot,
    env: resolveProxyLabEnv(process.env, process, { sfCliPackage: parsedArgs.sfCliPackage }),
    stdio: 'inherit'
  });
  child.on('exit', exitWithChildResult);
  child.on('error', error => {
    console.error('[proxy-lab] Failed to start Docker compose:', error && error.message ? error.message : error);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  ensureHostVolumeMountpoints,
  parseProxyLabArgs,
  resolveProxyLabEnv,
  resolveComposeArgs
};
