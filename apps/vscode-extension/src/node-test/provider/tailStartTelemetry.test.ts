import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import { WEBVIEW_SESSION_MOUNT_DELAY_MS } from '../../provider/webviewSession';
import { FakeHost, formatLocalized, vscodeStub } from '../customLogsTestSupport';
import { activateRealTelemetry, type RealTelemetry } from '../telemetryTestSupport';
import { FakeClock, createWebviewSessionForTest, settle } from '../webviewSessionTestSupport';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const ORG = 'tail-user@example.com';
const AUTH_FAILURE = `Authentication failed for ${ORG} at https://example.my.salesforce.com`;

type Gate = { promise: Promise<void>; open: () => void };

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the Tail start');
    await settle();
  }
}

type Behavior = {
  onAuthRequest?: (state: { ready: boolean }) => Promise<unknown>;
};

async function openTail(telemetry: RealTelemetry, behavior: Behavior = {}) {
  const state = { ready: false };
  const clock = new FakeClock();
  const noEvent = () => ({ dispose: () => undefined });
  const quiet = {
    logInfo: () => undefined,
    logWarn: () => undefined,
    logError: () => undefined,
    showOutput: () => undefined
  };
  const localize = {
    localize: (_key: string, message: string, ...args: Array<string | number>) => formatLocalized(message, ...args)
  };
  const runtimeClient = {
    orgList: async () => [{ username: ORG, isDefaultUsername: true }],
    getOrgAuth: async () =>
      (await behavior.onAuthRequest?.(state)) ?? { username: ORG, instanceUrl: 'https://example.my.salesforce.com' },
    logsList: async () => []
  };
  const tailServiceModule = proxyquireStrict('../../host/utils/tailService', {
    './logger': quiet,
    './localize': localize,
    './workspace': { getWorkspaceRoot: () => undefined },
    '../salesforce/http': { getEffectiveApiVersion: () => '64.0' },
    '../salesforce/traceflags': { ensureUserTraceFlag: async () => false },
    '../salesforce/streaming': {
      createConnectionFromAuth: async (_auth: unknown, version: string) => ({ version }),
      createLoggingStreamingClient: async () => ({
        handshake: async () => undefined,
        replay: () => undefined,
        subscribeAndAwaitAck: async () => undefined,
        disconnect: () => undefined
      })
    },
    '../../runtime/runtimeClient': { runtimeClient }
  }) as typeof import('../../host/utils/tailService');

  const { SfLogTailViewProvider } = proxyquireStrict('../../provider/SfLogTailViewProvider', {
    vscode: {
      ...vscodeStub,
      workspace: { onDidChangeConfiguration: noEvent },
      window: { ...vscodeStub.window, state: { active: true }, onDidChangeWindowState: noEvent }
    },
    '../host/utils/localize': localize,
    '../host/salesforce/traceflags': {
      listDebugLevels: async () => ['ALV_E2E'],
      getActiveUserDebugLevel: async () => undefined,
      ensureDefaultTailDebugLevel: async () => 'ALV_E2E'
    },
    '../host/utils/logger': quiet,
    '../host/utils/responsiveness': { recordInboundMessage: () => undefined },
    '../shared/telemetry': telemetry.module,
    '../host/utils/replayDebugger': { ensureReplayDebuggerAvailable: async () => true },
    '../host/utils/webviewHtml': { buildWebviewHtml: () => '<html></html>' },
    '../host/utils/tailService': tailServiceModule,
    '../host/utils/config': {
      getNumberConfig: (_key: string, fallback: number) => fallback,
      affectsConfiguration: () => false
    },
    '../panel/LogViewerPanel': { LogViewerPanel: {} },
    '../panel/DebugFlagsPanel': { DebugFlagsPanel: {} },
    '../runtime/runtimeClient': { runtimeClient },
    './webviewHost': { createWebviewViewHost: (view: unknown) => view },
    './webviewSession': { createWebviewSession: (options: never) => createWebviewSessionForTest(options, clock) }
  }) as typeof import('../../provider/SfLogTailViewProvider');

  const provider = new SfLogTailViewProvider({ extensionUri: {} } as never);
  const host = new FakeHost();
  provider.resolveWebviewView(host as never);
  await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
  await host.emit({ type: 'ready', mountSequence: 1 });
  await until(() => host.last('debugLevels') !== undefined);
  state.ready = true;
  return { host, provider };
}

suite('Tail start telemetry', () => {
  let telemetry: RealTelemetry;
  setup(() => {
    telemetry = activateRealTelemetry();
  });
  teardown(() => {
    telemetry.dispose();
  });

  function startEvents() {
    assert.deepEqual(telemetry.catalogWarnings, [], 'telemetry.json accepted every property and measurement');
    return telemetry.eventsNamed('tail.start');
  }

  function assertOnlyStart(properties: Record<string, string>) {
    const events = startEvents();
    assert.equal(events.length, 1, 'exactly one tail.start event');
    assert.deepEqual(events[0]?.properties, properties);
    assert.equal(typeof events[0]?.measurements?.durationMs, 'number');
  }

  test('reports ok once Tail is subscribed', async () => {
    const { host, provider } = await openTail(telemetry);
    await host.emit({ type: 'tailStart', debugLevel: 'ALV_E2E' });
    assert.equal(host.last('tailStatus')?.running, true);
    assertOnlyStart({ outcome: 'ok' });
    provider.dispose();
  });

  test('reports an error code and never the raw message', async () => {
    const { host, provider } = await openTail(telemetry, {
      onAuthRequest: async ({ ready }) => {
        if (ready) {
          throw new Error(AUTH_FAILURE);
        }
      }
    });
    await host.emit({ type: 'tailStart', debugLevel: 'ALV_E2E' });
    assertOnlyStart({ outcome: 'error', code: 'AUTH_FAILED' });
    const payload = JSON.stringify(telemetry.sent);
    assert.ok(!payload.includes(ORG) && !payload.includes('salesforce.com'), 'no org value in the payload');
    provider.dispose();
  });

  test('reports cancel when Tail is stopped while auth is pending', async () => {
    const auth = gate();
    const { host, provider } = await openTail(telemetry, {
      onAuthRequest: async ({ ready }) => {
        if (ready) {
          await auth.promise;
        }
      }
    });
    const starting = host.emit({ type: 'tailStart', debugLevel: 'ALV_E2E' });
    await settle();
    await host.emit({ type: 'tailStop' });
    auth.open();
    await starting;
    assertOnlyStart({ outcome: 'cancel' });
    provider.dispose();
  });

  test('sends one event when Start is clicked again during a start', async () => {
    const auth = gate();
    const { host, provider } = await openTail(telemetry, {
      onAuthRequest: async ({ ready }) => {
        if (ready) {
          await auth.promise;
        }
      }
    });
    const first = host.emit({ type: 'tailStart', debugLevel: 'ALV_E2E' });
    await settle();
    await host.emit({ type: 'tailStart', debugLevel: 'ALV_E2E' });
    assert.deepEqual(startEvents(), [], 'the duplicate click sent nothing');
    auth.open();
    await first;
    assertOnlyStart({ outcome: 'ok' });
    provider.dispose();
  });

  test('reports NO_DEBUG_LEVEL for an empty debug level', async () => {
    const { host, provider } = await openTail(telemetry);
    await host.emit({ type: 'tailStart', debugLevel: '  ' });
    assertOnlyStart({ outcome: 'error', code: 'NO_DEBUG_LEVEL' });
    provider.dispose();
  });
});
