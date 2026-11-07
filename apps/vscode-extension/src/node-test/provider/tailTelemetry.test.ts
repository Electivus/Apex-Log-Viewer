import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import { WEBVIEW_SESSION_MOUNT_DELAY_MS } from '../../provider/webviewSession';
import { FakeHost, formatLocalized, vscodeStub } from '../customLogsTestSupport';
import { activateRealTelemetry, type RealTelemetry } from '../telemetryTestSupport';
import { FakeClock, createWebviewSessionForTest, settle } from '../webviewSessionTestSupport';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const ORG = 'tail-user@example.com';
const AUTH_FAILURE = `Authentication failed for ${ORG} at https://example.my.salesforce.com`;
const LOG_ID = '07L000000000002AAA';

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

type Cancel = () => void;

type Behavior = {
  onAuthRequest?: (state: { ready: boolean }) => Promise<unknown>;
  replayAvailable?: (cancel: Cancel) => boolean;
  resolvePath?: (cancel: Cancel) => void;
};

async function openTail(telemetry: RealTelemetry, behavior: Behavior = {}) {
  const state = { ready: false };
  let onCancel: (() => void) | undefined;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      onCancel = listener;
    }
  };
  const cancel: Cancel = () => {
    token.isCancellationRequested = true;
    onCancel?.();
  };
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
    logsList: async () => [],
    requireLocalLogPath: async ({ logId }: { logId: string }) => {
      behavior.resolvePath?.(cancel);
      return { logId, localPath: '/tmp/tail.log', source: 'local' };
    }
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
      Uri: { ...vscodeStub.Uri, file: (fsPath: string) => ({ fsPath }) },
      ProgressLocation: { Notification: 15 },
      workspace: { onDidChangeConfiguration: noEvent },
      window: {
        ...vscodeStub.window,
        state: { active: true },
        onDidChangeWindowState: noEvent,
        withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
          task({}, token)
      }
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
    '../host/utils/replayDebugger': {
      ensureReplayDebuggerAvailable: async () => behavior.replayAvailable?.(cancel) ?? true
    },
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

suite('Tail telemetry', () => {
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

  function assertOnly(name: string, properties: Record<string, string>) {
    assert.deepEqual(telemetry.catalogWarnings, [], 'telemetry.json accepted every property and measurement');
    const events = telemetry.eventsNamed(name);
    assert.equal(events.length, 1, `exactly one ${name} event`);
    assert.deepEqual(events[0]?.properties, properties);
    assert.equal(typeof events[0]?.measurements?.durationMs, 'number');
  }

  test('reports ok once Tail is subscribed', async () => {
    const { host, provider } = await openTail(telemetry);
    await host.emit({ type: 'tailStart', debugLevel: 'ALV_E2E' });
    assert.equal(host.last('tailStatus')?.running, true);
    assertOnly('tail.start', { outcome: 'ok' });
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
    assertOnly('tail.start', { outcome: 'error', code: 'AUTH_FAILED' });
    const payload = JSON.stringify(telemetry.sent);
    assert.ok(!payload.includes(ORG), 'the org is not in the payload');
    assert.ok(!payload.includes(AUTH_FAILURE), 'the raw message is not in the payload');
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
    assertOnly('tail.start', { outcome: 'cancel' });
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
    assertOnly('tail.start', { outcome: 'ok' });
    provider.dispose();
  });

  test('reports NO_DEBUG_LEVEL for an empty debug level', async () => {
    const { host, provider } = await openTail(telemetry);
    await host.emit({ type: 'tailStart', debugLevel: '  ' });
    assertOnly('tail.start', { outcome: 'error', code: 'NO_DEBUG_LEVEL' });
    provider.dispose();
  });

  const silentReplays: Array<[string, string, Behavior]> = [
    ['ok when the debugger launches', 'ok', {}],
    ['unavailable when the debugger cannot be made available', 'unavailable', { replayAvailable: () => false }],
    [
      'cancel when cancelled while checking the debugger',
      'cancel',
      {
        replayAvailable: cancel => {
          cancel();
          return false;
        }
      }
    ],
    ['cancel when cancelled while resolving the log', 'cancel', { resolvePath: cancel => cancel() }],
    [
      'cancel when the request aborts',
      'cancel',
      {
        resolvePath: cancel => {
          cancel();
          throw new Error('Request aborted');
        }
      }
    ]
  ];
  for (const [label, outcome, behavior] of silentReplays) {
    test(`replay reports ${label}`, async () => {
      const { host, provider } = await openTail(telemetry, behavior);
      await host.emit({ type: 'replay', logId: LOG_ID });
      assertOnly('logs.replay', { outcome, view: 'tail' });
      assert.equal(host.last('error')?.message, undefined, 'no error reaches the Tail view');
      assert.ok(!JSON.stringify(telemetry.sent).includes(LOG_ID), 'the log id is not in the payload');
      provider.dispose();
    });
  }

  test('replay reports error and still tells the user', async () => {
    const { host, provider } = await openTail(telemetry, {
      resolvePath: () => {
        throw new Error(`boom for ${LOG_ID}`);
      }
    });
    await host.emit({ type: 'replay', logId: LOG_ID });
    assertOnly('logs.replay', { outcome: 'error', view: 'tail' });
    assert.equal(host.last('error')?.message, `boom for ${LOG_ID}`);
    assert.ok(!JSON.stringify(telemetry.sent).includes(LOG_ID), 'the log id is not in the payload');
    provider.dispose();
  });
});
