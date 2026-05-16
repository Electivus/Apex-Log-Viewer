import assert from 'assert/strict';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

suite('runtime client telemetry', () => {
  test('emits daemon.request telemetry for successful runtime calls', async () => {
    const events: Array<{
      name: string;
      properties?: Record<string, string>;
      measurements?: Record<string, number>;
    }> = [];

    const { RuntimeClient } = proxyquireStrict('../../runtime/runtimeClient', {
      '../shared/telemetry': {
        safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
          events.push({ name, properties, measurements });
        },
        '@noCallThru': true
      },
      '../../../../src/utils/logger': {
        logTrace: () => undefined,
        '@noCallThru': true
      },
      '../../../../src/salesforce/path': {
        getLoginShellEnv: async () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../../runtime/runtimeClient');

    const client = new RuntimeClient({
      requestHandler: async (method, params) => {
        assert.equal(method, 'search/query');
        assert.deepEqual(params, { query: 'marker', logIds: ['07L000000000001AA'] });
        return {
          logIds: ['07L000000000001AA'],
          snippets: {},
          pendingLogIds: []
        } as never;
      }
    });

    await client.searchQuery({ query: 'marker', logIds: ['07L000000000001AA'] });

    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.properties, {
      method: 'search_query',
      outcome: 'ok'
    });
    assert.equal(events[0]?.name, 'daemon.request');
    assert.equal(events[0]?.measurements?.attempts, 1);
    assert.equal(Number.isFinite(events[0]?.measurements?.durationMs), true);
  });

  test('maps runtime request methods to path-safe telemetry method names', async () => {
    const events: Array<{
      name: string;
      properties?: Record<string, string>;
      measurements?: Record<string, number>;
    }> = [];
    const methods: string[] = [];

    const { RuntimeClient } = proxyquireStrict('../../runtime/runtimeClient', {
      '../shared/telemetry': {
        safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
          events.push({ name, properties, measurements });
        },
        '@noCallThru': true
      },
      '../../../../src/utils/logger': {
        logTrace: () => undefined,
        '@noCallThru': true
      },
      '../../../../src/salesforce/path': {
        getLoginShellEnv: async () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../../runtime/runtimeClient');

    const client = new RuntimeClient({
      requestHandler: async method => {
        methods.push(method);
        return {} as never;
      }
    });

    await client.initialize();
    await client.orgList();
    await client.getOrgAuth();
    await client.logsList();
    await client.logsSync();
    await client.searchQuery({ query: 'marker' });
    await client.logsTriage({ logIds: ['07L000000000001AA'] });
    await client.resolveCachedLogPath({ logId: '07L000000000001AA' });

    assert.deepEqual(methods, [
      'initialize',
      'org/list',
      'org/auth',
      'logs/list',
      'logs/sync',
      'search/query',
      'logs/triage',
      'logs/resolveCachedPath'
    ]);
    assert.deepEqual(
      events.map(event => event.properties?.method),
      [
        'initialize',
        'org_list',
        'org_auth',
        'logs_list',
        'logs_sync',
        'search_query',
        'logs_triage',
        'logs_resolve_cached_path'
      ]
    );
    assert.equal(
      events.every(event => event.name === 'daemon.request'),
      true
    );
    assert.equal(
      events.every(event => event.properties?.outcome === 'ok'),
      true
    );
  });

  test('emits cancelled telemetry for pre-aborted runtime calls', async () => {
    const events: Array<{
      name: string;
      properties?: Record<string, string>;
      measurements?: Record<string, number>;
    }> = [];
    let called = false;

    const { RuntimeClient } = proxyquireStrict('../../runtime/runtimeClient', {
      '../shared/telemetry': {
        safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
          events.push({ name, properties, measurements });
        },
        '@noCallThru': true
      },
      '../../../../src/utils/logger': {
        logTrace: () => undefined,
        '@noCallThru': true
      },
      '../../../../src/salesforce/path': {
        getLoginShellEnv: async () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../../runtime/runtimeClient');

    const client = new RuntimeClient({
      requestHandler: async () => {
        called = true;
        return {} as never;
      }
    });
    const abortController = new AbortController();
    abortController.abort();

    await assert.rejects(
      client.searchQuery({ query: 'marker', logIds: ['07L000000000001AA'] }, abortController.signal),
      error => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).name, 'AbortError');
        return true;
      }
    );

    assert.equal(called, false, 'should short-circuit before invoking the runtime request handler');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.properties, {
      method: 'search_query',
      outcome: 'cancelled'
    });
    assert.equal(events[0]?.name, 'daemon.request');
    assert.equal(events[0]?.measurements?.attempts, 1);
    assert.equal(Number.isFinite(events[0]?.measurements?.durationMs), true);
  });

  test('emits coarse error code for failed runtime calls', async () => {
    const events: Array<{
      name: string;
      properties?: Record<string, string>;
      measurements?: Record<string, number>;
    }> = [];

    const { RuntimeClient } = proxyquireStrict('../../runtime/runtimeClient', {
      '../shared/telemetry': {
        safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
          events.push({ name, properties, measurements });
        },
        '@noCallThru': true
      },
      '../../../../src/utils/logger': {
        logTrace: () => undefined,
        '@noCallThru': true
      },
      '../../../../src/salesforce/path': {
        getLoginShellEnv: async () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../../runtime/runtimeClient');

    const client = new RuntimeClient({
      requestHandler: async () => {
        throw new Error('runtime exited (code 1)');
      }
    });

    await assert.rejects(client.logsList());

    assert.equal(events.length, 1);
    assert.equal(events[0]?.properties?.method, 'logs_list');
    assert.equal(events[0]?.properties?.outcome, 'error');
    assert.equal(events[0]?.properties?.code, 'RUNTIME_EXIT');
    assert.equal(events[0]?.name, 'daemon.request');
  });
});
