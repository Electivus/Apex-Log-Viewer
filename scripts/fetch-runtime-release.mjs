import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  resolveBinaryName,
  resolveCurrentTarget
} from '../apps/vscode-extension/scripts/copy-runtime-binary.mjs';

const RUNTIME_BUNDLE_PATH = path.join('config', 'runtime-bundle.json');
const RELEASE_REPOSITORY = 'Electivus/Apex-Log-Viewer';

export function resolveRuntimeAssetName({ cliVersion, target }) {
  if (target.startsWith('win32-')) {
    return `apex-log-viewer-${cliVersion}-${target}.zip`;
  }

  return `apex-log-viewer-${cliVersion}-${target}.tar.gz`;
}

export function resolveRuntimeReleaseTag({ tag, cliVersion }) {
  return tag || `rust-v${cliVersion}`;
}

export function readRuntimeBundleConfig(repoRoot) {
  const bundlePath = path.join(repoRoot, RUNTIME_BUNDLE_PATH);
  return JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
}

export function resolveRuntimeReleaseUrl({ repository = RELEASE_REPOSITORY, releaseTag, assetName }) {
  return `https://github.com/${repository}/releases/download/${releaseTag}/${assetName}`;
}

export async function downloadReleaseAsset({
  url,
  destinationFile,
  fetchImpl = fetch
}) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to download runtime asset ${url}: HTTP ${response.status}`);
  }

  fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
  const body = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destinationFile, body);
  return destinationFile;
}

function assertSpawnSucceeded(result, description) {
  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 0) !== 0) {
    throw new Error(`${description} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

export function extractArchive({
  archivePath,
  destinationDir,
  target,
  spawnSyncImpl = spawnSync
}) {
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });

  if (target.startsWith('win32-')) {
    const result = spawnSyncImpl(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        archivePath,
        destinationDir
      ],
      { stdio: 'inherit' }
    );
    assertSpawnSucceeded(result, `extracting ${path.basename(archivePath)}`);
    return { destinationDir };
  }

  const result = spawnSyncImpl('tar', ['-xzf', archivePath, '-C', destinationDir], { stdio: 'inherit' });
  assertSpawnSucceeded(result, `extracting ${path.basename(archivePath)}`);
  return { destinationDir };
}

function findFileRecursive(rootDir, filename) {
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name === filename) {
        return entryPath;
      }
    }
  }

  return null;
}

export function ensureRuntimeBinaryInstalled({ destinationDir, target }) {
  const binaryName = resolveBinaryName(target);
  const desiredBinaryPath = path.join(destinationDir, binaryName);
  const extractedBinaryPath = findFileRecursive(destinationDir, binaryName);

  if (!extractedBinaryPath) {
    throw new Error(`runtime archive did not contain ${binaryName} under ${destinationDir}`);
  }

  if (extractedBinaryPath !== desiredBinaryPath) {
    fs.copyFileSync(extractedBinaryPath, desiredBinaryPath);
  }

  if (!target.startsWith('win32-')) {
    fs.chmodSync(desiredBinaryPath, 0o755);
  }

  return desiredBinaryPath;
}

export async function fetchRuntimeRelease({
  repoRoot,
  target,
  downloadReleaseAssetImpl = downloadReleaseAsset,
  extractArchiveImpl = extractArchive
}) {
  const runtimeBundle = readRuntimeBundleConfig(repoRoot);
  const releaseTag = resolveRuntimeReleaseTag(runtimeBundle);
  const assetName = resolveRuntimeAssetName({
    cliVersion: runtimeBundle.cliVersion,
    target
  });
  const url = resolveRuntimeReleaseUrl({ releaseTag, assetName });
  const archivePath = path.join(repoRoot, '.cache', 'runtime-release', assetName);
  const destinationDir = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', target);

  await downloadReleaseAssetImpl({
    url,
    destinationFile: archivePath,
    assetName,
    releaseTag
  });
  extractArchiveImpl({ archivePath, destinationDir, target });
  const binaryPath = ensureRuntimeBinaryInstalled({ destinationDir, target });

  return {
    archivePath,
    assetName,
    binaryPath,
    destinationDir,
    releaseTag,
    url
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

if (process.argv[1] === __filename) {
  const target = process.argv[2] ?? resolveCurrentTarget();
  await fetchRuntimeRelease({ repoRoot, target });
}
