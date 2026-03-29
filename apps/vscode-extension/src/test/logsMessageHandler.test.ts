import assert from 'assert/strict';

const proxyquire: any = require('proxyquire').noCallThru();

suite('LogsMessageHandler telemetry', () => {
  function createHandler(events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }>) {
    const { LogsMessageHandler } = proxyquire('../provider/logsMessageHandler', {
      '../shared/telemetry': {
        safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
          events.push({ name, properties, measurements });
        },
        '@noCallThru': true
      },
      '../../../../src/utils/logger': {
        logInfo: () => undefined,
        '@noCallThru': true
      }
    });

    return new LogsMessageHandler(
      async () => undefined,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      () => undefined,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      () => undefined,
      async () => undefined,
      async () => undefined
    );
  }

  test('emits logs.search for sanitized search telemetry messages', async () => {
    const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
    const handler = createHandler(events);

    await handler.handle({ type: 'trackLogsSearch', outcome: 'searched', queryLength: '4-10' } as any);

    assert.deepEqual(events, [
      {
        name: 'logs.search',
        properties: { outcome: 'searched', queryLength: '4-10' },
        measurements: undefined
      }
    ]);
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

  test('starts refresh without waiting for org list on ready', async () => {
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
      value => calls.push(`loading:${value}`),
      async () => undefined,
      async () => undefined
    );

    const pending = handler.handle({ type: 'ready' } as any);
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.deepEqual(calls.slice(0, 3), ['loading:true', 'sendOrgs', 'refresh']);

    releaseSendOrgs?.();
    await pending;

    assert.equal(calls.at(-1), 'loading:false');
    assert.equal(events.length, 0);
  });
});
