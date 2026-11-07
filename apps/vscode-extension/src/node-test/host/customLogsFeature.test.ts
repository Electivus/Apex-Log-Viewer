import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import { createMemento } from '../customLogsTestSupport';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const SETTING = 'electivus.apexLogViewer.customLogs.enabled';
const VIEW_ID = 'electivus.apexLogViewer.customLogsView';
const LONG_FIELD_SCHEME = 'electivus-custom-log';
const COMMANDS = [
  'electivus.apexLogViewer.customLogs.captureStatus',
  'electivus.apexLogViewer.customLogs.configure',
  'electivus.apexLogViewer.customLogs.openEditor',
  'electivus.apexLogViewer.customLogs.refresh'
];

type ConfigurationEvent = { affectsConfiguration(key: string): boolean };

class Disposable {
  constructor(private readonly onDispose: () => void) {}
  dispose(): void {
    this.onDispose();
  }
  static from(...items: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => items.forEach(item => item.dispose()));
  }
}

class TabInputText {
  constructor(readonly uri: { scheme: string; path: string }) {}
}

type Tab = { label: string; input: unknown };

const textTab = (scheme: string, path: string): Tab => ({
  label: `${scheme}:${path}`,
  input: new TabInputText({ scheme, path })
});

function load(options: { enabled: boolean; logsOrg?: string; tabGroups?: Tab[][] }) {
  const settings = new Map<string, unknown>([[SETTING, options.enabled]]);
  const listeners = new Set<(event: ConfigurationEvent) => void>();
  const views = new Map<string, { retainContextWhenHidden?: boolean }>();
  const commands = new Map<string, () => Promise<void>>();
  const executed: string[] = [];
  const events: string[] = [];
  const watchers = { started: 0, disposed: 0 };
  const documents = { registered: 0, disposed: 0 };
  const editor = {
    initialized: 0,
    closed: 0,
    shows: [] as Array<{ selectedOrg?: string } | undefined>,
    trackCapture: undefined as ((tab: never) => { dispose(): void }) | undefined
  };
  const viewer = { initialized: 0, closedAll: 0 };
  const configured: number[] = [];
  const statusItems: Array<{ shown: boolean; disposed: boolean; command?: string }> = [];
  const quickPick = { answer: undefined as string | undefined, offered: [] as string[] };
  const tabGroups = (options.tabGroups ?? []).map(tabs => ({ tabs }));
  const tabCloses = { requests: 0 };

  const vscodeStub = {
    Disposable,
    TabInputText,
    workspace: {
      onDidChangeConfiguration: (listener: (event: ConfigurationEvent) => void) => {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      },
      registerTextDocumentContentProvider: () => {
        documents.registered += 1;
        return { dispose: () => void (documents.disposed += 1) };
      },
      onDidCloseTextDocument: () => ({ dispose: () => undefined })
    },
    StatusBarAlignment: { Left: 1 },
    window: {
      tabGroups: {
        get all() {
          return tabGroups;
        },
        close: async (tabs: Tab[]) => {
          tabCloses.requests += 1;
          for (const group of tabGroups) {
            group.tabs = group.tabs.filter(tab => !tabs.includes(tab));
          }
          return true;
        }
      },
      createStatusBarItem: () => {
        const item = {
          shown: false,
          disposed: false,
          command: undefined as string | undefined,
          show: () => void (item.shown = true),
          hide: () => void (item.shown = false),
          dispose: () => void (item.disposed = true)
        };
        statusItems.push(item);
        return item;
      },
      showQuickPick: async (items: string[]) => {
        quickPick.offered = items;
        return quickPick.answer;
      },
      registerWebviewViewProvider: (id: string, _provider: unknown, registration: { webviewOptions: object }) => {
        assert.equal(views.has(id), false, `VS Code refuses to register ${id} twice`);
        views.set(id, registration.webviewOptions);
        return { dispose: () => void views.delete(id) };
      }
    },
    commands: {
      registerCommand: (id: string, handler: () => Promise<void>) => {
        assert.equal(commands.has(id), false, `VS Code refuses to register ${id} twice`);
        commands.set(id, handler);
        return { dispose: () => void commands.delete(id) };
      },
      executeCommand: async (id: string) => void executed.push(id)
    }
  };

  const telemetry = { safeSendEvent: (name: string) => void events.push(name) };

  // The real provider, so the project-file watcher it owns is the one the feature starts and stops.
  const { CustomLogsViewProvider } = proxyquireStrict('../../provider/CustomLogsViewProvider', {
    vscode: vscodeStub,
    '../host/utils/localize': { localize: (_key: string, message: string) => message },
    '../host/utils/logger': { logInfo: () => undefined, logWarn: () => undefined },
    '../host/utils/orgManager': { OrgManager: class {} },
    '../host/utils/responsiveness': { recordInboundMessage: () => undefined },
    '../host/utils/webviewHtml': { buildWebviewHtml: () => '' },
    '../host/utils/workspace': {
      findCustomLogsProjectDir: async () => undefined,
      onSfdxProjectFileChanged: () => {
        watchers.started += 1;
        return { dispose: () => void (watchers.disposed += 1) };
      }
    },
    '../host/utils/customLogDocuments': { openCustomLogDocument: async () => undefined },
    '../panel/CustomLogViewerPanel': { CustomLogViewerPanel: { show: async () => undefined } },
    '../runtime/runtimeClient': { runtimeClient: {} },
    '../shared/telemetry': telemetry,
    './webviewHost': {
      createWebviewViewHost: (view: unknown) => view,
      createWebviewPanelHost: (panel: unknown) => panel
    },
    './webviewSession': { createWebviewSession: () => ({ ready: false, dispose: () => undefined }) }
  }) as typeof import('../../provider/CustomLogsViewProvider');

  const { registerCustomLogsFeature } = proxyquireStrict('../../host/customLogsFeature', {
    vscode: vscodeStub,
    './utils/config': {
      getBooleanConfig: (key: string, fallback: boolean) => (settings.get(key) as boolean | undefined) ?? fallback,
      affectsConfiguration: (event: ConfigurationEvent, key: string) => event.affectsConfiguration(key)
    },
    './utils/customLogDocuments': proxyquireStrict('../../host/utils/customLogDocuments', { vscode: vscodeStub }),
    './customLogsStatusBar': proxyquireStrict('../../host/customLogsStatusBar', {
      vscode: vscodeStub,
      './customLogsCaptureStatus': proxyquireStrict('../../host/customLogsCaptureStatus', {
        './utils/localize': { localize: (_key: string, message: string) => message }
      }),
      './utils/localize': { localize: (_key: string, message: string) => message }
    }),
    './utils/customLogsConfig': { openCustomLogsConfig: async () => void configured.push(1) },
    './utils/error': { getErrorMessage: (error: unknown) => String(error) },
    './utils/logger': { logWarn: () => undefined },
    '../panel/CustomLogsEditorPanel': {
      CustomLogsEditorPanel: {
        initialize: (_context: unknown, track: (tab: never) => { dispose(): void }) => {
          editor.initialized += 1;
          editor.trackCapture = track;
        },
        close: () => void (editor.closed += 1),
        show: async (showOptions?: { selectedOrg?: string }) => void editor.shows.push(showOptions),
        getDiagnosticState: () => undefined
      }
    },
    '../panel/CustomLogViewerPanel': {
      CustomLogViewerPanel: {
        initialize: () => void (viewer.initialized += 1),
        closeAll: () => void (viewer.closedAll += 1)
      }
    },
    '../provider/CustomLogsViewProvider': { CustomLogsViewProvider },
    '../shared/telemetry': telemetry
  }) as typeof import('../../host/customLogsFeature');

  const feature = registerCustomLogsFeature(
    { extensionUri: {}, workspaceState: createMemento(), subscriptions: [] } as never,
    () => options.logsOrg
  );

  /** The user edits the setting; VS Code tells the extension which keys that touched. */
  const change = (key: string, value: unknown) => {
    settings.set(key, value);
    for (const listener of [...listeners]) {
      listener({ affectsConfiguration: candidate => candidate === key });
    }
  };

  return {
    feature,
    change,
    views,
    commands,
    executed,
    events,
    watchers,
    documents,
    editor,
    viewer,
    configured,
    listeners,
    statusItems,
    quickPick,
    tabCloses,
    openTabs: () => tabGroups.map(group => group.tabs.map(tab => tab.label))
  };
}

