import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import type { CustomLogsCaptureStatus } from '../../host/customLogsCaptureStatus';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();
const localize = {
  localize: (_key: string, message: string, ...args: Array<string | number>) =>
    message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
};

/** A Custom Logs surface: the view or its editor tab, each with its own watcher of the capture. */
class FakeSurface {
  private readonly listeners = new Set<(status: CustomLogsCaptureStatus | undefined) => void>();
  status: CustomLogsCaptureStatus | undefined;
  stops = 0;
  reveals = 0;

  onDidChangeCaptureStatus(listener: (status: CustomLogsCaptureStatus | undefined) => void) {
    this.listeners.add(listener);
    listener(this.status);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  stopByUser(): void {
    this.stops += 1;
    this.set(undefined);
  }

  set(status: CustomLogsCaptureStatus | undefined): void {
    this.status = status;
    for (const listener of [...this.listeners]) {
      listener(status);
    }
  }

  readonly reveal = () => void (this.reveals += 1);
}

const live = (sourceLabel: string): CustomLogsCaptureStatus => ({
  sourceLabel,
  capture: { state: 'live', basis: 'quiet' }
});

function load() {
  const item = { text: '', tooltip: '', shown: false, disposed: false, command: undefined as string | undefined };
  const commands = new Map<string, () => Promise<void>>();
  const quickPick = { answer: undefined as string | undefined };
  const vscodeStub = {
    StatusBarAlignment: { Left: 1 },
    window: {
      createStatusBarItem: () =>
        Object.assign(item, {
          show: () => void (item.shown = true),
          hide: () => void (item.shown = false),
          dispose: () => void (item.disposed = true)
        }),
      showQuickPick: async () => quickPick.answer
    },
    commands: {
      registerCommand: (id: string, handler: () => Promise<void>) => {
        commands.set(id, handler);
        return { dispose: () => void commands.delete(id) };
      }
    }
  };
  const { registerCaptureStatusBar, CAPTURE_STATUS_COMMAND } = proxyquireStrict('../../host/customLogsStatusBar', {
    vscode: vscodeStub,
    './customLogsCaptureStatus': proxyquireStrict('../../host/customLogsCaptureStatus', {
      './utils/localize': localize
    }),
    './utils/localize': localize
  }) as typeof import('../../host/customLogsStatusBar');
  const statusBar = registerCaptureStatusBar();
  const click = async (answer: string) => {
    quickPick.answer = answer;
    await commands.get(CAPTURE_STATUS_COMMAND)!();
  };
  return { statusBar, item, commands, click };
}

suite('Custom Logs capture status bar item', () => {
  test('shows a capture of the editor tab while the view captures nothing', () => {
    const { statusBar, item } = load();
    const view = new FakeSurface();
    const tab = new FakeSurface();
    statusBar.track(view, view.reveal);
    statusBar.track(tab, tab.reveal);

    tab.set(live('App events'));

    assert.equal(item.shown, true);
    assert.equal(item.text, '$(broadcast) Custom Logs: App events · Live');
  });

  test('the view and the tab watching one source read as one capture, and different sources as a count', () => {
    const { statusBar, item } = load();
    const view = new FakeSurface();
    const tab = new FakeSurface();
    statusBar.track(view, view.reveal);
    statusBar.track(tab, tab.reveal);

    view.set(live('App events'));
    tab.set(live('App events'));
    assert.equal(item.text, '$(broadcast) Custom Logs: App events · Live');

    tab.set(live('Nebula events'));
    assert.equal(item.text, '$(broadcast) Custom Logs: 2 captures');
    assert.match(item.tooltip, /App events · Live\nNebula events · Live/);
  });

  test('Stop stops the capture of every surface, so a run they share ends', async () => {
    const { statusBar, item, click } = load();
    const view = new FakeSurface();
    const tab = new FakeSurface();
    const idle = new FakeSurface();
    statusBar.track(view, view.reveal);
    statusBar.track(tab, tab.reveal);
    statusBar.track(idle, idle.reveal);
    view.set(live('App events'));
    tab.set(live('App events'));

    await click('Stop capture');

    assert.deepEqual([view.stops, tab.stops], [1, 1]);
    assert.equal(idle.stops, 0, 'a surface without a capture keeps its strip as it is');
    assert.equal(item.shown, false);
  });

  test('Show brings forward the surface that captures', async () => {
    const { statusBar, click } = load();
    const view = new FakeSurface();
    const tab = new FakeSurface();
    statusBar.track(view, view.reveal);
    statusBar.track(tab, tab.reveal);
    tab.set(live('App events'));

    await click('Show Custom Logs');

    assert.deepEqual([view.reveals, tab.reveals], [0, 1]);
  });

  test('a surface that closes leaves the item, and the item leaves with the feature', () => {
    const { statusBar, item, commands } = load();
    const view = new FakeSurface();
    const tab = new FakeSurface();
    statusBar.track(view, view.reveal);
    const tabTracking = statusBar.track(tab, tab.reveal);
    tab.set(live('App events'));

    tabTracking.dispose();
    assert.equal(item.shown, false);

    statusBar.dispose();
    view.set(live('App events'));
    assert.equal(item.disposed, true);
    assert.equal(item.shown, false, 'a disposed item is never shown again');
    assert.equal(commands.size, 0);
  });
});
