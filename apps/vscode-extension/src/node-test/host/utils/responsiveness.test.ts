import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';
import type { HostResponsivenessMeasurements } from '../../../host/utils/responsiveness';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

interface LoggedLine {
  readonly level: 'info' | 'trace';
  readonly line: string;
}

interface SentEvent {
  readonly name: string;
  readonly properties?: Record<string, string>;
  readonly measurements?: Record<string, number>;
}

function loadResponsiveness(extensionHost: { remoteName?: string; uiKind: number } = { uiKind: 1 }) {
  const logged: LoggedLine[] = [];
  const events: SentEvent[] = [];
  const responsiveness = proxyquireStrict('../../../host/utils/responsiveness', {
    vscode: { env: extensionHost, UIKind: { Desktop: 1, Web: 2 } },
    './logger': {
      logInfo: (line: string) => logged.push({ level: 'info', line }),
      logTrace: (line: string) => logged.push({ level: 'trace', line })
    },
    '../../shared/telemetry': {
      safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) =>
        events.push({ name, properties, measurements })
    }
  }) as typeof import('../../../host/utils/responsiveness');
  return { responsiveness, logged, events };
}

function createHarness(startAt: number) {
  const { responsiveness, logged } = loadResponsiveness();
  const clock = { now: startAt };
  const sent: HostResponsivenessMeasurements[] = [];
  const loopDelayNs: Record<number, number> = { 50: 21_000_000, 99: 140_400_000 };
  const monitor = responsiveness.createResponsivenessMonitor({
    now: () => clock.now,
    loopDelay: { percentile: percentile => loopDelayNs[percentile] ?? 0, max: 520_600_000, reset: () => undefined },
    send: measurements => sent.push(measurements)
  });
  return { monitor, clock, logged, sent };
}

suite('host responsiveness', () => {
  test('measures a message sent at t=1000 and handled at t=1300 as a 300 ms queue wait', () => {
    const { monitor, clock, logged, sent } = createHarness(1000);

    clock.now = 1300;
    monitor.record('logs', { type: 'refresh', sentAt: 1000 });
    monitor.flush();

    assert.deepEqual(logged, [{ level: 'info', line: 'Logs: refresh waited 300 ms in the extension host queue' }]);
    assert.deepEqual(sent, [
      {
        windowMs: 300,
        messageCount: 1,
        waitP50Ms: 300,
        waitP90Ms: 300,
        waitMaxMs: 300,
        loopP50Ms: 1,
        loopP99Ms: 120,
        loopMaxMs: 501
      }
    ]);
  });

  test('logs waits under 250 ms at trace level and never echoes an unknown message type', () => {
    const { monitor, clock, logged } = createHarness(0);

    clock.now = 5000;
    monitor.record('tail', { type: 'tailStart', sentAt: 4751 });
    monitor.record('debugFlags', { type: 'debugFlagsApply\n[info] forged', sentAt: 4990 });
    monitor.record('logViewer', { type: 'logViewerReady', sentAt: 4750 });

    assert.deepEqual(logged, [
      { level: 'trace', line: 'Tail: tailStart waited 249 ms in the extension host queue' },
      { level: 'trace', line: 'DebugFlags: unknown waited 10 ms in the extension host queue' },
      { level: 'info', line: 'LogViewer: logViewerReady waited 250 ms in the extension host queue' }
    ]);
  });

  test('discards unstamped messages, negative waits, and waits above ten minutes', () => {
    const { monitor, clock, logged, sent } = createHarness(0);

    clock.now = 1_000_000;
    monitor.record('logs', { type: 'refresh' });
    monitor.record('logs', { type: 'refresh', sentAt: 1_000_001 });
    monitor.record('logs', { type: 'refresh', sentAt: 399_999 });
    monitor.record('logs', { type: 'loadMore', sentAt: 400_000 });
    monitor.flush();

    assert.deepEqual(logged, [{ level: 'info', line: 'Logs: loadMore waited 600000 ms in the extension host queue' }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.messageCount, 1);
  });

  test('one flush sends exactly one event with percentiles of the window samples', () => {
    const { monitor, clock, sent } = createHarness(10_000);

    clock.now = 20_000;
    for (const waitMs of [1000, 90, 10, 80, 20, 70, 30, 60, 40, 50]) {
      monitor.record('logs', { type: 'searchQuery', sentAt: 20_000 - waitMs });
    }
    clock.now = 310_000;
    monitor.flush();

    assert.deepEqual(sent, [
      {
        windowMs: 300_000,
        messageCount: 10,
        waitP50Ms: 50,
        waitP90Ms: 90,
        waitMaxMs: 1000,
        loopP50Ms: 1,
        loopP99Ms: 120,
        loopMaxMs: 501
      }
    ]);
  });

  test('an empty window sends nothing and restarts the window', () => {
    const { monitor, clock, sent } = createHarness(0);

    clock.now = 300_000;
    monitor.flush();
    const sentByEmptyWindow = sent.length;

    clock.now = 400_000;
    monitor.record('tail', { type: 'tailStop', sentAt: 399_995 });
    clock.now = 600_000;
    monitor.flush();

    assert.equal(sentByEmptyWindow, 0);
    assert.deepEqual(
      sent.map(measurements => [measurements.windowMs, measurements.messageCount, measurements.waitMaxMs]),
      [[300_000, 1, 5]]
    );
  });

  test('keeps percentiles to the first 1000 samples while count and max cover every message', () => {
    const { monitor, clock, sent } = createHarness(0);

    clock.now = 10_000;
    for (let index = 0; index < 1000; index += 1) {
      monitor.record('logs', { type: 'searchQuery', sentAt: 9_999 });
    }
    monitor.record('logs', { type: 'searchQuery', sentAt: 9_100 });
    monitor.flush();

    assert.deepEqual(
      sent.map(measurements => [measurements.messageCount, measurements.waitP90Ms, measurements.waitMaxMs]),
      [[1001, 1, 900]]
    );
  });

  test('records nothing on remote or web extension hosts and reports local desktop waits as host.responsiveness', () => {
    const realNow = Date.now;
    const runHost = (extensionHost: { remoteName?: string; uiKind: number }) => {
      const loaded = loadResponsiveness(extensionHost);
      Date.now = () => 1000;
      loaded.responsiveness.startResponsivenessMonitor();
      Date.now = () => 1300;
      loaded.responsiveness.recordInboundMessage('logs', { type: 'refresh', sentAt: 1000 });
      loaded.responsiveness.stopResponsivenessMonitor();
      return loaded;
    };
    try {
      const remote = runHost({ remoteName: 'ssh-remote', uiKind: 1 });
      const web = runHost({ uiKind: 2 });
      const local = runHost({ uiKind: 1 });

      assert.deepEqual([remote.logged, remote.events, web.logged, web.events], [[], [], [], []]);
      assert.deepEqual(local.logged, [
        { level: 'info', line: 'Logs: refresh waited 300 ms in the extension host queue' }
      ]);
      const [event] = local.events;
      const { loopP50Ms, loopP99Ms, loopMaxMs, ...waits } = event?.measurements ?? {};
      assert.deepEqual(
        { name: event?.name, properties: event?.properties, waits },
        {
          name: 'host.responsiveness',
          properties: { outcome: 'ok' },
          waits: { windowMs: 300, messageCount: 1, waitP50Ms: 300, waitP90Ms: 300, waitMaxMs: 300 }
        }
      );
      assert.equal(local.events.length, 1);
      assert.deepEqual([loopP50Ms, loopP99Ms, loopMaxMs].map(Number.isFinite), [true, true, true]);
    } finally {
      Date.now = realNow;
    }
  });
});
