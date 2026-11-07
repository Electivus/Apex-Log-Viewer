import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import { activateRealTelemetry, type RealTelemetry } from '../telemetryTestSupport';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const LOG_ID = '07L000000000002AAA';

type Cancel = () => void;

type Scenario = {
  resolvePath?: (cancel: Cancel) => void;
  show?: (cancel: Cancel) => void;
  replayAvailable?: (cancel: Cancel) => boolean;
};

async function drive(
  telemetry: RealTelemetry,
  scenario: Scenario,
  message: { type: 'openLog' | 'replay'; logId: string }
): Promise<string[]> {
  const errors: string[] = [];
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
  const quiet = { logInfo: () => undefined, logWarn: () => undefined };
  const { LogService } = proxyquireStrict('../../host/services/logService', {
    vscode: {
      Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
      ProgressLocation: { Notification: 15 },
      window: {
        withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
          task({}, token),
        showErrorMessage: async (text: string) => {
          errors.push(text);
        }
      },
      commands: { executeCommand: async () => undefined }
    },
    '../utils/logger': quiet,
    '../utils/localize': { localize: (_key: string, text: string) => text },
    '../utils/workspace': { getWorkspaceRoot: () => '/workspace' },
    '../utils/replayDebugger': {
      ensureReplayDebuggerAvailable: async () => scenario.replayAvailable?.(cancel) ?? true
    },
    '../../panel/LogViewerPanel': {
      LogViewerPanel: {
        show: async () => {
          scenario.show?.(cancel);
        }
      }
    },
    '../../runtime/runtimeClient': {
      runtimeClient: {
        requireLocalLogPath: async () => {
          scenario.resolvePath?.(cancel);
          return { localPath: '/tmp/open.log', source: 'local' };
        }
      }
    }
  }) as typeof import('../../host/services/logService');
  const service = new LogService();
  const { LogsMessageHandler } = proxyquireStrict('../../provider/logsMessageHandler', {
    '../shared/telemetry': telemetry.module,
    '../host/utils/logger': quiet
  }) as typeof import('../../provider/logsMessageHandler');
  const noop = async () => undefined;
  const handler = new LogsMessageHandler(
    noop,
    noop,
    noop,
    () => undefined,
    noop,
    id => service.openLog(id),
    id => service.debugLog(id),
    noop,
    noop,
    noop
  );
  await handler.handle(message);
  return errors;
}

function assertSent(telemetry: RealTelemetry, name: string, outcome: string): void {
  assert.deepEqual(telemetry.catalogWarnings, [], 'telemetry.json accepted every property and measurement');
  const events = telemetry.eventsNamed(name);
  assert.equal(events.length, 1, `exactly one ${name} event`);
  assert.deepEqual(events[0]?.properties, { outcome, view: 'logs' });
  assert.equal(typeof events[0]?.measurements?.durationMs, 'number');
  assert.ok(!JSON.stringify(telemetry.sent).includes(LOG_ID), 'the log id is not in the payload');
}

suite('Logs telemetry for open and replay', () => {
  let telemetry: RealTelemetry;
  setup(() => {
    telemetry = activateRealTelemetry();
  });
  teardown(() => {
    telemetry.dispose();
  });

  const open = { type: 'openLog', logId: LOG_ID } as const;
  const replay = { type: 'replay', logId: LOG_ID } as const;
  const failing = {
    resolvePath: () => {
      throw new Error(`boom for ${LOG_ID}`);
    }
  };

  test('open reports ok', async () => {
    await drive(telemetry, {}, open);
    assertSent(telemetry, 'log.open', 'ok');
  });

  test('open reports error and still tells the user', async () => {
    const errors = await drive(telemetry, failing, open);
    assert.equal(errors.length, 1);
    assertSent(telemetry, 'log.open', 'error');
  });

  const openCancels: Array<[string, Scenario]> = [
    ['before the viewer opens', { resolvePath: cancel => cancel() }],
    ['after the viewer opens', { show: cancel => cancel() }],
    [
      'while the request fails',
      {
        resolvePath: cancel => {
          cancel();
          throw new Error('Request aborted');
        }
      }
    ]
  ];
  for (const [label, scenario] of openCancels) {
    test(`open reports cancel when cancelled ${label}`, async () => {
      const errors = await drive(telemetry, scenario, open);
      assert.deepEqual(errors, [], 'a cancel shows no error');
      assertSent(telemetry, 'log.open', 'cancel');
    });
  }

  test('replay reports ok', async () => {
    await drive(telemetry, {}, replay);
    assertSent(telemetry, 'logs.replay', 'ok');
  });

  test('replay reports error and still tells the user', async () => {
    const errors = await drive(telemetry, failing, replay);
    assert.equal(errors.length, 1);
    assertSent(telemetry, 'logs.replay', 'error');
  });

  const replayCancels: Array<[string, Scenario]> = [
    [
      'while checking the debugger',
      {
        replayAvailable: cancel => {
          cancel();
          return false;
        }
      }
    ],
    ['while resolving the log', { resolvePath: cancel => cancel() }]
  ];
  for (const [label, scenario] of replayCancels) {
    test(`replay reports cancel when cancelled ${label}`, async () => {
      await drive(telemetry, scenario, replay);
      assertSent(telemetry, 'logs.replay', 'cancel');
    });
  }

  test('replay reports unavailable when the debugger cannot be made available', async () => {
    await drive(telemetry, { replayAvailable: () => false }, replay);
    assertSent(telemetry, 'logs.replay', 'unavailable');
  });
});
