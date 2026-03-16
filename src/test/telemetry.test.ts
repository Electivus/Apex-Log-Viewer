import assert from 'assert/strict';
import * as path from 'node:path';
const proxyquire: any = require('proxyquire').noCallThru().noPreserveCache();

type TelemetryModule = typeof import('../shared/telemetry');
const REPO_ROOT = path.resolve(__dirname, '../..');

const extensionMode = {
  Production: 1,
  Development: 2,
  Test: 3
} as const;

function loadTelemetryModule() {
  const created: string[] = [];
  const errorEvents: Array<{ name: string; properties?: Record<string, string> }> = [];
  const usageEvents: Array<{
    measurements?: Record<string, number>;
    name: string;
    properties?: Record<string, string>;
  }> = [];
  const warnings: string[][] = [];
  let disposeCount = 0;
  let throwOnSendEvent = false;

  class TelemetryReporterStub {
    constructor(connectionString: string) {
      created.push(connectionString);
    }

    sendTelemetryEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>) {
      if (throwOnSendEvent) {
        throw new Error('send failed');
      }
      usageEvents.push({ name, properties, measurements });
      return { name, properties, measurements };
    }

    sendTelemetryErrorEvent(name: string, properties?: Record<string, string>) {
      errorEvents.push({ name, properties });
      return { name, properties };
    }

    dispose() {
      disposeCount++;
    }
  }

  const telemetry = proxyquire('../shared/telemetry', {
    vscode: { ExtensionMode: extensionMode, '@noCallThru': true },
    '@vscode/extension-telemetry': { TelemetryReporter: TelemetryReporterStub, '@noCallThru': true },
    '../utils/logger': {
      logWarn: (...args: string[]) => warnings.push(args),
      '@noCallThru': true
    }
  }) as TelemetryModule;

  return {
    created,
    errorEvents,
    getDisposeCount: () => disposeCount,
    setThrowOnSendEvent: (value: boolean) => {
      throwOnSendEvent = value;
    },
    telemetry,
    usageEvents,
    warnings
  };
}

function createContext(mode: number) {
  return {
    extension: {
      extensionPath: REPO_ROOT,
      packageJSON: { telemetryConnectionString: 'pkg-conn' }
    },
    extensionMode: mode,
    subscriptions: []
  } as any;
}