suite('Custom Logs feature switch', () => {
  test('creates nothing while the setting is off', () => {
    const host = load({ enabled: false });

    host.change('electivus.apexLogViewer.logging.trace', true);

    assert.deepEqual(host.watchers, { started: 0, disposed: 0 }, 'no sfdx-project.json watcher');
    assert.equal(host.views.size, 0, 'no view provider');
    assert.equal(host.commands.size, 0, 'no command to call core or send telemetry');
    assert.equal(host.documents.registered, 0);
    assert.deepEqual([host.editor.initialized, host.viewer.initialized], [0, 0]);
    assert.deepEqual(host.events, []);
    assert.deepEqual(host.feature.getWebviewDiagnosticStates(), []);
  });

  test('starts the watcher, the view and the commands when the setting turns on, without a reload', () => {
    const host = load({ enabled: false });

    host.change(SETTING, true);

    assert.deepEqual(host.watchers, { started: 1, disposed: 0 });
    assert.deepEqual([...host.views], [[VIEW_ID, { retainContextWhenHidden: true }]]);
    assert.deepEqual([...host.commands.keys()].sort(), COMMANDS);
    assert.equal(host.documents.registered, 1);
    assert.deepEqual(host.events, [], 'turning it on sends nothing by itself');
  });

  test('starts at activation when the setting is already on', () => {
    const host = load({ enabled: true });

    assert.deepEqual(host.watchers, { started: 1, disposed: 0 });
    assert.deepEqual([...host.views.keys()], [VIEW_ID]);
    assert.deepEqual([...host.commands.keys()].sort(), COMMANDS);
  });

  test('stops the watcher, the view, the commands and closes the open editor tab and viewers when it turns off', () => {
    const host = load({ enabled: true });

    host.change(SETTING, false);

    assert.deepEqual(host.watchers, { started: 1, disposed: 1 });
    assert.equal(host.views.size, 0);
    assert.equal(host.commands.size, 0);
    assert.equal(host.documents.disposed, 1);
    assert.equal(host.editor.closed, 1, 'the Custom Logs editor tab closes');
    assert.equal(host.viewer.closedAll, 1, 'the transaction viewers close');
    assert.deepEqual(host.feature.getWebviewDiagnosticStates(), []);
  });

  test('closes the long-field tabs in every group when it turns off, and no other editor', () => {
    const host = load({
      enabled: true,
      tabGroups: [
        [
          textTab('file', '/force-app/Example.cls'),
          textTab(LONG_FIELD_SCHEME, '/Message - Log-1 #1.txt'),
          { label: 'webview', input: { viewType: 'electivus.apexLogViewer.customLogViewer' } }
        ],
        [
          textTab(LONG_FIELD_SCHEME, '/Payload - Log-1.json'),
          textTab('untitled', '/Untitled-1'),
          { label: 'no input', input: undefined }
        ]
      ]
    });

    host.change(SETTING, false);

    assert.deepEqual(host.openTabs(), [
      ['file:/force-app/Example.cls', 'webview'],
      ['untitled:/Untitled-1', 'no input']
    ]);
  });

  test('closes a long-field tab left by an earlier extension host when it starts with the setting off', () => {
    const host = load({ enabled: false, tabGroups: [[textTab(LONG_FIELD_SCHEME, '/Message - Log-1 #1.txt')]] });

    assert.deepEqual(host.openTabs(), [[]]);
  });

  test('does not try to close the long-field tabs when the extension deactivates, because VS Code rejects it', () => {
    const host = load({ enabled: true, tabGroups: [[textTab(LONG_FIELD_SCHEME, '/Message - Log-1 #1.txt')]] });

    host.feature.dispose();

    assert.equal(host.tabCloses.requests, 0);
  });

  test('keeps the long-field tabs open while the setting stays on', () => {
    const host = load({ enabled: true, tabGroups: [[textTab(LONG_FIELD_SCHEME, '/Message - Log-1 #1.txt')]] });

    host.change('electivus.apexLogViewer.logging.trace', true);
    host.change(SETTING, true);

    assert.deepEqual(host.openTabs(), [[`${LONG_FIELD_SCHEME}:/Message - Log-1 #1.txt`]]);
  });

  test('the capture status item stays hidden without a capture, offers Show and Stop on click, and is disposed when the setting turns off', async () => {
    const host = load({ enabled: true });
    const [item] = host.statusItems;

    assert.equal(item?.shown, false);
    assert.equal(item?.command, 'electivus.apexLogViewer.customLogs.captureStatus');
    host.quickPick.answer = 'Show Custom Logs';
    await host.commands.get('electivus.apexLogViewer.customLogs.captureStatus')!();
    assert.deepEqual(host.quickPick.offered, ['Show Custom Logs', 'Stop capture']);
    assert.deepEqual(host.executed, ['electivus.apexLogViewer.customLogsView.focus']);

    host.change(SETTING, false);

    assert.equal(item?.disposed, true);
  });

  test('the item shows a capture of the editor tab, Show brings the tab forward and Stop stops it', async () => {
    const host = load({ enabled: true });
    const [item] = host.statusItems;
    const tab = {
      listener: undefined as ((status: unknown) => void) | undefined,
      stops: 0,
      onDidChangeCaptureStatus(listener: (status: unknown) => void) {
        this.listener = listener;
        listener(undefined);
        return { dispose: () => undefined };
      },
      stopByUser() {
        this.stops += 1;
        this.listener?.(undefined);
      }
    };

    host.editor.trackCapture!(tab as never);
    tab.listener!({ sourceLabel: 'App events', capture: { state: 'live', basis: 'quiet' } });
    assert.equal(item?.shown, true, 'a capture the editor tab started shows');

    host.quickPick.answer = 'Show Custom Logs';
    await host.commands.get('electivus.apexLogViewer.customLogs.captureStatus')!();
    assert.deepEqual(host.editor.shows, [undefined], 'Show reveals the tab, not the bottom view');
    assert.equal(host.executed.length, 0);

    host.quickPick.answer = 'Stop capture';
    await host.commands.get('electivus.apexLogViewer.customLogs.captureStatus')!();
    assert.equal(tab.stops, 1);
    assert.equal(item?.shown, false);
  });

  test('can be turned on again after it was turned off', () => {
    const host = load({ enabled: true });

    host.change(SETTING, false);
    host.change(SETTING, true);

    assert.deepEqual(host.watchers, { started: 2, disposed: 1 });
    assert.deepEqual([...host.views.keys()], [VIEW_ID]);
    assert.deepEqual([...host.commands.keys()].sort(), COMMANDS);
  });

  test('ignores a change event that repeats the current value', () => {
    const host = load({ enabled: false });

    host.change(SETTING, false);
    host.change(SETTING, true);
    host.change(SETTING, true);

    assert.equal(host.watchers.started, 1);
    assert.equal(host.editor.closed, 0);
  });

  test('stops everything and stops listening when the extension deactivates', () => {
    const host = load({ enabled: true });

    host.feature.dispose();

    assert.deepEqual(host.watchers, { started: 1, disposed: 1 });
    assert.equal(host.views.size, 0);
    assert.equal(host.commands.size, 0);
    assert.equal(host.listeners.size, 0);
  });

  test('keeps its commands working: the editor tab follows the org of the Logs panel', async () => {
    const host = load({ enabled: true, logsOrg: 'logs@example.com' });

    await host.commands.get('electivus.apexLogViewer.customLogs.openEditor')!();
    await host.commands.get('electivus.apexLogViewer.customLogs.refresh')!();
    await host.commands.get('electivus.apexLogViewer.customLogs.configure')!();

    assert.deepEqual(host.editor.shows, [{ selectedOrg: 'logs@example.com' }]);
    assert.deepEqual(host.executed, ['electivus.apexLogViewer.customLogsView.focus']);
    assert.equal(host.configured.length, 1);
    assert.deepEqual(host.events, [
      'command.customLogs.openEditor',
      'command.customLogs.refresh',
      'command.customLogs.configure'
    ]);
  });
});
