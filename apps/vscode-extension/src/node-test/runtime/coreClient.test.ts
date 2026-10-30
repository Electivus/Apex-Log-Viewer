import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import type { ApexLogViewerCore } from '@alv/core';

const { CoreClient } = proxyquire.noCallThru().noPreserveCache()('../../runtime/runtimeClient', {
  '../shared/telemetry': { safeSendEvent: () => undefined },
  '../shared/telemetryErrorCodes': { getTelemetryErrorCode: () => 'TEST' }
}) as typeof import('../../runtime/runtimeClient');

function fakeCore(overrides: Partial<ApexLogViewerCore> = {}): ApexLogViewerCore {
  return {
    doctor: async () => ({}) as never,
    org: {
      list: async () => [],
      resolve: async () => ({}) as never,
      getAuth: async () => ({ accessToken: 'token', instanceUrl: 'https://example.test' })
    },
    log: {
      list: async () => [],
      sync: async () => ({}) as never,
      status: async () => ({}) as never,
      read: async () => ({}) as never,
      resolve: async () => ({}) as never,
      triage: async () => [],
      delete: async () => ({}) as never
    },
    user: { search: async () => ({ users: [] }) },
    traceFlag: {
      status: async () => ({}) as never,
      apply: async () => ({}) as never,
      remove: async () => ({}) as never
    },
    debugLevel: {
      list: async () => [],
      get: async () => undefined,
      create: async () => ({}) as never,
      update: async () => ({}) as never,
      delete: async () => ({}) as never
    },
    tooling: { query: async () => ({ records: [] }), get: async () => ({}) },
    customLog: {
      sources: async () => ({ sources: [], issues: [] }),
      list: async () => ({}) as never,
      get: async () => ({}) as never,
      entry: async () => ({}) as never
    },
    dispose: () => undefined,
    ...overrides
  } as ApexLogViewerCore;
}

suite('shared core client', () => {
  test('invokes core in process and supplies the workspace root', async () => {
    let observedWorkspace: string | undefined;
    const core = fakeCore();
    core.log.sync = async params => {
      observedWorkspace = params?.workspaceRoot;
      return { downloaded: 0 } as never;
    };
    const client = new CoreClient({ core, workspaceRoot: () => '/workspace' });

    await client.logsSync({ targetOrg: 'demo' });

    assert.equal(observedWorkspace, '/workspace');
  });

  test('deduplicates simultaneous org list calls', async () => {
    let calls = 0;
    let release: ((value: Array<{ username: string }>) => void) | undefined;
    const pending = new Promise<Array<{ username: string }>>(resolve => {
      release = resolve;
    });
    const core = fakeCore();
    core.org.list = async () => {
      calls += 1;
      return pending;
    };
    const client = new CoreClient({ core });

    const first = client.orgList();
    const second = client.orgList();
    release?.([{ username: 'demo@example.com' }]);

    assert.deepEqual(await first, [{ username: 'demo@example.com' }]);
    assert.deepEqual(await second, [{ username: 'demo@example.com' }]);
    assert.equal(calls, 1);
  });

  test('forwards each Custom Logs call to core with its params and the abort signal', async () => {
    const seen: Array<{ method: string; params: unknown; signal: AbortSignal | undefined }> = [];
    const record =
      (method: string, result: unknown) =>
      async (params: unknown, options?: { signal?: AbortSignal }): Promise<never> => {
        seen.push({ method, params, signal: options?.signal });
        return result as never;
      };
    const core = fakeCore();
    core.customLog.sources = record('sources', { sources: [], issues: [] });
    core.customLog.list = record('list', { rows: [] });
    core.customLog.get = record('get', { entries: [] });
    core.customLog.entry = record('entry', { details: [] });
    const client = new CoreClient({ core, workspaceRoot: () => '/workspace' });
    const controller = new AbortController();

    await client.customLogSources({ targetOrg: 'demo', projectDir: '/project' }, controller.signal);
    await client.customLogList({ targetOrg: 'demo', projectDir: undefined, source: 'nebula' }, controller.signal);
    await client.customLogGet(
      { targetOrg: 'demo', projectDir: '/project', logId: 'a02000000000001AAA' },
      controller.signal
    );
    await client.customLogEntry(
      { targetOrg: 'demo', projectDir: '/project', entryId: 'a01000000000001AAA' },
      controller.signal
    );

    assert.deepEqual(
      seen.map(call => [call.method, call.signal === controller.signal]),
      [
        ['sources', true],
        ['list', true],
        ['get', true],
        ['entry', true]
      ]
    );
    assert.deepEqual(seen[0]?.params, { targetOrg: 'demo', projectDir: '/project' });
    assert.deepEqual(seen[1]?.params, { targetOrg: 'demo', projectDir: undefined, source: 'nebula' });
  });

  test('maps core cancellation to the standard AbortError shape', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new CoreClient({ core: fakeCore() });

    await assert.rejects(client.logsList({}, controller.signal), error => (error as Error).name === 'AbortError');
    await assert.rejects(
      client.customLogSources({ projectDir: undefined }, controller.signal),
      error => (error as Error).name === 'AbortError'
    );
  });
});
