import path from 'node:path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();
const REPO_ROOT = path.resolve(__dirname, '../../../..');

export type SentTelemetryEvent = {
  name: string;
  properties?: Record<string, string>;
  measurements?: Record<string, number>;
};

type TelemetryModule = typeof import('../shared/telemetry');

export type RealTelemetry = {
  module: TelemetryModule;
  sent: SentTelemetryEvent[];
  catalogWarnings: string[];
  eventsNamed(name: string): SentTelemetryEvent[];
  dispose(): void;
};

export function activateRealTelemetry(): RealTelemetry {
  const sent: SentTelemetryEvent[] = [];
  const catalogWarnings: string[] = [];
  const record = (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
    sent.push({ name, properties, measurements });
  };
  class FakeTelemetryReporter {
    sendTelemetryEvent = record;
    sendDangerousTelemetryEvent = record;
    sendTelemetryErrorEvent = () => undefined;
    sendDangerousTelemetryErrorEvent = () => undefined;
    dispose = async () => undefined;
  }
  const module = proxyquireStrict('../shared/telemetry', {
    vscode: { ExtensionMode: { Production: 1, Development: 2, Test: 3 } },
    '@vscode/extension-telemetry': { TelemetryReporter: FakeTelemetryReporter },
    '../host/utils/logger': { logWarn: (...args: unknown[]) => catalogWarnings.push(args.join(' ')) }
  }) as TelemetryModule;
  module.activateTelemetry({
    extensionMode: 1,
    subscriptions: [],
    extension: { extensionPath: REPO_ROOT, packageJSON: { telemetryConnectionString: 'InstrumentationKey=test' } }
  } as never);
  return {
    module,
    sent,
    catalogWarnings,
    eventsNamed: name => sent.filter(event => event.name === name),
    dispose: () => module.disposeTelemetry()
  };
}
