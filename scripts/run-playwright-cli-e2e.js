#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const { existsSync, realpathSync } = require('fs');
const path = require('path');

function resolveCliBinaryRelativePath(targetPlatform = process.platform) {
  const bin = resolveCliBinaryName(targetPlatform);
  return path.posix.join('target', 'debug', bin);
}

function resolveCliBinaryName(targetPlatform = process.platform) {
  return targetPlatform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
}

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
    const pluginRunPath = path.join(repoRoot, 'packages', 'sf-plugin', 'bin', 'run.js').replace(/\\/g, '/');
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

function resolveSalesforceCliPath(repoRoot, options = {}) {
  const env = options.env || process.env;
  const explicitPath = String(env.ALV_SF_BIN_PATH || env.SF_CLI_BIN_PATH || '').trim();
  if (explicitPath) {
    return explicitPath;
  }

  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const command =
    process.platform === 'win32'
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
  return candidates.find(candidate => !isElectivusPluginSfCandidate(candidate, repoRoot));
}

function normalizeCargoTargetDirectory(repoRoot, cargoTargetDirectory) {
  if (!cargoTargetDirectory) {
    return undefined;
  }
  return path.isAbsolute(cargoTargetDirectory)
    ? cargoTargetDirectory
    : path.resolve(repoRoot, cargoTargetDirectory);
}

function resolveCargoTargetDirectory(repoRoot, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const result = spawnSyncImpl('cargo', ['metadata', '--format-version=1', '--no-deps'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  if (result.error || result.status !== 0) {
    return undefined;
  }

  try {
    const metadata = JSON.parse(result.stdout || '{}');
    return normalizeCargoTargetDirectory(repoRoot, metadata.target_directory);
  } catch {
    return undefined;
  }
}

function displayCandidatePath(repoRoot, candidatePath) {
  const relativePath = path.relative(repoRoot, candidatePath);
  const displayPath =
    relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath) ? relativePath : candidatePath;
  return displayPath.replace(/\\/g, '/');
}

function resolveCliBinaryCandidatePaths(repoRoot, options = {}) {
  const targetPlatform = options.targetPlatform || process.platform;
  const binaryName = resolveCliBinaryName(targetPlatform);
  const cargoTargetDirectory =
    options.cargoTargetDirectory === undefined
      ? resolveCargoTargetDirectory(repoRoot, options)
      : normalizeCargoTargetDirectory(repoRoot, options.cargoTargetDirectory);
  const candidates = [];

  if (cargoTargetDirectory) {
    candidates.push(path.join(cargoTargetDirectory, 'debug', binaryName));
  }

  candidates.push(path.join(repoRoot, resolveCliBinaryRelativePath(targetPlatform)));
  return [...new Set(candidates)];
}

function resolveBuiltCliBinaryPath(repoRoot, options = {}) {
  return resolveCliBinaryCandidatePaths(repoRoot, options).find(candidate => existsSync(candidate));
}

const requiredBuildArtifacts = [resolveCliBinaryRelativePath()];
const requiredSfPluginArtifacts = [resolveSfPluginCommandRelativePath()];

function resolveCliSuiteRelativePath() {
  return path.join('test', 'e2e', 'cli');
}

function resolveSfPluginRunRelativePath() {
  return path.join('packages', 'sf-plugin', 'bin', 'run.js');
}

function resolveSfPluginCommandRelativePath() {
  return path.join('packages', 'sf-plugin', 'lib', 'commands', 'electivus.js');
}

function resolveAcceptedCliBinaryRelativePaths(targetPlatform = process.platform) {
  return [resolveCliBinaryRelativePath(targetPlatform)];
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

function findMissingBuildArtifacts(repoRoot, options = {}) {
  if (resolveBuiltCliBinaryPath(repoRoot, options)) {
    return [];
  }

  return [
    resolveCliBinaryCandidatePaths(repoRoot, options)
      .map(candidate => displayCandidatePath(repoRoot, candidate))
      .join(' or ')
  ];
}

function spawnAsync(command, args, options = {}, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, options);
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function ensureBuildArtifacts(repoRoot, options = {}) {
  const existingCliBinaryPath = resolveBuiltCliBinaryPath(repoRoot, options);
  if (existingCliBinaryPath) {
    return existingCliBinaryPath;
  }

  const missingArtifacts = findMissingBuildArtifacts(repoRoot, options);
  console.log(
    `[e2e:cli] Missing build artifacts (${missingArtifacts.join(', ')}). Running npm run build:runtime before Playwright...`
  );
  const buildInvocation = resolveBuildInvocation();
  const buildEnv = { ...process.env };
  delete buildEnv.CARGO_BUILD_TARGET;
  const result = await spawnAsync(
    buildInvocation.command,
    buildInvocation.args,
    { cwd: repoRoot, env: buildEnv, stdio: 'inherit' },
    options.spawnImpl
  );

  if (result.code !== 0) {
    const details =
      typeof result.code === 'number' ? `exit code ${result.code}` : `signal ${result.signal || 'unknown'}`;
    throw new Error(`npm run build:runtime failed while preparing CLI Playwright E2E (${details}).`);
  }

  const builtCliBinaryPath = resolveBuiltCliBinaryPath(repoRoot, options);
  if (!builtCliBinaryPath) {
    const remainingMissingArtifacts = findMissingBuildArtifacts(repoRoot, options);
    throw new Error(
      `npm run build:runtime did not produce required CLI artifact(s): ${remainingMissingArtifacts.join(', ')}.`
    );
  }
  return builtCliBinaryPath;
}

function findMissingSfPluginBuildArtifacts(repoRoot) {
  return requiredSfPluginArtifacts.filter(relativePath => !existsSync(path.join(repoRoot, relativePath)));
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

function resolvePlaywrightEnv(cliBinaryPath, env = process.env, repoRoot = path.join(__dirname, '..')) {
  const sfCliPath = resolveSalesforceCliPath(repoRoot, { env });
  const resolvedEnv = {
    ...env,
    ALV_CLI_BINARY_PATH: cliBinaryPath,
    ALV_ELECTIVUS_PLUGIN_BIN_PATH: path.join(repoRoot, resolveSfPluginRunRelativePath())
  };
  if (sfCliPath) {
    resolvedEnv.ALV_SF_BIN_PATH = sfCliPath;
  }
  return resolvedEnv;
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const cliBinaryPath = await ensureBuildArtifacts(repoRoot);
  await ensureSfPluginBuildArtifacts(repoRoot);
  const invocation = resolvePlaywrightInvocation(process.argv.slice(2));
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: resolvePlaywrightEnv(cliBinaryPath)
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
  ensureSfPluginBuildArtifacts,
  findMissingBuildArtifacts,
  findMissingSfPluginBuildArtifacts,
  requiredBuildArtifacts,
  requiredSfPluginArtifacts,
  resolveBuiltCliBinaryPath,
  resolveBuildInvocation,
  resolveCargoTargetDirectory,
  resolveCliBinaryCandidatePaths,
  resolveCliBinaryRelativePath,
  resolveAcceptedCliBinaryRelativePaths,
  resolveCliSuiteRelativePath,
  resolveSfPluginBuildInvocation,
  resolveSfPluginCommandRelativePath,
  resolveSfPluginRunRelativePath,
  resolvePlaywrightEnv,
  resolvePlaywrightInvocation,
  resolveSalesforceCliPath
};
