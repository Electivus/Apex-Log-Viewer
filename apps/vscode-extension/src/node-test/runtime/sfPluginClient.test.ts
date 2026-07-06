import assert from 'assert/strict';
import os from 'node:os';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

type EventRecord = {
  name: string;
  properties?: Record<string, string>;
  measurements?: Record<string, number>;
};

function loadRuntimeClient(args: {
  existsSync?: (filePath: string) => boolean;
  events?: EventRecord[];
  traceEntries?: unknown[][];
  traceEnabled?: boolean;
}) {
  return proxyquireStrict('../../runtime/runtimeClient', {
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
  }) as typeof import('../../runtime/runtimeClient');
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
});
