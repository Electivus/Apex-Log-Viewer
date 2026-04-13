import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveAlvCliBinaryPath, resolveAlvCliInvocation, runAlvCli } from '../utils/cli';

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

async function writeFakeWindowsCommandShim(repoRoot: string, scriptBody: string): Promise<string> {
  const binaryDir = path.join(repoRoot, 'target', 'debug');
  const shimPath = path.join(binaryDir, 'apex-log-viewer.cmd');
  await mkdir(binaryDir, { recursive: true });
  await writeFile(shimPath, scriptBody, 'utf8');
  return shimPath;
}

async function writeFakeCrossTargetBinary(
  repoRoot: string,
  cargoBuildTarget: string,
  scriptBody: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const binaryDir = path.join(
    repoRoot,
    'target',
    cargoBuildTarget,
    'debug'
  );
  const binaryPath = path.join(
    binaryDir,
    platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer'
  );

  await mkdir(binaryDir, { recursive: true });
  await writeFile(binaryPath, scriptBody, 'utf8');
  if (platform !== 'win32') {
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
    if (process.platform === 'win32') {
      await writeFakeWindowsCommandShim(
        repoRoot,
        '@echo off\r\necho {\"stream\":\"stdout\",\"status\":\"success\"}\r\necho {\"stream\":\"stderr\",\"status\":\"warning\"} 1>&2\r\n'
      );
    } else {
      await writeFakeStandaloneBinary(
        repoRoot,
        '#!/bin/sh\nprintf \'{"stream":"stdout","status":"success"}\\n\'\nprintf \'{"stream":"stderr","status":"warning"}\\n\' >&2\n'
      );
    }

    const result = await runAlvCli([], { repoRoot, allowWindowsCommandShim: process.platform === 'win32' });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutJson).toEqual({ stream: 'stdout', status: 'success' });
    expect(result.stderrJson).toEqual({ stream: 'stderr', status: 'warning' });
  });
});

test('runAlvCli returns diagnostics on timeout instead of rejecting', async () => {
  await withTempRepo(async repoRoot => {
    if (process.platform === 'win32') {
      await writeFakeWindowsCommandShim(repoRoot, '@echo off\r\nping -n 6 127.0.0.1 >nul\r\n');
    } else {
      await writeFakeStandaloneBinary(repoRoot, '#!/bin/sh\nsleep 5\n');
    }

    const result = await runAlvCli(
      [],
      { repoRoot, timeoutMs: 50, allowWindowsCommandShim: process.platform === 'win32' }
    );

    expect(result.exitCode).toBe(-1);
    expect(result.errorMessage).toBeTruthy();
  });
});

test('resolveAlvCliBinaryPath stays strict when only a Windows command shim exists', async () => {
  await withTempRepo(async repoRoot => {
    await writeFakeWindowsCommandShim(repoRoot, '@echo off\r\nexit /b 0\r\n');

    expect(() => resolveAlvCliBinaryPath({ repoRoot, platform: 'win32' })).toThrow(
      /Unable to locate apex-log-viewer standalone binary/
    );
  });
});

test('resolveAlvCliInvocation can use a Windows command shim for helper-only coverage', async () => {
  await withTempRepo(async repoRoot => {
    const shimPath = await writeFakeWindowsCommandShim(repoRoot, '@echo off\r\nexit /b 0\r\n');
    const quotedShimPath = `"${shimPath.replace(/"/g, '""')}"`;

    expect(resolveAlvCliInvocation({ repoRoot, platform: 'win32', allowWindowsCommandShim: true })).toEqual({
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', quotedShimPath]
    });
  });
});

test('resolveAlvCliBinaryPath prefers the host debug binary when CARGO_BUILD_TARGET is set', async () => {
  await withTempRepo(async repoRoot => {
    const cargoBuildTarget = 'x86_64-unknown-linux-musl';
    const originalCargoBuildTarget = process.env.CARGO_BUILD_TARGET;
    process.env.CARGO_BUILD_TARGET = cargoBuildTarget;

    try {
      const hostBinaryPath = await writeFakeStandaloneBinary(repoRoot, '#!/bin/sh\nexit 0\n');
      const crossTargetBinaryPath = await writeFakeCrossTargetBinary(
        repoRoot,
        cargoBuildTarget,
        '#!/bin/sh\nexit 0\n'
      );

      expect(resolveAlvCliBinaryPath({ repoRoot })).toBe(hostBinaryPath);
      expect(resolveAlvCliInvocation({ repoRoot })).toEqual({
        command: hostBinaryPath,
        args: []
      });
      expect(hostBinaryPath).not.toBe(crossTargetBinaryPath);
    } finally {
      if (originalCargoBuildTarget === undefined) {
        delete process.env.CARGO_BUILD_TARGET;
      } else {
        process.env.CARGO_BUILD_TARGET = originalCargoBuildTarget;
      }
    }
  });
});

test('resolveAlvCliBinaryPath ignores cross-target debug binaries when the host binary is missing', async () => {
  await withTempRepo(async repoRoot => {
    const cargoBuildTarget = 'x86_64-unknown-linux-musl';
    const originalCargoBuildTarget = process.env.CARGO_BUILD_TARGET;
    process.env.CARGO_BUILD_TARGET = cargoBuildTarget;

    try {
      await writeFakeCrossTargetBinary(
        repoRoot,
        cargoBuildTarget,
        '#!/bin/sh\nexit 0\n'
      );

      expect(() => resolveAlvCliBinaryPath({ repoRoot })).toThrow(/Unable to locate apex-log-viewer standalone binary/);
      expect(() => resolveAlvCliInvocation({ repoRoot })).toThrow(/Unable to locate apex-log-viewer standalone binary/);
    } finally {
      if (originalCargoBuildTarget === undefined) {
        delete process.env.CARGO_BUILD_TARGET;
      } else {
        process.env.CARGO_BUILD_TARGET = originalCargoBuildTarget;
      }
    }
  });
});
