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
      method: 'search/query',
      outcome: 'ok'
    });
    assert.equal(events[0]?.name, 'daemon.request');
    assert.equal(events[0]?.measurements?.attempts, 1);
    assert.equal(Number.isFinite(events[0]?.measurements?.durationMs), true);
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
      method: 'search/query',
      outcome: 'cancelled'
    });
    assert.equal(events[0]?.name, 'daemon.request');
    assert.equal(events[0]?.measurements?.attempts, 1);
    assert.equal(Number.isFinite(events[0]?.measurements?.durationMs), true);
  });
});
