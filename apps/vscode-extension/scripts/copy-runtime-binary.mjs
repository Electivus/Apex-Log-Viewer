import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CARGO_TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin'
};

export function resolveCurrentTarget(platformValue = process.platform, archValue = process.arch) {
  return `${platformValue}-${archValue}`;
}

export function resolveBinaryName(target) {
  return target.startsWith('win32-') ? 'apex-log-viewer.exe' : 'apex-log-viewer';
}

export function resolveArguments(argv) {
  let target = resolveCurrentTarget();
  let profile = 'debug';

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

export function resolveCargoTargetDirectory(repoRoot, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl('cargo', ['metadata', '--format-version=1', '--no-deps'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `Failed to resolve Cargo target directory: cargo metadata exited with status ${result.status}. ${result.stderr ?? ''}`.trim()
    );
  }

  const metadata = JSON.parse(result.stdout);
  if (!metadata.target_directory) {
    throw new Error('Failed to resolve Cargo target directory: cargo metadata did not return target_directory.');
  }

  return metadata.target_directory;
}

export function resolveSourceCandidates(repoRoot, target, profile, cargoTargetDir = path.join(repoRoot, 'target')) {
  const binaryName = resolveBinaryName(target);
  const candidates = [];
  const cargoTarget = CARGO_TARGETS[target];
  if (cargoTarget) {
    candidates.push(path.join(cargoTargetDir, cargoTarget, profile, binaryName));
  }
  candidates.push(path.join(cargoTargetDir, profile, binaryName));
  return candidates;
}

export function copyRuntimeBinary({
  repoRoot,
  target,
  profile,
  cargoTargetDir,
  spawnSyncImpl = spawnSync
}) {
  const binaryName = resolveBinaryName(target);
  const effectiveCargoTargetDir = cargoTargetDir ?? resolveCargoTargetDirectory(repoRoot, spawnSyncImpl);
  const sourceCandidates = resolveSourceCandidates(repoRoot, target, profile, effectiveCargoTargetDir);
  const source = sourceCandidates.find(candidate => fs.existsSync(candidate));
  const destinationDir = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', target);
  const destination = path.join(destinationDir, binaryName);

  if (!source) {
    throw new Error(
      `Runtime binary not found. Checked: ${sourceCandidates.join(', ')}. Build the Rust CLI before copying it.`
    );
  }

  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(source, destination);
  return { source, destination };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

if (process.argv[1] === __filename) {
  const { target, profile } = resolveArguments(process.argv.slice(2));
  copyRuntimeBinary({ repoRoot, target, profile });
}
