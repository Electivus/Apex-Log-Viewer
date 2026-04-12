import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveAlvCliBinaryPath } from '../utils/cli';

test('resolveAlvCliBinaryPath rejects extension runtime fallback when standalone binary is missing', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'alv-cli-helper-'));
  const binaryName = process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  const extensionRuntimeDir = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', `${process.platform}-${process.arch}`);

  await mkdir(extensionRuntimeDir, { recursive: true });
  await writeFile(path.join(extensionRuntimeDir, binaryName), 'not-a-real-binary', 'utf8');

  expect(() => resolveAlvCliBinaryPath({ repoRoot })).toThrow(/Unable to locate apex-log-viewer standalone binary/);
});
