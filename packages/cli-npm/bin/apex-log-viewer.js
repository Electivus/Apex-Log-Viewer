#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const PACKAGE_BY_TARGET = {
  'linux-x64': '@electivus/apex-log-viewer-linux-x64',
  'linux-arm64': '@electivus/apex-log-viewer-linux-arm64',
  'darwin-x64': '@electivus/apex-log-viewer-darwin-x64',
  'darwin-arm64': '@electivus/apex-log-viewer-darwin-arm64',
  'win32-x64': '@electivus/apex-log-viewer-win32-x64',
  'win32-arm64': '@electivus/apex-log-viewer-win32-arm64'
};

export function resolvePackageForTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const packageName = PACKAGE_BY_TARGET[target];
  if (!packageName) {
    throw new Error(`Unsupported platform/arch target: ${target}`);
  }
  return packageName;
}

export function resolveBinaryPath(platform = process.platform, arch = process.arch) {
  const packageName = resolvePackageForTarget(platform, arch);
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const binaryName = platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  return path.join(path.dirname(packageJsonPath), 'bin', binaryName);
}

export function main(argv = process.argv.slice(2)) {
  const binaryPath = resolveBinaryPath();
  const result = spawnSync(binaryPath, argv, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 0);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  main();
}
