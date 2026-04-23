#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

function resolveComposeArgs(commandArgs = [], options = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const composeFile = path.join(repoRoot, 'docker-compose.e2e-proxy.yml');
  const args = ['compose', '-f', composeFile, 'run', '--rm', '--build', 'runner'];

  if (commandArgs.length > 0) {
    args.push('bash', 'test/e2e/proxy-lab/run.sh', ...commandArgs);
  }

  return args;
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

function main() {
  const repoRoot = path.join(__dirname, '..');
  const docker = process.env.DOCKER || 'docker';
  const child = spawn(docker, resolveComposeArgs(process.argv.slice(2), { repoRoot }), {
    cwd: repoRoot,
    env: process.env,
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
  resolveComposeArgs
};
