import assert from 'assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

type EventRecord = {
  name: string;
  properties?: Record<string, string>;
  measurements?: Record<string, number>;
};

type MockReadable = EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
type MockChild = EventEmitter & {
  kill: () => boolean;
  stderr: MockReadable;
  stdout: MockReadable;
};

function createMockChild(): MockChild {
  const stdout = new EventEmitter() as MockReadable;
  stdout.setEncoding = () => undefined;
  const stderr = new EventEmitter() as MockReadable;
  stderr.setEncoding = () => undefined;
  const child = new EventEmitter() as MockChild;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => true;
  return child;
}

async function withElectronVersion<T>(callback: () => Promise<T> | T): Promise<T> {
  const hadElectron = Object.prototype.hasOwnProperty.call(process.versions, 'electron');
  const originalElectron = process.versions.electron;
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: '42.0.0' });
  try {
    return await callback();
  } finally {
    if (hadElectron) {
      Object.defineProperty(process.versions, 'electron', { configurable: true, value: originalElectron });
    } else {
      delete (process.versions as Record<string, unknown>).electron;
    }
  }
}

function loadRuntimeClient(args: {
  existsSync?: (filePath: string) => boolean;
  events?: EventRecord[];
  spawn?: (command: string, args: readonly string[], options: Record<string, unknown>) => MockChild;
  traceEntries?: unknown[][];
  traceEnabled?: boolean;
}) {
  const stubs: Record<string, unknown> = {
    'node:fs': {
      existsSync: args.existsSync,
      '@noCallThru': false
    },
    '../shared/telemetry': {
      safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
        args.events?.push({ name, properties, measurements });
      },
      '@noCallThru': true
    },
    '../../../../src/utils/logger': {
      isTraceEnabled: () => args.traceEnabled === true,
      logTrace: (...parts: unknown[]) => args.traceEntries?.push(parts),
      '@noCallThru': true
    },
    '../../../../src/salesforce/path': {
      getLoginShellEnv: async () => undefined,
      '@noCallThru': true
    }
  };
  if (args.spawn) {
    stubs['node:child_process'] = {
      spawn: args.spawn,
      '@noCallThru': true
    };
  }
  return proxyquireStrict('../../runtime/runtimeClient', stubs) as typeof import('../../runtime/runtimeClient');
}

