#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

function resolveCliBinaryRelativePath(targetPlatform = process.platform) {
  const bin = targetPlatform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  return path.posix.join('target', 'debug', bin);
}

const requiredBuildArtifacts = [resolveCliBinaryRelativePath()];

function resolveAcceptedCliBinaryRelativePaths(targetPlatform = process.platform, env = process.env) {
  const paths = [resolveCliBinaryRelativePath(targetPlatform)];
  const cargoBuildTarget = String(env.CARGO_BUILD_TARGET || '').trim();
  if (cargoBuildTarget) {
    const bin = targetPlatform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
    paths.push(path.posix.join('target', cargoBuildTarget, 'debug', bin));
  }

  return [...new Set(paths)];
}

function resolveBuildInvocation(targetPlatform = process.platform) {
  if (targetPlatform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'build:runtime']
    };
  }

  return {
    command: 'npm',
    args: ['run', 'build:runtime']
  };
}

function findMissingBuildArtifacts(repoRoot) {
  const acceptedCliPaths = resolveAcceptedCliBinaryRelativePaths();
  return acceptedCliPaths.some(relativePath => existsSync(path.join(repoRoot, relativePath)))
    ? []
    : [acceptedCliPaths.join(' or ')];
}

function spawnAsync(command, args, options = {}, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, options);
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function ensureBuildArtifacts(repoRoot, options = {}) {
  const missingArtifacts = findMissingBuildArtifacts(repoRoot);
  if (!missingArtifacts.length) {
    return;
  }

  console.log(
    `[e2e:cli] Missing build artifacts (${missingArtifacts.join(', ')}). Running npm run build:runtime before Playwright...`
  );
  const buildInvocation = resolveBuildInvocation();
  const result = await spawnAsync(
    buildInvocation.command,
    buildInvocation.args,
    { cwd: repoRoot, env: process.env, stdio: 'inherit' },
    options.spawnImpl
  );

  if (result.code !== 0) {
    const details =
      typeof result.code === 'number' ? `exit code ${result.code}` : `signal ${result.signal || 'unknown'}`;
    throw new Error(`npm run build:runtime failed while preparing CLI Playwright E2E (${details}).`);
  }

  const remainingMissingArtifacts = findMissingBuildArtifacts(repoRoot);
  if (remainingMissingArtifacts.length) {
    throw new Error(
      `npm run build:runtime did not produce required CLI artifact(s): ${remainingMissingArtifacts.join(', ')}.`
    );
  }
}

function resolvePlaywrightInvocation(extraArgs) {
  const configArg = '--config=playwright.cli.config.ts';
  const cliPath = require.resolve('@playwright/test/cli');

  return {
    command: process.execPath,
    args: [cliPath, 'test', configArg, '--pass-with-no-tests', ...extraArgs]
  };
}

function exitWithChildResult(code, signal) {
  if (typeof code === 'number') {
    process.exit(code);
    return;
  }

  if (signal) {
    console.error(`[e2e:cli] Child process exited via signal: ${signal}`);
  } else {
    console.error('[e2e:cli] Child process exited with null exit code.');
  }
  process.exit(1);
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  await ensureBuildArtifacts(repoRoot);
  const invocation = resolvePlaywrightInvocation(process.argv.slice(2));
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: process.env
  });
  child.on('exit', exitWithChildResult);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[e2e:cli] Failed to run Playwright CLI E2E tests:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  ensureBuildArtifacts,
  findMissingBuildArtifacts,
  requiredBuildArtifacts,
  resolveBuildInvocation,
  resolveCliBinaryRelativePath,
  resolveAcceptedCliBinaryRelativePaths,
  resolvePlaywrightInvocation
};
