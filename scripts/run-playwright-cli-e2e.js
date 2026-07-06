#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const { existsSync, realpathSync } = require('fs');
const path = require('path');

const requiredSfPluginArtifacts = [resolveSfPluginCommandRelativePath()];

function listSfPathCandidates(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function isElectivusPluginSfCandidate(candidatePath, repoRoot) {
  const normalized = String(candidatePath || '').replace(/\\/g, '/');
  try {
    const realPath = realpathSync.native(candidatePath).replace(/\\/g, '/');
    const pluginRunPath = path.join(repoRoot, resolveSfPluginRunRelativePath()).replace(/\\/g, '/');
    if (realPath === pluginRunPath) {
      return true;
    }
  } catch {
    // Ignore candidates that cannot be resolved yet.
  }

  if (/\/node_modules\/\.bin\/sf(?:\.cmd|\.ps1|\.exe)?$/i.test(normalized)) {
    const pluginPackageJson = path.resolve(
      path.dirname(candidatePath),
      '..',
      '@electivus',
      'plugin-electivus',
      'package.json'
    );
    return existsSync(pluginPackageJson);
  }

  return false;
}

function rankSalesforceCliCandidate(candidatePath, targetPlatform = process.platform) {
  if (targetPlatform !== 'win32') {
    return 0;
  }

  const basename = String(candidatePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase();
  if (basename === 'sf.cmd') {
    return 0;
  }
  if (basename === 'sf.exe') {
    return 1;
  }
  return 2;
}

function chooseSalesforceCliCandidate(candidates, repoRoot, targetPlatform = process.platform) {
  return candidates
    .filter(candidate => !isElectivusPluginSfCandidate(candidate, repoRoot))
    .sort(
      (left, right) =>
        rankSalesforceCliCandidate(left, targetPlatform) - rankSalesforceCliCandidate(right, targetPlatform)
    )[0];
}

function resolveSalesforceCliPath(repoRoot, options = {}) {
  const env = options.env || process.env;
  const targetPlatform = options.targetPlatform || process.platform;
  const explicitPath = String(env.ALV_SF_BIN_PATH || env.SF_CLI_BIN_PATH || '').trim();
  if (explicitPath) {
    return explicitPath;
  }

  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const command =
    targetPlatform === 'win32'
      ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'where sf'] }
      : { file: 'bash', args: ['-lc', 'type -ap sf'] };
  const result = spawnSyncImpl(command.file, command.args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8'
  });

  if (result.error || result.status !== 0) {
    return undefined;
  }

  const candidates = listSfPathCandidates(result.stdout);
  return chooseSalesforceCliCandidate(candidates, repoRoot, targetPlatform);
}

function resolveCliSuiteRelativePath() {
  return path.join('test', 'e2e', 'cli');
}

function resolveSfPluginRunRelativePath() {
  return path.join('packages', 'sf-plugin', 'bin', 'run.js');
}

function resolveSfPluginCommandRelativePath() {
  return path.join('packages', 'sf-plugin', 'lib', 'commands', 'electivus.js');
}

function resolveSfPluginBuildInvocation(targetPlatform = process.platform) {
  if (targetPlatform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'build:sf-plugin']
    };
  }

  return {
    command: 'npm',
    args: ['run', 'build:sf-plugin']
  };
}

function findMissingSfPluginBuildArtifacts(repoRoot) {
  return requiredSfPluginArtifacts.filter(relativePath => !existsSync(path.join(repoRoot, relativePath)));
}

function spawnAsync(command, args, options = {}, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, options);
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function ensureSfPluginBuildArtifacts(repoRoot, options = {}) {
  const missingArtifacts = findMissingSfPluginBuildArtifacts(repoRoot);
  if (missingArtifacts.length === 0) {
    return;
  }

  console.log(
    `[e2e:cli] Missing sf plugin build artifacts (${missingArtifacts.join(', ')}). Running npm run build:sf-plugin before Playwright...`
  );
  const buildInvocation = resolveSfPluginBuildInvocation();
  const result = await spawnAsync(
    buildInvocation.command,
    buildInvocation.args,
    { cwd: repoRoot, env: process.env, stdio: 'inherit' },
    options.spawnImpl
  );

  if (result.code !== 0) {
    const details =
      typeof result.code === 'number' ? `exit code ${result.code}` : `signal ${result.signal || 'unknown'}`;
    throw new Error(`npm run build:sf-plugin failed while preparing CLI Playwright E2E (${details}).`);
  }

  const remainingMissingArtifacts = findMissingSfPluginBuildArtifacts(repoRoot);
  if (remainingMissingArtifacts.length > 0) {
    throw new Error(
      `npm run build:sf-plugin did not produce required sf plugin artifact(s): ${remainingMissingArtifacts.join(', ')}.`
    );
  }
}

function resolvePlaywrightInvocation(extraArgs, options = {}) {
  const configArg = '--config=playwright.cli.config.ts';
  const cliPath = require.resolve('@playwright/test/cli');
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const cliSuiteRoot = path.join(repoRoot, resolveCliSuiteRelativePath());
  const maybePassWithNoTests = existsSync(cliSuiteRoot) ? [] : ['--pass-with-no-tests'];
  const configuredRetries = String((options.env || process.env).PLAYWRIGHT_RETRIES || '').trim();

  if (configuredRetries !== '' && !/^\d+$/.test(configuredRetries)) {
    throw new Error(`PLAYWRIGHT_RETRIES must be a non-negative integer, got '${configuredRetries}'.`);
  }

  const retryArgs = configuredRetries === '' ? [] : [`--retries=${configuredRetries}`];

  return {
    command: process.execPath,
    args: [cliPath, 'test', configArg, ...maybePassWithNoTests, ...retryArgs, ...extraArgs]
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

function resolvePlaywrightEnv(env = process.env, repoRoot = path.join(__dirname, '..')) {
  const sfCliPath = resolveSalesforceCliPath(repoRoot, { env });
  const resolvedEnv = {
    ...env,
    ALV_ELECTIVUS_PLUGIN_BIN_PATH: path.join(repoRoot, resolveSfPluginRunRelativePath())
  };
  if (sfCliPath) {
    resolvedEnv.ALV_SF_BIN_PATH = sfCliPath;
  }
  return resolvedEnv;
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  await ensureSfPluginBuildArtifacts(repoRoot);
  const invocation = resolvePlaywrightInvocation(process.argv.slice(2));
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: resolvePlaywrightEnv(process.env, repoRoot)
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
  ensureSfPluginBuildArtifacts,
  findMissingSfPluginBuildArtifacts,
  requiredSfPluginArtifacts,
  resolveCliSuiteRelativePath,
  resolveSfPluginBuildInvocation,
  resolveSfPluginCommandRelativePath,
  resolveSfPluginRunRelativePath,
  resolvePlaywrightEnv,
  resolvePlaywrightInvocation,
  resolveSalesforceCliPath
};
