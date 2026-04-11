import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyRuntimeBinary } from '../apps/vscode-extension/scripts/copy-runtime-binary.mjs';

const CARGO_TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin'
};

export function resolveCargoTarget(target) {
  return CARGO_TARGETS[target];
}

export function resolveCargoBuildArgs(target, profile = 'release') {
  const args = ['build', '-p', 'apex-log-viewer-cli', '--bin', 'apex-log-viewer'];
  if (profile === 'release') {
    args.push('--release');
  }

  const cargoTarget = resolveCargoTarget(target);
  if (cargoTarget) {
    args.push('--target', cargoTarget);
  }

  return args;
}

export function resolveCargoBuildEnv(target, inheritedEnv = process.env) {
  const env = { ...inheritedEnv };

  if (target === 'linux-x64') {
    env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER =
      env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER || 'musl-gcc';
  }

  return env;
}

export function ensureBootstrapCargoTargetInstalled({
  repoRoot,
  target,
  spawnSyncImpl = spawnSync
}) {
  const cargoTarget = resolveCargoTarget(target);
  if (!cargoTarget || target !== 'linux-x64') {
    return;
  }

  const installedTargets = spawnSyncImpl('rustup', ['target', 'list', '--installed'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  if (installedTargets.error) {
    if (installedTargets.error.code === 'ENOENT') {
      return;
    }
    throw installedTargets.error;
  }
  if ((installedTargets.status ?? 0) !== 0) {
    throw new Error(
      `rustup target list --installed failed with exit code ${installedTargets.status ?? 'unknown'}`
    );
  }

  const installed = new Set(
    String(installedTargets.stdout ?? '')
      .split(/\r?\n/u)
      .map(value => value.trim())
      .filter(Boolean)
  );
  if (installed.has(cargoTarget)) {
    return;
  }

  const addTarget = spawnSyncImpl('rustup', ['target', 'add', cargoTarget], {
    cwd: repoRoot,
    stdio: 'inherit'
  });

  if (addTarget.error) {
    if (addTarget.error.code === 'ENOENT') {
      return;
    }
    throw addTarget.error;
  }
  if ((addTarget.status ?? 0) !== 0) {
    throw new Error(`rustup target add ${cargoTarget} failed with exit code ${addTarget.status ?? 'unknown'}`);
  }
}

export function buildRuntimeTarget({
  repoRoot,
  target,
  profile = 'release',
  spawnSyncImpl = spawnSync,
  copyRuntimeBinaryImpl = copyRuntimeBinary,
  ensureBootstrapCargoTargetInstalledImpl = ensureBootstrapCargoTargetInstalled
}) {
  ensureBootstrapCargoTargetInstalledImpl({ repoRoot, target, spawnSyncImpl });
  const args = resolveCargoBuildArgs(target, profile);
  const env = resolveCargoBuildEnv(target);
  const result = spawnSyncImpl('cargo', args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 0) !== 0) {
    throw new Error(`cargo ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }

  return copyRuntimeBinaryImpl({ repoRoot, target, profile });
}

export function resolveBuildArguments(argv, currentTarget) {
  let target = currentTarget;
  let profile = 'release';

  if (argv[0]) {
    if (argv[0] === 'debug' || argv[0] === 'release') {
      profile = argv[0];
    } else {
      target = argv[0];
    }
  }

  if (argv[1]) {
    profile = argv[1];
  }

  return { target, profile };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

if (process.argv[1] === __filename) {
  const currentTarget = `${process.platform}-${process.arch}`;
  const { target, profile } = resolveBuildArguments(process.argv.slice(2), currentTarget);
  buildRuntimeTarget({ repoRoot, target, profile });
}
