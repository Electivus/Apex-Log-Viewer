import assert from 'assert/strict';
const proxyquire: any = require('proxyquire').noCallThru().noPreserveCache();

type TelemetryModule = typeof import('../shared/telemetry');

const extensionMode = {
  Production: 1,
  Development: 2,
  Test: 3
} as const;

function loadTelemetryModule() {
  const created: string[] = [];
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
      return { name, properties, measurements };
    }

    sendTelemetryErrorEvent(name: string, properties?: Record<string, string>) {
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
    telemetry,
    created,
    warnings,
    getDisposeCount: () => disposeCount,
    setThrowOnSendEvent: (value: boolean) => {
      throwOnSendEvent = value;
    }
  };
}

suite('telemetry', () => {
  const originalAppInsights = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
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
  });

  test('does not activate reporter outside production mode', () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;

    const { telemetry, created } = loadTelemetryModule();
    const subscriptions: Array<{ dispose: () => void }> = [];

    telemetry.activateTelemetry({
      extensionMode: extensionMode.Development,
      extension: { packageJSON: { telemetryConnectionString: 'pkg-conn' } },
      subscriptions
    } as any);

    telemetry.activateTelemetry({
      extensionMode: extensionMode.Test,
      extension: { packageJSON: { telemetryConnectionString: 'pkg-conn' } },
      subscriptions
    } as any);

    assert.deepEqual(created, []);
    assert.equal(subscriptions.length, 0);
    telemetry.disposeTelemetry();
  });

  test('uses package telemetryConnectionString when env vars are absent', () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;

    const { telemetry, created, getDisposeCount } = loadTelemetryModule();
    const subscriptions: Array<{ dispose: () => void }> = [];

    telemetry.activateTelemetry({
      extensionMode: extensionMode.Production,
      extension: { packageJSON: { telemetryConnectionString: 'pkg-conn' } },
      subscriptions
    } as any);

    assert.deepEqual(created, ['pkg-conn']);
    assert.equal(subscriptions.length, 1);
    subscriptions[0]?.dispose();
    assert.equal(getDisposeCount(), 1);
    telemetry.disposeTelemetry();
  });

  test('prefers environment connection string over package metadata', () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = 'env-conn';
    process.env.VSCODE_TELEMETRY_CONNECTION_STRING = 'vscode-conn';

    const { telemetry, created } = loadTelemetryModule();

    telemetry.activateTelemetry({
      extensionMode: extensionMode.Production,
      extension: { packageJSON: { telemetryConnectionString: 'pkg-conn' } },
      subscriptions: []
    } as any);

    assert.deepEqual(created, ['env-conn']);
    telemetry.disposeTelemetry();
  });

  test('logs and swallows telemetry send failures', () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.VSCODE_TELEMETRY_CONNECTION_STRING;

    const { telemetry, warnings, setThrowOnSendEvent } = loadTelemetryModule();

    telemetry.activateTelemetry({
      extensionMode: extensionMode.Production,
      extension: { packageJSON: { telemetryConnectionString: 'pkg-conn' } },
      subscriptions: []
    } as any);

    setThrowOnSendEvent(true);
    telemetry.safeSendEvent('logs.refresh');

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[0], 'Failed sending telemetry ->');
    assert.equal(warnings[0]?.[1], 'send failed');
    telemetry.disposeTelemetry();
  });
});
