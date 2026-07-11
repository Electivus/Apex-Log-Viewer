import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveElectivusPluginInvocation, runAlvCli } from '../utils/cli';

async function withTempRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'alv-cli-helper-'));
  try {
    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function withoutConfiguredPluginEnv(): NodeJS.ProcessEnv {
  return { ALV_ELECTIVUS_PLUGIN_BIN_PATH: '' };
}

async function writeFakePluginBin(repoRoot: string, scriptBody: string): Promise<string> {
  const pluginBinPath = path.join(repoRoot, 'packages', 'sf-plugin', 'bin', 'run.js');
  await mkdir(path.dirname(pluginBinPath), { recursive: true });
  await writeFile(pluginBinPath, scriptBody, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(pluginBinPath, 0o755);
  }
  return pluginBinPath;
}

test('resolveElectivusPluginInvocation uses the local sf plugin bin', async () => {
  await withTempRepo(async repoRoot => {
    const pluginBinPath = await writeFakePluginBin(repoRoot, 'process.exit(0);\n');

    expect(resolveElectivusPluginInvocation({ repoRoot, env: withoutConfiguredPluginEnv() })).toEqual({
      command: process.execPath,
      args: [pluginBinPath, 'electivus']
    });
  });
});

test('resolveElectivusPluginInvocation honors ALV_ELECTIVUS_PLUGIN_BIN_PATH', async () => {
  await withTempRepo(async repoRoot => {
    const pluginBinPath = path.join(repoRoot, 'custom', 'plugin-run.js');
    await mkdir(path.dirname(pluginBinPath), { recursive: true });
    await writeFile(pluginBinPath, 'process.exit(0);\n', 'utf8');

    expect(
      resolveElectivusPluginInvocation({
        repoRoot,
        env: { ALV_ELECTIVUS_PLUGIN_BIN_PATH: path.relative(repoRoot, pluginBinPath) }
      })
    ).toEqual({
      command: process.execPath,
      args: [pluginBinPath, 'electivus']
    });
  });
});

test('resolveElectivusPluginInvocation fails clearly when the plugin bin is missing', async () => {
  await withTempRepo(async repoRoot => {
    expect(() =>
      resolveElectivusPluginInvocation({ repoRoot, env: withoutConfiguredPluginEnv() })
    ).toThrow(/Unable to locate local sf electivus plugin bin/);
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
      env: withoutConfiguredPluginEnv()
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutJson).toEqual({ stream: 'stdout', status: 'success' });
    expect(result.stderrJson).toEqual({ stream: 'stderr', status: 'warning' });
  });
});

test('runAlvCli passes electivus and command args to the plugin bin', async () => {
  await withTempRepo(async repoRoot => {
    const pluginBinPath = await writeFakePluginBin(
      repoRoot,
      'process.stdout.write(JSON.stringify({source:"plugin", marker:process.env.ALV_TEST_MARKER, args:process.argv.slice(2)}) + "\\n");\n'
    );

    const result = await runAlvCli(['log', 'status', '--target-org', 'demo'], {
      repoRoot,
      env: { ALV_TEST_MARKER: '1', ALV_ELECTIVUS_PLUGIN_BIN_PATH: '' }
    });

    expect(result.exitCode).toBe(0);
    expect(result.command).toBe(process.execPath);
    expect(result.args).toEqual([pluginBinPath, 'electivus', 'logs', 'status', '--target-org', 'demo']);
    expect(result.stdoutJson).toEqual({
      source: 'plugin',
      marker: '1',
      args: ['electivus', 'logs', 'status', '--target-org', 'demo']
    });
  });
});

test('runAlvCli returns diagnostics on timeout instead of rejecting', async () => {
  await withTempRepo(async repoRoot => {
    await writeFakePluginBin(repoRoot, 'setTimeout(() => {}, 5_000);\n');

    const result = await runAlvCli([], {
      repoRoot,
      timeoutMs: 50,
      env: withoutConfiguredPluginEnv()
    });

    expect(result.exitCode).toBe(-1);
    expect(result.errorMessage).toBeTruthy();
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
      env: withoutConfiguredPluginEnv()
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
