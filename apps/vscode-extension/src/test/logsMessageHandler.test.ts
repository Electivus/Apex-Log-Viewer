import assert from 'assert/strict';

const proxyquire: any = require('proxyquire').noCallThru();

suite('LogsMessageHandler telemetry', () => {
  function createHandler(
    events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }>,
    overrides?: Partial<{
      refresh: () => Promise<void>;
      downloadAllLogs: () => Promise<void>;
      clearLogs: (scope: 'all' | 'mine') => Promise<void>;
      setSelectedOrg: (org?: string) => void;
      openDebugFlags: () => Promise<void>;
      openLog: (logId: string) => Promise<void>;
      debugLog: (logId: string) => Promise<void>;
      loadMore: () => Promise<void>;
      setSearchQuery: (value: string) => Promise<void>;
      setLogsColumns: (value: unknown) => Promise<void>;
    }>
  ) {
    const { LogsMessageHandler } = proxyquire('../provider/logsMessageHandler', {
      '../shared/telemetry': {
        safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
          events.push({ name, properties, measurements });
        },
        '@noCallThru': true
      },
      '../../../../src/utils/logger': {
        logInfo: () => undefined,
        logWarn: () => undefined,
        '@noCallThru': true
      }
    });

    return new LogsMessageHandler(
      overrides?.refresh ?? (async () => undefined),
      overrides?.downloadAllLogs ?? (async () => undefined),
      overrides?.clearLogs ?? (async () => undefined),
      overrides?.setSelectedOrg ?? (() => undefined),
      overrides?.openDebugFlags ?? (async () => undefined),
      overrides?.openLog ?? (async () => undefined),
      overrides?.debugLog ?? (async () => undefined),
      overrides?.loadMore ?? (async () => undefined),
      overrides?.setSearchQuery ?? (async () => undefined),
      overrides?.setLogsColumns ?? (async () => undefined)
    );
  }

  test('emits zero-duration logs.search telemetry when the search is cleared', async () => {
    const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
    const handler = createHandler(events);

    await handler.handle({ type: 'trackLogsSearch', outcome: 'cleared' } as any);

    assert.deepEqual(events, [
      {
        name: 'logs.search',
        properties: { outcome: 'cleared' },
        measurements: { durationMs: 0, matchCount: 0, pendingCount: 0 }
      }
    ]);
  });

  test('does not emit searched logs.search telemetry from the message handler', async () => {
    const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
    const handler = createHandler(events);

    await handler.handle({ type: 'trackLogsSearch', outcome: 'searched', queryLength: '4-10' } as any);

    assert.deepEqual(events, []);
  });

  test('emits logs.filter for sanitized filter telemetry messages', async () => {
    const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
    const handler = createHandler(events);

    await handler.handle({
      type: 'trackLogsFilter',
      outcome: 'changed',
      hasUser: false,
      hasOperation: true,
      hasStatus: false,
      hasCodeUnit: false,
      errorsOnly: true,
      activeCount: 2
    } as any);

    assert.deepEqual(events, [
      {
        name: 'logs.filter',
        properties: {
          outcome: 'changed',
          hasUser: 'false',
          hasOperation: 'true',
          hasStatus: 'false',
          hasCodeUnit: 'false',
          errorsOnly: 'true'
        },
        measurements: { activeCount: 2 }
      }
    ]);
  });

  test('ignores malformed openLog payloads before invoking callbacks', async () => {
    const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
    const opened: string[] = [];
    const handler = createHandler(events, {
      openLog: async (logId: string) => {
        opened.push(logId);
      }
    });

    await handler.handle({ type: 'openLog', logId: { bad: true } } as any);

    assert.deepEqual(opened, []);
    assert.deepEqual(events, []);
  });

  test('normalizes blank selectOrg targets to undefined', async () => {
    const selected: Array<string | undefined> = [];
    let refreshCount = 0;
    const handler = createHandler([], {
      setSelectedOrg: (org?: string) => {
        selected.push(org);
      },
      refresh: async () => {
        refreshCount += 1;
      }
    });

    await handler.handle({ type: 'selectOrg', target: '   ' } as any);

    assert.deepEqual(selected, [undefined]);
    assert.equal(refreshCount, 1);
  });
});
