import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyRuntimeBinary } from '../apps/vscode-extension/scripts/copy-runtime-binary.mjs';

const CARGO_TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin'
};

export function resolveCargoBuildArgs(target, profile = 'release') {
  const args = ['build', '-p', 'apex-log-viewer-cli', '--bin', 'apex-log-viewer'];
  if (profile === 'release') {
    args.push('--release');
  }

  const cargoTarget = CARGO_TARGETS[target];
  if (cargoTarget) {
    args.push('--target', cargoTarget);
  }

  return args;
}

export function buildRuntimeTarget({
  repoRoot,
  target,
  profile = 'release',
  spawnSyncImpl = spawnSync,
  copyRuntimeBinaryImpl = copyRuntimeBinary
}) {
  const args = resolveCargoBuildArgs(target, profile);
  const result = spawnSyncImpl('cargo', args, {
    cwd: repoRoot,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

if (process.argv[1] === __filename) {
  const target = process.argv[2];
  const profile = process.argv[3] ?? 'release';
  if (!target) {
    throw new Error('usage: node scripts/build-runtime-target.mjs <target> [profile]');
  }
  buildRuntimeTarget({ repoRoot, target, profile });
}