suite('telemetry', () => {
  const originalAppInsights = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  const originalEnableTestTelemetry = process.env.ALV_ENABLE_TEST_TELEMETRY;
  const originalTestTelemetryConnection = process.env.ALV_TEST_TELEMETRY_CONNECTION_STRING;
  const originalTestTelemetryRunId = process.env.ALV_TEST_TELEMETRY_RUN_ID;
  const originalVsCodeTelemetry = process.env.VSCODE_TELEMETRY_CONNECTION_STRING;

  teardown(() => {
    if (originalAppInsights === undefined) {
      delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    } else {
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = originalAppInsights;
    }

    if (originalVsCodeTelemetry === undefined) {
      delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;
    } else {
      process.env.VSCODE_TELEMETRY_CONNECTION_STRING = originalVsCodeTelemetry;
    }

    if (originalEnableTestTelemetry === undefined) {
      delete process.env.ALV_ENABLE_TEST_TELEMETRY;
    } else {
      process.env.ALV_ENABLE_TEST_TELEMETRY = originalEnableTestTelemetry;
    }

    if (originalTestTelemetryConnection === undefined) {
      delete process.env.ALV_TEST_TELEMETRY_CONNECTION_STRING;
    } else {
      process.env.ALV_TEST_TELEMETRY_CONNECTION_STRING = originalTestTelemetryConnection;
    }

    if (originalTestTelemetryRunId === undefined) {
      delete process.env.ALV_TEST_TELEMETRY_RUN_ID;
    } else {
      process.env.ALV_TEST_TELEMETRY_RUN_ID = originalTestTelemetryRunId;
    }
  });

  test('does not activate reporter outside production mode', () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;

    const { telemetry, created } = loadTelemetryModule();
    const subscriptions: Array<{ dispose: () => void }> = [];

    telemetry.activateTelemetry({ ...createContext(extensionMode.Development), subscriptions });
    telemetry.activateTelemetry({ ...createContext(extensionMode.Test), subscriptions });

    assert.deepEqual(created, []);
    assert.equal(subscriptions.length, 0);
    telemetry.disposeTelemetry();
  });

  test('uses package telemetryConnectionString when env vars are absent', () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;

    const { telemetry, created, getDisposeCount } = loadTelemetryModule();
    const subscriptions: Array<{ dispose: () => void }> = [];

    telemetry.activateTelemetry({ ...createContext(extensionMode.Production), subscriptions });

    assert.deepEqual(created, ['pkg-conn']);
    assert.equal(subscriptions.length, 1);
    subscriptions[0]?.dispose();
    assert.equal(getDisposeCount(), 1);
    telemetry.disposeTelemetry();
  });

  test('falls back to a module-relative telemetry schema path when context extensionPath is stale', () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;

    const { telemetry, created, usageEvents } = loadTelemetryModule();
    const staleRoot = path.join(REPO_ROOT, '.vscode-test', 'stale-host-root');

    telemetry.activateTelemetry({
      ...createContext(extensionMode.Production),
      extension: {
        extensionPath: staleRoot,
        packageJSON: { telemetryConnectionString: 'pkg-conn' }
      }
    });
    telemetry.safeSendEvent('logs.refresh', { outcome: 'ok' });

    assert.deepEqual(created, ['pkg-conn']);
    assert.equal(usageEvents.length, 1);
    telemetry.disposeTelemetry();
  });

  test('prefers environment connection string over package metadata', () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = 'env-conn';
    process.env.VSCODE_TELEMETRY_CONNECTION_STRING = 'vscode-conn';

    const { telemetry, created } = loadTelemetryModule();

    telemetry.activateTelemetry(createContext(extensionMode.Production));

    assert.deepEqual(created, ['env-conn']);
    telemetry.disposeTelemetry();
  });

  test('allows explicit telemetry in test mode only with the dedicated test connection string', () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;
    process.env.ALV_ENABLE_TEST_TELEMETRY = '1';
    process.env.ALV_TEST_TELEMETRY_CONNECTION_STRING = 'test-conn';

    const { telemetry, created } = loadTelemetryModule();

    telemetry.activateTelemetry(createContext(extensionMode.Test));

    assert.deepEqual(created, ['test-conn']);
    telemetry.disposeTelemetry();
  });

  test('logs and swallows telemetry send failures', () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;

    const { telemetry, warnings, setThrowOnSendEvent } = loadTelemetryModule();

    telemetry.activateTelemetry(createContext(extensionMode.Production));

    setThrowOnSendEvent(true);
    telemetry.safeSendEvent('logs.refresh', { outcome: 'ok' });

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[0], 'Failed sending telemetry ->');
    assert.equal(warnings[0]?.[1], 'send failed');
    telemetry.disposeTelemetry();
  });

  test('drops undeclared events before sending telemetry', () => {
    const { telemetry, usageEvents, warnings } = loadTelemetryModule();

    telemetry.activateTelemetry(createContext(extensionMode.Production));
    telemetry.safeSendEvent('unknown.event', { outcome: 'ok' });

    assert.deepEqual(usageEvents, []);
    assert.ok(
      warnings.some(entry => String(entry[0]).includes('Telemetry event "unknown.event" is not declared')),
      'should warn about undeclared events'
    );
    telemetry.disposeTelemetry();
  });

  test('drops undeclared properties but keeps declared telemetry fields', () => {
    const { telemetry, usageEvents, warnings } = loadTelemetryModule();

    telemetry.activateTelemetry(createContext(extensionMode.Production));
    telemetry.safeSendEvent(
      'logs.refresh',
      { outcome: 'ok', extra: 'ignored' } as Record<string, string>,
      { durationMs: 12, pageSize: 100, bogus: 1 } as Record<string, number>
    );

    assert.equal(usageEvents.length, 1);
    assert.deepEqual(usageEvents[0]?.properties, { outcome: 'ok' });
    assert.deepEqual(usageEvents[0]?.measurements, { durationMs: 12, pageSize: 100 });
    assert.ok(
      warnings.some(entry => String(entry[0]).includes('Telemetry property "extra"')),
      'should warn about undeclared properties'
    );
    assert.ok(
      warnings.some(entry => String(entry[0]).includes('Telemetry measurement "bogus"')),
      'should warn about undeclared measurements'
    );
    telemetry.disposeTelemetry();
  });

  test('drops usage events that miss required outcome', () => {
    const { telemetry, usageEvents, warnings } = loadTelemetryModule();

    telemetry.activateTelemetry(createContext(extensionMode.Production));
    telemetry.safeSendEvent('command.refresh');

    assert.deepEqual(usageEvents, []);
    assert.ok(
      warnings.some(entry => String(entry[0]).includes('missing required property "outcome"')),
      'should warn about missing required outcome'
    );
    telemetry.disposeTelemetry();
  });

  test('injects outcome=error and filters invalid error-event values', () => {
    const { telemetry, errorEvents } = loadTelemetryModule();

    telemetry.activateTelemetry(createContext(extensionMode.Production));
    telemetry.safeSendException('cli.exec', {
      code: 'ENOENT',
      command: 'C:/Users/example/AppData/Local/sf.exe'
    });

    assert.equal(errorEvents.length, 1);
    assert.deepEqual(errorEvents[0], {
      name: 'cli.exec',
      properties: {
        code: 'ENOENT',
        outcome: 'error'
      }
    });
    telemetry.disposeTelemetry();
  });

  test('adds testRunId to telemetry only during explicit test telemetry runs', () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;
    process.env.ALV_ENABLE_TEST_TELEMETRY = '1';
    process.env.ALV_TEST_TELEMETRY_CONNECTION_STRING = 'test-conn';
    process.env.ALV_TEST_TELEMETRY_RUN_ID = '123e4567-e89b-12d3-a456-426614174000';

    const { telemetry, usageEvents } = loadTelemetryModule();

    telemetry.activateTelemetry(createContext(extensionMode.Test));
    telemetry.safeSendEvent('logs.refresh', { outcome: 'ok' });

    assert.equal(usageEvents.length, 1);
    assert.deepEqual(usageEvents[0]?.properties, {
      outcome: 'ok',
      testRunId: '123e4567-e89b-12d3-a456-426614174000'
    });
    telemetry.disposeTelemetry();
  });
});
