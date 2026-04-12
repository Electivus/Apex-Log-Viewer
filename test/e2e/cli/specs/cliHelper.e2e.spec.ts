import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveAlvCliBinaryPath, runAlvCli } from '../utils/cli';

async function withTempRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'alv-cli-helper-'));
  try {
    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeFakeStandaloneBinary(repoRoot: string, scriptBody: string): Promise<string> {
  const binaryName = process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  const binaryDir = path.join(repoRoot, 'target', 'debug');
  const binaryPath = path.join(binaryDir, binaryName);

  await mkdir(binaryDir, { recursive: true });
  await writeFile(binaryPath, scriptBody, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(binaryPath, 0o755);
  }

  return binaryPath;
}

test('resolveAlvCliBinaryPath rejects extension runtime fallback when standalone binary is missing', async () => {
  await withTempRepo(async repoRoot => {
    const binaryName = process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
    const extensionRuntimeDir = path.join(
      repoRoot,
      'apps',
      'vscode-extension',
      'bin',
      `${process.platform}-${process.arch}`
    );

    await mkdir(extensionRuntimeDir, { recursive: true });
    await writeFile(path.join(extensionRuntimeDir, binaryName), 'not-a-real-binary', 'utf8');

    expect(() => resolveAlvCliBinaryPath({ repoRoot })).toThrow(/Unable to locate apex-log-viewer standalone binary/);
  });
});

test('runAlvCli parses stdoutJson separately from stderrJson', async () => {
  await withTempRepo(async repoRoot => {
    await writeFakeStandaloneBinary(
      repoRoot,
      process.platform === 'win32'
        ? '@echo off\r\necho {\"stream\":\"stdout\",\"status\":\"success\"}\r\necho {\"stream\":\"stderr\",\"status\":\"warning\"} 1>&2\r\n'
        : '#!/bin/sh\nprintf \'{"stream":"stdout","status":"success"}\\n\'\nprintf \'{"stream":"stderr","status":"warning"}\\n\' >&2\n'
    );

    const result = await runAlvCli([], { repoRoot } as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdoutJson).toEqual({ stream: 'stdout', status: 'success' });
    expect(result.stderrJson).toEqual({ stream: 'stderr', status: 'warning' });
  });
});

test('runAlvCli returns diagnostics on timeout instead of rejecting', async () => {
  await withTempRepo(async repoRoot => {
    await writeFakeStandaloneBinary(
      repoRoot,
      process.platform === 'win32'
        ? '@echo off\r\nping -n 6 127.0.0.1 >nul\r\n'
        : '#!/bin/sh\nsleep 5\n'
    );

    const result = await runAlvCli([], { repoRoot, timeoutMs: 50 } as any);

    expect(result.exitCode).toBe(-1);
    expect(result.errorMessage).toBeTruthy();
  });
});
