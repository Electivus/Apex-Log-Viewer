import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SALESFORCE_CLI_PACKAGE_PATTERN = /^@salesforce\/cli@(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|nightly)$/;

const WRAPPER_ENV_UNSET_NAMES = [
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'VSCODE_AMD_ENTRYPOINT',
  'VSCODE_CODE_CACHE_PATH',
  'VSCODE_CWD',
  'VSCODE_ESM_ENTRYPOINT',
  'VSCODE_HANDLES_UNCAUGHT_ERRORS',
  'VSCODE_IPC_HOOK',
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_NLS_CONFIG',
  'VSCODE_PID'
];

function readArgValue(args, name) {
  const equalsPrefix = `${name}=`;
  const equalsValue = args.find(arg => String(arg).startsWith(equalsPrefix));
  if (equalsValue) {
    return equalsValue.slice(equalsPrefix.length);
  }

  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function normalizeSalesforceCliPackage(value) {
  const packageName = String(value || '').trim();
  if (!SALESFORCE_CLI_PACKAGE_PATTERN.test(packageName)) {
    throw new Error(
      'Salesforce CLI package must be @salesforce/cli pinned to an exact version or @salesforce/cli@nightly.'
    );
  }
  return packageName;
}

export function expectedSalesforceCliVersion(packageName) {
  const normalized = normalizeSalesforceCliPackage(packageName);
  const version = normalized.slice('@salesforce/cli@'.length);
  return version === 'nightly' ? undefined : version;
}

export function sanitizeCacheSegment(value) {
  const sanitized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'default';
}

export function resolveSalesforceCliCacheConfig({
  env = process.env,
  platform = process.platform,
  nodeVersion = process.versions.node,
  packageName = env.SALESFORCE_CLI_PACKAGE || '@salesforce/cli@2.136.8'
} = {}) {
  const normalizedPackageName = normalizeSalesforceCliPackage(packageName);
  const cacheRoot = path.resolve(
    env.SALESFORCE_CLI_CACHE_ROOT || env.RUNNER_TOOL_CACHE || path.join(os.tmpdir(), 'alv-salesforce-cli-cache')
  );
  const key = [
    'alv-sf-cli',
    sanitizeCacheSegment(env.SALESFORCE_CLI_CACHE_KEY_OS || platform),
    sanitizeCacheSegment(`node-${nodeVersion}`),
    sanitizeCacheSegment(normalizedPackageName)
  ].join('-');

  return {
    cacheDir: path.join(cacheRoot, key),
    cacheKey: key,
    packageName: normalizedPackageName
  };
}

export function resolveSalesforceCliBinPath(prefix, platform = process.platform) {
  if (platform === 'win32') {
    return path.join(prefix, 'sf.cmd');
  }
  return path.join(prefix, 'bin', 'sf');
}

export function resolveSalesforceCliEntryPoint(prefix, platform = process.platform) {
  if (platform === 'win32') {
    return path.join(prefix, 'node_modules', '@salesforce', 'cli', 'bin', 'run.js');
  }
  return path.join(prefix, 'lib', 'node_modules', '@salesforce', 'cli', 'bin', 'run.js');
}

function assertPathInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Expected ${child} to resolve inside ${parent}.`);
  }
}

function runCommand(command, args, options = {}, spawnSyncFn = spawnSync) {
  const result = spawnSyncFn(command, args, {
    stdio: options.stdio || 'inherit',
    env: options.env,
    cwd: options.cwd,
    encoding: options.encoding || 'utf8'
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function resolveWindowsNpmCliPath(nodePath, fsImpl = fs) {
  const npmCliPath = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fsImpl.existsSync(npmCliPath)) {
    throw new Error(`Unable to find the npm CLI distributed with Node at ${npmCliPath}.`);
  }
  return npmCliPath;
}

function npmInstallInvocation({
  prefix,
  packageName,
  platform = process.platform,
  nodePath = process.execPath,
  fsImpl = fs
}) {
  const args = ['install', '-g', '--prefix', prefix, packageName, '--no-audit', '--no-fund'];
  if (platform === 'win32') {
    return {
      command: nodePath,
      args: [resolveWindowsNpmCliPath(nodePath, fsImpl), ...args]
    };
  }
  return { command: 'npm', args };
}

function sfVersionInvocation(prefix, platform = process.platform) {
  const entryPoint = resolveSalesforceCliEntryPoint(prefix, platform);
  assertPathInside(prefix, entryPoint);
  return {
    command: process.execPath,
    args: [entryPoint, '--version']
  };
}

function readSfVersion(prefix, { platform = process.platform, execFileSyncFn = execFileSync } = {}) {
  const invocation = sfVersionInvocation(prefix, platform);
  return String(execFileSyncFn(invocation.command, invocation.args, { encoding: 'utf8' }) || '').trim();
}

export function isSalesforceCliVersionUsable(versionOutput, packageName) {
  const expectedVersion = expectedSalesforceCliVersion(packageName);
  if (!expectedVersion) {
    return false;
  }
  return String(versionOutput || '')
    .split(/\s+/)
    .some(token => token === `@salesforce/cli/${expectedVersion}`);
}

export function shouldInstallSalesforceCli({
  cacheDir,
  sfBinPath,
  packageName,
  platform = process.platform,
  execFileSyncFn = execFileSync
}) {
  if (!fs.existsSync(sfBinPath) || !fs.existsSync(resolveSalesforceCliEntryPoint(cacheDir, platform))) {
    return true;
  }

  const expectedVersion = expectedSalesforceCliVersion(packageName);
  if (!expectedVersion) {
    return true;
  }

  try {
    return !isSalesforceCliVersionUsable(readSfVersion(cacheDir, { platform, execFileSyncFn }), packageName);
  } catch {
    return true;
  }
}

function quoteForBash(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function writeMacOSNodeWrapper({ nodePath, sfBinPath, wrapperPath, fsImpl = fs }) {
  const nodeDir = path.dirname(nodePath);
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ...WRAPPER_ENV_UNSET_NAMES.map(name => `unset ${name} || true`),
    `export PATH=${quoteForBash(nodeDir)}:"\${PATH:-}"`,
    `exec ${quoteForBash(sfBinPath)} "$@"`,
    ''
  ];

  fsImpl.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fsImpl.writeFileSync(wrapperPath, lines.join('\n'), { mode: 0o755 });
  fsImpl.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function appendOutput(filePath, content, fsImpl = fs) {
  if (!filePath) {
    return;
  }
  fsImpl.appendFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function formatOutputValue(name, value) {
  return `${name}=${String(value).replace(/\r?\n/g, ' ')}`;
}

export function writeGitHubExports({ env = process.env, sfBinPath, pathEntry, nodePath, fsImpl = fs }) {
  const envLines = [formatOutputValue('SF_CLI_BIN_PATH', sfBinPath), formatOutputValue('ALV_SF_BIN_PATH', sfBinPath)];
  if (nodePath) {
    envLines.push(formatOutputValue('SF_CLI_NODE_PATH', nodePath));
  }

  appendOutput(env.GITHUB_ENV, envLines.join('\n'), fsImpl);
  appendOutput(env.GITHUB_PATH, pathEntry, fsImpl);
}

export function writeGitHubCacheOutputs({ env = process.env, cacheKey, cacheDir, fsImpl = fs }) {
  const output = [formatOutputValue('cache-key', cacheKey), formatOutputValue('cache-dir', cacheDir)].join('\n');
  appendOutput(env.GITHUB_OUTPUT, output, fsImpl);
  return output;
}

export function setupSalesforceCli({
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  spawnSyncFn = spawnSync,
  execFileSyncFn = execFileSync,
  fsImpl = fs,
  stdout = process.stdout
} = {}) {
  const config = resolveSalesforceCliCacheConfig({ env, platform, nodeVersion: process.versions.node });
  const sfBinPath = resolveSalesforceCliBinPath(config.cacheDir, platform);
  fsImpl.mkdirSync(config.cacheDir, { recursive: true });

  if (
    shouldInstallSalesforceCli({
      cacheDir: config.cacheDir,
      sfBinPath,
      packageName: config.packageName,
      platform,
      execFileSyncFn
    })
  ) {
    const invocation = npmInstallInvocation({
      prefix: config.cacheDir,
      packageName: config.packageName,
      platform,
      nodePath,
      fsImpl
    });
    stdout.write(`[sf-cli] Installing ${config.packageName} into ${config.cacheDir}\n`);
    runCommand(invocation.command, invocation.args, { env }, spawnSyncFn);
  } else {
    stdout.write(`[sf-cli] Reusing cached ${config.packageName} from ${config.cacheDir}\n`);
  }

  const versionOutput = readSfVersion(config.cacheDir, { platform, execFileSyncFn });
  if (!versionOutput.includes('@salesforce/cli/')) {
    throw new Error(`Unexpected Salesforce CLI version output: ${versionOutput}`);
  }

  let exportedSfBinPath = sfBinPath;
  let exportedNodePath;
  if (env.SALESFORCE_CLI_WRAP_NODE === '1') {
    const wrapperPath = path.join(
      env.RUNNER_TEMP || os.tmpdir(),
      'alv-sf-node20',
      platform === 'win32' ? 'sf.cmd' : 'sf'
    );
    exportedSfBinPath = writeMacOSNodeWrapper({
      nodePath,
      sfBinPath,
      wrapperPath,
      fsImpl
    });
    exportedNodePath = nodePath;
  }

  writeGitHubExports({
    env,
    sfBinPath: exportedSfBinPath,
    pathEntry: path.dirname(sfBinPath),
    nodePath: exportedNodePath,
    fsImpl
  });

  return {
    cacheDir: config.cacheDir,
    cacheKey: config.cacheKey,
    packageName: config.packageName,
    sfBinPath,
    exportedSfBinPath,
    versionOutput
  };
}

function main() {
  const args = process.argv.slice(2);
  const packageName =
    readArgValue(args, '--package') || process.env.SALESFORCE_CLI_PACKAGE || '@salesforce/cli@2.136.8';
  const env = { ...process.env, SALESFORCE_CLI_PACKAGE: packageName };
  const config = resolveSalesforceCliCacheConfig({ env });

  if (args.includes('--print-cache-key')) {
    const output = writeGitHubCacheOutputs({ env, cacheKey: config.cacheKey, cacheDir: config.cacheDir });
    process.stdout.write(`${output}\n`);
    return;
  }

  setupSalesforceCli({ env });
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  main();
}
