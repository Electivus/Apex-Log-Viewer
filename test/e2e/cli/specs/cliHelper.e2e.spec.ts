import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  resolveAlvCliBinaryPath,
  resolveAlvCliInvocation,
  resolveElectivusPluginInvocation,
  runAlvCli
} from '../utils/cli';

async function withTempRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'alv-cli-helper-'));
  try {
    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function withoutConfiguredCliBinaryEnv(): NodeJS.ProcessEnv {
  return { ALV_CLI_BINARY_PATH: '', ALV_ELECTIVUS_PLUGIN_BIN_PATH: '' };
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

async function writeFakeStandaloneBinaryAtPath(binaryPath: string, scriptBody: string): Promise<string> {
  await mkdir(path.dirname(binaryPath), { recursive: true });
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

async function writeFakePluginBin(repoRoot: string, scriptBody: string): Promise<string> {
  const pluginBinPath = path.join(repoRoot, 'packages', 'sf-plugin', 'bin', 'run.js');
  await mkdir(path.dirname(pluginBinPath), { recursive: true });
  await writeFile(pluginBinPath, scriptBody, 'utf8');
  return pluginBinPath;
}

async function writeFakeCrossTargetBinary(
  repoRoot: string,
  cargoBuildTarget: string,
  scriptBody: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const binaryDir = path.join(repoRoot, 'target', cargoBuildTarget, 'debug');
  const binaryPath = path.join(binaryDir, platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer');

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

    expect(() => resolveAlvCliBinaryPath({ repoRoot, env: withoutConfiguredCliBinaryEnv() })).toThrow(
      /Unable to locate apex-log-viewer standalone binary/
    );
  });
});

test('resolveAlvCliBinaryPath prefers ALV_CLI_BINARY_PATH when it exists', async () => {
  await withTempRepo(async repoRoot => {
    const binaryName = process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
    const configuredBinaryPath = await writeFakeStandaloneBinaryAtPath(
      path.join(repoRoot, '.cargo-target', 'Apex-Log-Viewer', 'debug', binaryName),
      '#!/bin/sh\nexit 0\n'
    );

    const env = { ALV_CLI_BINARY_PATH: configuredBinaryPath };

    expect(resolveAlvCliBinaryPath({ repoRoot, env })).toBe(configuredBinaryPath);
    expect(resolveAlvCliInvocation({ repoRoot, env })).toEqual({
      command: configuredBinaryPath,
      args: []
    });
  });
});

test('resolveAlvCliBinaryPath fails clearly when ALV_CLI_BINARY_PATH is missing', async () => {
  await withTempRepo(async repoRoot => {
    const binaryName = process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
    const missingBinaryPath = path.join(repoRoot, '.cargo-target', 'Apex-Log-Viewer', 'debug', binaryName);
    const fallbackBinaryPath = path.join(repoRoot, 'target', 'debug', binaryName);
    await writeFakeStandaloneBinary(repoRoot, '#!/bin/sh\nexit 0\n');

    for (const resolve of [
      () =>
        resolveAlvCliBinaryPath({
          repoRoot,
          env: { ALV_CLI_BINARY_PATH: missingBinaryPath }
        }),
      () =>
        resolveAlvCliInvocation({
          repoRoot,
          env: { ALV_CLI_BINARY_PATH: missingBinaryPath }
        })
    ]) {
      expect(resolve).toThrow(/ALV_CLI_BINARY_PATH/);
      expect(resolve).toThrow(missingBinaryPath);
      expect(resolve).toThrow(fallbackBinaryPath);
    }
  });
});

test('resolveElectivusPluginInvocation uses the local sf plugin bin', async () => {
  await withTempRepo(async repoRoot => {
    const pluginBinPath = await writeFakePluginBin(repoRoot, 'process.exit(0);\n');

    expect(resolveElectivusPluginInvocation({ repoRoot, env: withoutConfiguredCliBinaryEnv() })).toEqual({
      command: process.execPath,
      args: [pluginBinPath, 'electivus']
    });
  });
});

test('runAlvCli parses stdoutJson separately from stderrJson', async () => {
  await withTempRepo(async repoRoot => {
    await writeFakePluginBin(
      repoRoot,
      'process.stdout.write(\'{"stream":"stdout","status":"success"}\\n\');\nprocess.stderr.write(\'{"stream":"stderr","status":"warning"}\\n\');\n'
    );

    const result = await runAlvCli([], {
      repoRoot,
      env: withoutConfiguredCliBinaryEnv()
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutJson).toEqual({ stream: 'stdout', status: 'success' });
    expect(result.stderrJson).toEqual({ stream: 'stderr', status: 'warning' });
  });
});

test('runAlvCli resolves ALV_CLI_BINARY_PATH from process env when an env overlay is provided', async () => {
  await withTempRepo(async repoRoot => {
    const configuredBinaryPath =
      await writeFakeStandaloneBinaryAtPath(
        path.join(repoRoot, '.cargo-target', 'Apex-Log-Viewer', 'debug', 'apex-log-viewer'),
        '#!/bin/sh\nexit 0\n'
      );
    const pluginBinPath = await writeFakePluginBin(
      repoRoot,
      'process.stdout.write(JSON.stringify({source:"plugin", runtime:process.env.ALV_CLI_BINARY_PATH, args:process.argv.slice(2)}) + "\\n");\n'
    );
    await writeFakeStandaloneBinary(
      repoRoot,
      process.platform === 'win32'
        ? 'not-a-real-windows-executable'
        : '#!/bin/sh\nprintf \'{"source":"fallback"}\\n\'\n'
    );

    const originalConfiguredBinaryPath = process.env.ALV_CLI_BINARY_PATH;
    process.env.ALV_CLI_BINARY_PATH = configuredBinaryPath;

    try {
      const result = await runAlvCli([], {
        repoRoot,
        env: { ALV_TEST_MARKER: '1', ALV_ELECTIVUS_PLUGIN_BIN_PATH: '' }
      });

      expect(result.exitCode).toBe(0);
      expect(result.command).toBe(process.execPath);
      expect(result.args).toEqual([pluginBinPath, 'electivus']);
      expect(result.stdoutJson).toEqual({
        source: 'plugin',
        runtime: configuredBinaryPath,
        args: ['electivus']
      });
    } finally {
      if (originalConfiguredBinaryPath === undefined) {
        delete process.env.ALV_CLI_BINARY_PATH;
      } else {
        process.env.ALV_CLI_BINARY_PATH = originalConfiguredBinaryPath;
      }
    }
  });
});

test('runAlvCli returns diagnostics on timeout instead of rejecting', async () => {
  await withTempRepo(async repoRoot => {
    await writeFakePluginBin(repoRoot, 'setTimeout(() => {}, 5_000);\n');

    const result = await runAlvCli([], {
      repoRoot,
      timeoutMs: 50,
      env: withoutConfiguredCliBinaryEnv()
    });

    expect(result.exitCode).toBe(-1);
    expect(result.errorMessage).toBeTruthy();
  });
});

test('resolveAlvCliBinaryPath stays strict when only a Windows command shim exists', async () => {
  await withTempRepo(async repoRoot => {
    await writeFakeWindowsCommandShim(repoRoot, '@echo off\r\nexit /b 0\r\n');

    expect(() =>
      resolveAlvCliBinaryPath({ repoRoot, platform: 'win32', env: withoutConfiguredCliBinaryEnv() })
    ).toThrow(/Unable to locate apex-log-viewer standalone binary/);
  });
});

test('resolveAlvCliInvocation can use a Windows command shim for helper-only coverage', async () => {
  await withTempRepo(async repoRoot => {
    const shimPath = await writeFakeWindowsCommandShim(repoRoot, '@echo off\r\nexit /b 0\r\n');

    expect(
      resolveAlvCliInvocation({
        repoRoot,
        platform: 'win32',
        allowWindowsCommandShim: true,
        env: withoutConfiguredCliBinaryEnv()
      })
    ).toEqual({
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', 'call', `"${shimPath}"`],
      windowsVerbatimArguments: true
    });
  });
});

test('runAlvCli executes the local sf plugin bin from a metacharacter path', async () => {
  const parentDir = await mkdtemp(path.join(tmpdir(), 'alv-cli-helper-'));
  try {
    const repoRoot = path.join(parentDir, 'repo & plugin');
    await mkdir(repoRoot, { recursive: true });
    await writeFakePluginBin(
      repoRoot,
      'process.stdout.write(JSON.stringify({status:"quoted", args:process.argv.slice(2)}) + "\\n");\n'
    );

    const result = await runAlvCli(['--target-org', 'alias with spaces'], {
      repoRoot,
      env: withoutConfiguredCliBinaryEnv()
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutJson).toEqual({
      status: 'quoted',
      args: ['electivus', '--target-org', 'alias with spaces']
    });
  } finally {
    await rm(parentDir, { recursive: true, force: true });
  }
});

test('resolveAlvCliBinaryPath prefers the host debug binary when CARGO_BUILD_TARGET is set', async () => {
  await withTempRepo(async repoRoot => {
    const cargoBuildTarget = 'x86_64-unknown-linux-musl';
    const originalCargoBuildTarget = process.env.CARGO_BUILD_TARGET;
    process.env.CARGO_BUILD_TARGET = cargoBuildTarget;

    try {
      const hostBinaryPath = await writeFakeStandaloneBinary(repoRoot, '#!/bin/sh\nexit 0\n');
      const crossTargetBinaryPath = await writeFakeCrossTargetBinary(repoRoot, cargoBuildTarget, '#!/bin/sh\nexit 0\n');

      expect(resolveAlvCliBinaryPath({ repoRoot, env: withoutConfiguredCliBinaryEnv() })).toBe(hostBinaryPath);
      expect(resolveAlvCliInvocation({ repoRoot, env: withoutConfiguredCliBinaryEnv() })).toEqual({
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
      await writeFakeCrossTargetBinary(repoRoot, cargoBuildTarget, '#!/bin/sh\nexit 0\n');

      expect(() => resolveAlvCliBinaryPath({ repoRoot, env: withoutConfiguredCliBinaryEnv() })).toThrow(
        /Unable to locate apex-log-viewer standalone binary/
      );
      expect(() => resolveAlvCliInvocation({ repoRoot, env: withoutConfiguredCliBinaryEnv() })).toThrow(
        /Unable to locate apex-log-viewer standalone binary/
      );
    } finally {
      if (originalCargoBuildTarget === undefined) {
        delete process.env.CARGO_BUILD_TARGET;
      } else {
        process.env.CARGO_BUILD_TARGET = originalCargoBuildTarget;
      }
    }
  });
});