suite('sf plugin client', () => {
  test('spawns plugin command args and parses JSON results', async () => {
    const events: EventRecord[] = [];
    const calls: Array<{ args: readonly string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
    const { RuntimeClient } = loadRuntimeClient({ events });
    const client = new RuntimeClient({
      workspaceRoot: () => '/workspace',
      prepareProcessEnv: async () => ({ PATH: '/shell/bin' }),
      runner: async (args, options) => {
        calls.push({ args, options });
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify([{ Id: '07L000000000001AA', Status: 'Success' }]),
          stderr: ''
        };
      }
    });

    const logs = await client.logsList({ username: 'demo@example.com', limit: 3 });

    assert.deepEqual(logs, [{ Id: '07L000000000001AA', Status: 'Success' }]);
    assert.deepEqual(calls[0]?.args, ['logs', 'list', '--target-org', 'demo@example.com', '--limit', '3']);
    assert.equal(calls[0]?.options.cwd, '/workspace');
    assert.equal(calls[0]?.options.env?.PATH, '/shell/bin');
    assert.deepEqual(events[0]?.properties, { method: 'logs_list', outcome: 'ok' });
    assert.equal(events[0]?.name, 'sfPlugin.request');
    assert.equal(Number.isFinite(events[0]?.measurements?.durationMs), true);
  });

  test('maps logs status requests to plugin args', async () => {
    const calls: Array<{ args: readonly string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
    const { RuntimeClient } = loadRuntimeClient({});
    const client = new RuntimeClient({
      workspaceRoot: () => '/workspace',
      runner: async (args, options) => {
        calls.push({ args, options });
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            target_org: 'demo@example.com',
            safe_target_org: 'demo@example.com',
            workspace_root: '/workspace',
            apexlogs_root: '/workspace/apexlogs',
            state_file: '/workspace/apexlogs/.alv/sync-state.json',
            log_count: 0,
            has_state: false,
            downloaded_count: 0,
            cached_count: 0
          }),
          stderr: ''
        };
      }
    });

    const status = await client.logsStatus({ targetOrg: 'demo@example.com' });

    assert.equal(status.target_org, 'demo@example.com');
    assert.deepEqual(calls[0]?.args, [
      'logs',
      'status',
      '--target-org',
      'demo@example.com',
      '--workspace-root',
      '/workspace'
    ]);
  });

  test('does not synthesize a workspace root when none is available', async () => {
    const calls: Array<{ args: readonly string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
    const { RuntimeClient } = loadRuntimeClient({});
    const client = new RuntimeClient({
      runner: async (args, options) => {
        calls.push({ args, options });
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            target_org: 'default',
            safe_target_org: 'default',
            workspace_root: '/tmp',
            apexlogs_root: '/tmp/apexlogs',
            state_file: '/tmp/apexlogs/.alv/sync-state.json',
            log_count: 0,
            has_state: false,
            downloaded_count: 0,
            cached_count: 0
          }),
          stderr: ''
        };
      }
    });

    await client.logsStatus({});

    assert.deepEqual(calls[0]?.args, ['logs', 'status', '--workspace-root', os.tmpdir()]);
    assert.equal(calls[0]?.options.cwd, undefined);
  });

  test('passes log start times to triage commands', async () => {
    const calls: Array<{ args: readonly string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
    const { RuntimeClient } = loadRuntimeClient({});
    const client = new RuntimeClient({
      workspaceRoot: () => '/workspace',
      runner: async (args, options) => {
        calls.push({ args, options });
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify([]),
          stderr: ''
        };
      }
    });

    await client.logsTriage({
      username: 'demo@example.com',
      logIds: ['07L000000000001AAA'],
      logStartTimes: { '07L000000000001AAA': '2026-07-06T10:00:00.000+0000' }
    });

    assert.deepEqual(calls[0]?.args, [
      'logs',
      'triage',
      '07L000000000001AAA',
      '--target-org',
      'demo@example.com',
      '--workspace-root',
      '/workspace',
      '--log-start-times',
      '{"07L000000000001AAA":"2026-07-06T10:00:00.000+0000"}'
    ]);
  });

  test('dedupes concurrent org auth requests for the same username', async () => {
    const calls: string[][] = [];
    const { RuntimeClient } = loadRuntimeClient({});
    const client = new RuntimeClient({
      runner: async args => {
        calls.push([...args]);
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            username: 'demo@example.com',
            instanceUrl: 'https://example.my.salesforce.com',
            accessToken: 'token'
          }),
          stderr: ''
        };
      }
    });

    const first = client.getOrgAuth({ username: 'demo@example.com' });
    const second = client.getOrgAuth({ username: 'demo@example.com' });
    const [left, right] = await Promise.all([first, second]);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['orgs', 'auth', '--target-org', 'demo@example.com']);
    assert.deepEqual(left, right);
  });

  test('aborts before invoking the runner when the signal is already cancelled', async () => {
    const events: EventRecord[] = [];
    let called = false;
    const { RuntimeClient } = loadRuntimeClient({ events });
    const client = new RuntimeClient({
      runner: async () => {
        called = true;
        return { exitCode: 0, signal: null, stdout: '{}', stderr: '' };
      }
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(client.logsTriage({ logIds: ['07L000000000001AA'] }, controller.signal), error => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).name, 'AbortError');
      return true;
    });

    assert.equal(called, false);
    assert.deepEqual(events[0]?.properties, { method: 'logs_triage', outcome: 'cancelled' });
    assert.equal(events[0]?.name, 'sfPlugin.request');
  });

  test('uses JSON error messages returned by the plugin process', async () => {
    const events: EventRecord[] = [];
    const { RuntimeClient } = loadRuntimeClient({ events });
    const client = new RuntimeClient({
      runner: async () => ({
        exitCode: 1,
        signal: null,
        stdout: JSON.stringify({ status: 'error', message: 'permission denied' }),
        stderr: ''
      })
    });

    await assert.rejects(client.logsList({ username: 'demo@example.com' }), /permission denied/);
    assert.equal(events[0]?.properties?.method, 'logs_list');
    assert.equal(events[0]?.properties?.outcome, 'error');
    assert.equal(events[0]?.name, 'sfPlugin.request');
  });

  test('keeps trace logging free of auth response secrets', async () => {
    const traceEntries: unknown[][] = [];
    const { RuntimeClient } = loadRuntimeClient({ traceEnabled: true, traceEntries });
    const client = new RuntimeClient({
      runner: async () => ({
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          username: 'demo@example.com',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'secret-token'
        }),
        stderr: ''
      })
    });

    await client.getOrgAuth({ username: 'demo@example.com' });

    const serializedTrace = JSON.stringify(traceEntries);
    assert.match(serializedTrace, /sf-plugin: run/);
    assert.match(serializedTrace, /orgs auth/);
    assert.doesNotMatch(serializedTrace, /secret-token/);
  });

  test('fails clearly when the embedded runner has not been built', async () => {
    const { runEmbeddedSfPlugin } = loadRuntimeClient({ existsSync: () => false });

    await assert.rejects(runEmbeddedSfPlugin(['doctor']), /Unable to locate embedded sf electivus runner/);
  });

  test('resolves packaged runner from installed extension dist directory', async () => {
    const extensionRoot = path.join(os.tmpdir(), 'extensions', 'electivus.apex-log-viewer-0.49.12');
    const runtimeDir = path.join(extensionRoot, 'dist');
    const expectedRunner = path.join(extensionRoot, 'sf-plugin', 'electivus-runner.cjs');
    const { resolveEmbeddedRunnerFromRuntimeDir } = loadRuntimeClient({
      existsSync: filePath => filePath === expectedRunner
    });

    assert.equal(resolveEmbeddedRunnerFromRuntimeDir(runtimeDir), expectedRunner);
  });

  test('prefers the extension host runtime for embedded runner subprocesses under Electron', () => {
    const { resolveEmbeddedRunnerExecutable, resolveEmbeddedRunnerExecutables } = loadRuntimeClient({});
    const defaultNodeExecutable = process.platform === 'win32' ? 'node.exe' : 'node';

    assert.equal(
      resolveEmbeddedRunnerExecutable({}, { electron: '42.0.0' } as unknown as NodeJS.ProcessVersions),
      process.execPath
    );
    assert.deepEqual(
      resolveEmbeddedRunnerExecutables({}, { electron: '42.0.0' } as unknown as NodeJS.ProcessVersions),
      [process.execPath, defaultNodeExecutable]
    );
    assert.equal(
      resolveEmbeddedRunnerExecutable(
        { SF_CLI_NODE_PATH: '/opt/sf/node', ALV_NODE_BIN_PATH: '/opt/alv/node' },
        { electron: '42.0.0' } as unknown as NodeJS.ProcessVersions
      ),
      '/opt/alv/node'
    );
    assert.equal(
      resolveEmbeddedRunnerExecutable(
        { SF_CLI_NODE_PATH: '/opt/sf/node' },
        { electron: '42.0.0' } as unknown as NodeJS.ProcessVersions
      ),
      process.execPath
    );
    assert.equal(resolveEmbeddedRunnerExecutable({}, {} as NodeJS.ProcessVersions), process.execPath);
  });

  test('disables Salesforce log files and uses Electron-as-Node only as a fallback', () => {
    const { embeddedRunnerEnv } = loadRuntimeClient({});
    const realNodeEnv = embeddedRunnerEnv({ ELECTRON_RUN_AS_NODE: '1', SF_DISABLE_LOG_FILE: '' });
    const electronFallbackEnv = embeddedRunnerEnv({}, { useElectronNode: true });

    assert.deepEqual({
      ELECTRON_RUN_AS_NODE: realNodeEnv.ELECTRON_RUN_AS_NODE,
      SF_DISABLE_LOG_FILE: realNodeEnv.SF_DISABLE_LOG_FILE,
      SFDX_DISABLE_LOG_FILE: realNodeEnv.SFDX_DISABLE_LOG_FILE
    }, {
      ELECTRON_RUN_AS_NODE: undefined,
      SF_DISABLE_LOG_FILE: 'true',
      SFDX_DISABLE_LOG_FILE: 'true'
    });
    assert.equal(electronFallbackEnv.ELECTRON_RUN_AS_NODE, '1');
  });

  test('falls back to a PATH Node when Electron-as-Node cannot start', async () => {
    const calls: Array<{
      args: readonly string[];
      command: string;
      options: { env?: NodeJS.ProcessEnv };
    }> = [];
    const defaultNodeExecutable = process.platform === 'win32' ? 'node.exe' : 'node';
    const { runEmbeddedSfPlugin } = loadRuntimeClient({
      existsSync: filePath => filePath.endsWith(path.join('packages', 'sf-plugin', 'lib', 'embedded.js')),
      spawn: (command, childArgs, options) => {
        const child = createMockChild();
        calls.push({ args: childArgs, command, options: options as { env?: NodeJS.ProcessEnv } });
        queueMicrotask(() => {
          if (calls.length === 1) {
            child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
            return;
          }
          child.stdout.emit('data', '{"ok":true}');
          child.emit('close', 0, null);
        });
        return child;
      }
    });

    const result = await withElectronVersion(() => runEmbeddedSfPlugin(['doctor'], { env: { PATH: '/bin' } }));

    assert.equal(result.stdout, '{"ok":true}');
    assert.deepEqual(calls.map(call => call.command), [process.execPath, defaultNodeExecutable]);
    assert.deepEqual(calls[0]?.args.slice(-2), ['doctor', '--json']);
    assert.equal(calls[0]?.options.env?.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(calls[1]?.options.env?.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(calls[1]?.options.env?.SF_DISABLE_LOG_FILE, 'true');
  });
});
