import assert from 'assert/strict';

const proxyquire: any = require('proxyquire').noCallThru();

suite('LogsMessageHandler telemetry', () => {
  function createHandler(
    events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }>,
    overrides?: Partial<{
      refresh: () => Promise<void>;
      downloadAllLogs: () => Promise<void>;
      clearLogs: (scope: 'all' | 'mine') => Promise<void>;
      sendOrgs: () => Promise<void>;
      setSelectedOrg: (org?: string) => void;
      openDebugFlags: () => Promise<void>;
      openLog: (logId: string) => Promise<void>;
      debugLog: (logId: string) => Promise<void>;
      loadMore: () => Promise<void>;
      setLoading: (value: boolean) => void;
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
      overrides?.sendOrgs ?? (async () => undefined),
      overrides?.setSelectedOrg ?? (() => undefined),
      overrides?.openDebugFlags ?? (async () => undefined),
      overrides?.openLog ?? (async () => undefined),
      overrides?.debugLog ?? (async () => undefined),
      overrides?.loadMore ?? (async () => undefined),
      overrides?.setLoading ?? (() => undefined),
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

  test('waits for org list before starting refresh on ready', async () => {
    const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
    const calls: string[] = [];
    let releaseSendOrgs: (() => void) | undefined;
    const sendOrgsStarted = new Promise<void>(resolve => {
      releaseSendOrgs = resolve;
    });

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

    const handler = new LogsMessageHandler(
      async () => {
        calls.push('refresh');
      },
      async () => undefined,
      async () => undefined,
      async () => {
        calls.push('sendOrgs');
        await sendOrgsStarted;
      },
      () => undefined,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      (value: boolean) => calls.push(`loading:${value}`),
      async () => undefined,
      async () => undefined
    );

    const pending = handler.handle({ type: 'ready' } as any);
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.deepEqual(calls, ['loading:true', 'sendOrgs']);

    releaseSendOrgs?.();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls.slice(0, 3), ['loading:true', 'sendOrgs', 'refresh']);
    await pending;

    assert.equal(calls.at(-1), 'loading:false');
    assert.equal(events.length, 0);
  });

  test('surfaces sendOrgs failure before starting refresh on ready', async () => {
    const calls: string[] = [];
    const sendOrgsError = new Error('sendOrgs failed');

    const { LogsMessageHandler } = proxyquire('../provider/logsMessageHandler', {
      '../shared/telemetry': {
        safeSendEvent: () => undefined,
        '@noCallThru': true
      },
      '../../../../src/utils/logger': {
        logInfo: () => undefined,
        logWarn: () => undefined,
        '@noCallThru': true
      }
    });

    const handler = new LogsMessageHandler(
      async () => {
        calls.push('refresh');
      },
      async () => undefined,
      async () => undefined,
      async () => {
        calls.push('sendOrgs');
        throw sendOrgsError;
      },
      () => undefined,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      (value: boolean) => calls.push(`loading:${value}`),
      async () => undefined,
      async () => undefined
    );

    await assert.rejects(handler.handle({ type: 'ready' } as any), error => error === sendOrgsError);
    assert.deepEqual(calls, ['loading:true', 'sendOrgs', 'loading:false']);
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
