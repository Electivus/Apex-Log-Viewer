import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APP_SERVER_UNSUPPORTED_MESSAGE,
  RuntimeExitError,
  executeRustBackedCommand,
  normalizeRuntimeArgs,
  parseRuntimeJson,
  resolvePackageForTarget,
  resolveRuntimeBinaryPath,
  type RuntimeExecutionResult,
  type RunRuntimeProcessOptions
} from '../src/runtime.ts';

function makeWriter() {
  const chunks: string[] = [];
  return {
    target: {
      write(chunk: string) {
        chunks.push(String(chunk));
      }
    },
    text() {
      return chunks.join('');
    }
  };
}

test('resolvePackageForTarget maps supported platform and arch pairs to native package names', () => {
  assert.equal(resolvePackageForTarget('linux', 'x64'), '@electivus/apex-log-viewer-linux-x64');
  assert.equal(resolvePackageForTarget('darwin', 'arm64'), '@electivus/apex-log-viewer-darwin-arm64');
  assert.throws(() => resolvePackageForTarget('freebsd', 'x64'), /unsupported platform\/arch target/i);
});

test('resolveRuntimeBinaryPath prefers ALV_CLI_BINARY_PATH and resolves relative paths from cwd', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electivus-runtime-'));
  const binaryPath = path.join(tempDir, 'target', 'debug', 'apex-log-viewer');

  try {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, 'binary');

    assert.equal(
      resolveRuntimeBinaryPath({
        cwd: tempDir,
        env: { ALV_CLI_BINARY_PATH: path.join('target', 'debug', 'apex-log-viewer') }
      }),
      binaryPath
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveRuntimeBinaryPath locates the optional native package binary', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electivus-native-'));
  const packageRoot = path.join(tempDir, 'node_modules', '@electivus', 'apex-log-viewer-linux-x64');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const binaryPath = path.join(packageRoot, 'bin', 'apex-log-viewer');

  try {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(packageJsonPath, '{}');
    fs.writeFileSync(binaryPath, 'binary');

    assert.equal(
      resolveRuntimeBinaryPath({
        platform: 'linux',
        arch: 'x64',
        env: {},
        requireResolve(id) {
          assert.equal(id, '@electivus/apex-log-viewer-linux-x64/package.json');
          return packageJsonPath;
        }
      }),
      binaryPath
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('normalizeRuntimeArgs forwards command args, strips sf-only flags, and appends Rust --json', () => {
  assert.deepEqual(
    normalizeRuntimeArgs(
      [
        'logs',
        'search',
        'NullPointerException',
        '--target-org',
        'my-org',
        '--flags-dir',
        '/tmp/sf-flags',
        '--json'
      ],
      { jsonEnabled: true }
    ),
    ['logs', 'search', 'NullPointerException', '--target-org', 'my-org', '--json']
  );
});

test('normalizeRuntimeArgs blocks app-server from the sf plugin surface', () => {
  assert.throws(
    () => normalizeRuntimeArgs(['app-server', '--stdio'], { jsonEnabled: false }),
    new RegExp(APP_SERVER_UNSUPPORTED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
});

test('parseRuntimeJson accepts clean JSON and JSON with warning preambles', () => {
  assert.deepEqual(parseRuntimeJson('{"status":"success"}'), { status: 'success' });
  assert.deepEqual(parseRuntimeJson('\u001b[33mwarning\u001b[0m\n{"status":"success"}'), {
    status: 'success'
  });
});

test('executeRustBackedCommand returns parsed Rust JSON for the Salesforce JSON envelope', async () => {
  const calls: Array<{ binaryPath: string; args: readonly string[] }> = [];
  const stdout = makeWriter();
  const stderr = makeWriter();

  const result = await executeRustBackedCommand({
    argv: ['logs', 'status', '--target-org', 'my-org', '--json'],
    jsonEnabled: true,
    env: {},
    stdout: stdout.target,
    stderr: stderr.target,
    resolveBinaryPath() {
      return '/runtime/apex-log-viewer';
    },
    async runRuntime(binaryPath: string, args: readonly string[]): Promise<RuntimeExecutionResult> {
      calls.push({ binaryPath, args });
      return {
        exitCode: 0,
        signal: null,
        stdout: '{"status":"success","synced":1}',
        stderr: ''
      };
    }
  });

  assert.deepEqual(result, { status: 'success', synced: 1 });
  assert.deepEqual(calls, [
    {
      binaryPath: '/runtime/apex-log-viewer',
      args: ['logs', 'status', '--target-org', 'my-org', '--json']
    }
  ]);
  assert.equal(stdout.text(), '');
  assert.equal(stderr.text(), '');
});

test('executeRustBackedCommand mirrors output and propagates nonzero Rust exit codes', async () => {
  const stdout = makeWriter();
  const stderr = makeWriter();

  await assert.rejects(
    executeRustBackedCommand({
      argv: ['doctor'],
      jsonEnabled: false,
      env: {},
      stdout: stdout.target,
      stderr: stderr.target,
      resolveBinaryPath() {
        return '/runtime/apex-log-viewer';
      },
      async runRuntime(
        _binaryPath: string,
        _args: readonly string[],
        _options: RunRuntimeProcessOptions
      ): Promise<RuntimeExecutionResult> {
        return {
          exitCode: 7,
          signal: null,
          stdout: 'partial output\n',
          stderr: 'runtime failed\n'
        };
      }
    }),
    error => error instanceof RuntimeExitError && error.exitCode === 7
  );

  assert.equal(stdout.text(), 'partial output\n');
  assert.equal(stderr.text(), 'runtime failed\n');
});
