import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveBinaryName } from './package-cli-release.mjs';

function defaultSpawn(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options
  });
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function formatCommandError(command, args, result) {
  const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const prefix = `${formatCommand(command, args)} failed with exit code ${result.status ?? 'null'}`;
  return details ? `${prefix}\n${details}` : prefix;
}

function runCommand(command, args, { spawnSyncImpl = defaultSpawn } = {}) {
  const result = spawnSyncImpl(command, args);

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 0) !== 0) {
    throw new Error(formatCommandError(command, args, result));
  }

  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

export function extractRuntimeArchive({
  archivePath,
  destinationDir,
  target,
  spawnSyncImpl = defaultSpawn
}) {
  if (target !== 'linux-x64') {
    throw new Error(`verify-runtime-compatibility only supports archive extraction for linux-x64; received ${target}`);
  }

  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });

  runCommand('tar', ['-xzf', archivePath, '-C', destinationDir], { spawnSyncImpl });

  const binaryPath = path.join(destinationDir, resolveBinaryName(target));
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`runtime archive did not contain ${path.basename(binaryPath)} under ${destinationDir}`);
  }

  return binaryPath;
}

export function verifyLinuxX64Binary({
  binaryPath,
  spawnSyncImpl = defaultSpawn
}) {
  if (!binaryPath) {
    throw new Error('verifyLinuxX64Binary requires a binaryPath');
  }
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`runtime binary does not exist: ${binaryPath}`);
  }

  const programHeaders = runCommand('readelf', ['-lW', binaryPath], { spawnSyncImpl });
  if (/\bINTERP\b/.test(programHeaders)) {
    throw new Error(
      `linux-x64 runtime must not declare an ELF interpreter; expected a musl/static binary: ${binaryPath}`
    );
  }

  const dynamicSection = runCommand('readelf', ['-dW', binaryPath], { spawnSyncImpl });
  if (/\(NEEDED\)/.test(dynamicSection)) {
    throw new Error(
      `linux-x64 runtime must not depend on shared libraries at runtime; found ELF NEEDED entries in ${binaryPath}`
    );
  }

  const versionInfo = runCommand('readelf', ['--version-info', binaryPath], { spawnSyncImpl });
  if (/\bGLIBC_/.test(versionInfo)) {
    throw new Error(
      `linux-x64 runtime must not carry GLIBC version requirements; found GLIBC symbol versions in ${binaryPath}`
    );
  }

  return {
    binaryPath,
    checks: ['no-elf-interpreter', 'no-needed-libraries', 'no-glibc-version-needs']
  };
}

export function verifyRuntimeCompatibility({
  target,
  archivePath,
  binaryPath,
  spawnSyncImpl = defaultSpawn,
  mkdtempSyncImpl = fs.mkdtempSync,
  rmSyncImpl = fs.rmSync
}) {
  if (!target) {
    throw new Error('verifyRuntimeCompatibility requires a target');
  }
  if ((archivePath ? 1 : 0) + (binaryPath ? 1 : 0) !== 1) {
    throw new Error('verifyRuntimeCompatibility requires exactly one of archivePath or binaryPath');
  }
  if (target !== 'linux-x64') {
    throw new Error(`verifyRuntimeCompatibility currently supports only linux-x64; received ${target}`);
  }

  let extractedDir;
  let resolvedBinaryPath = binaryPath;

  try {
    if (archivePath) {
      extractedDir = mkdtempSyncImpl(path.join(os.tmpdir(), 'alv-runtime-compat-'));
      resolvedBinaryPath = extractRuntimeArchive({
        archivePath,
        destinationDir: extractedDir,
        target,
        spawnSyncImpl
      });
    }

    return verifyLinuxX64Binary({
      binaryPath: resolvedBinaryPath,
      spawnSyncImpl
    });
  } finally {
    if (extractedDir) {
      rmSyncImpl(extractedDir, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const options = {
    target: '',
    archivePath: '',
    binaryPath: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    switch (arg) {
      case '--target':
        if (!value) {
          throw new Error('missing value for --target');
        }
        options.target = value;
        index += 1;
        break;
      case '--archive':
        if (!value) {
          throw new Error('missing value for --archive');
        }
        options.archivePath = value;
        index += 1;
        break;
      case '--binary':
        if (!value) {
          throw new Error('missing value for --binary');
        }
        options.binaryPath = value;
        index += 1;
        break;
      default:
        throw new Error(
          'usage: node scripts/verify-runtime-compatibility.mjs --target <target> (--archive <archive-path> | --binary <binary-path>)'
        );
    }
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const { target, archivePath, binaryPath } = parseArgs(argv);
  const result = verifyRuntimeCompatibility({ target, archivePath, binaryPath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function isDirectExecution(argvEntry, moduleUrl = import.meta.url) {
  return Boolean(argvEntry) && path.resolve(argvEntry) === fileURLToPath(moduleUrl);
}

if (isDirectExecution(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
