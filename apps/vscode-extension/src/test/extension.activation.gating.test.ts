import assert from 'assert/strict';
import * as path from 'path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

type RegisteredCommand = (...args: any[]) => Promise<unknown> | unknown;

function createDisposable() {
  return { dispose: () => undefined };
}

function createContext() {
  return {
    subscriptions: [],
    globalState: {
      get: () => undefined,
      update: async () => undefined,
      keys: () => []
    }
  } as any;
}

function createExtensionHarness(options: {
  salesforceProject?: {
    workspaceRoot: string;
    projectFilePath: string;
    sourceApiVersion?: string;
    readErrorMessage?: string;
    parseErrorMessage?: string;
  };
  cliCacheEnabled?: boolean;
  appRoot?: string;
  activeDocument?: any;
  isApexLogDocument?: boolean;
  logId?: string;
  orgs?: Array<{ username: string; isDefaultUsername?: boolean }>;
  initialLogsSelectedOrg?: string;
  initialTailSelectedOrg?: string;
}) {
  const commands = new Map<string, RegisteredCommand>();
  const events: Array<{ name: string; props?: Record<string, string> }> = [];
  const setApiVersionCalls: string[] = [];
  const timeoutCallbacks: Array<() => Promise<void> | void> = [];
  const orgListCalls: boolean[] = [];
  const getOrgAuthCalls: Array<string | undefined> = [];
  const logViewerShows: Array<{ logId: string; filePath: string }> = [];
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];
  const errorMessages: string[] = [];
  const logsEditorShows: Array<{ selectedOrg?: string }> = [];
  const tailEditorShows: Array<{ selectedOrg?: string }> = [];
  const tailSyncSelectedOrgCalls: Array<string | undefined> = [];
  const tailRefreshViewStateCalls: number[] = [];
  const logsTailCalls: number[] = [];

  const vscodeStub = {
    version: '1.90.0',
    env: {
      appRoot: options.appRoot ?? '/usr/share/code'
    },
    workspace: {
      workspaceFolders: options.salesforceProject ? [{ uri: { fsPath: options.salesforceProject.workspaceRoot } }] : [],
      onDidChangeConfiguration: () => createDisposable(),
      openTextDocument: async () => options.activeDocument
    },
    window: {
      activeTextEditor: options.activeDocument ? { document: options.activeDocument } : undefined,
      registerWebviewViewProvider: () => createDisposable(),
      showWarningMessage: async (message: string) => {
        warningMessages.push(message);
        return undefined;
      },
      showErrorMessage: async (message: string) => {
        errorMessages.push(message);
        return undefined;
      },
      showInformationMessage: async (message: string) => {
        infoMessages.push(message);
        return undefined;
      }
    },
    commands: {
      registerCommand: (command: string, handler: RegisteredCommand) => {
        commands.set(command, handler);
        return createDisposable();
      },
      executeCommand: async () => undefined
    },
    languages: {
      registerCodeLensProvider: () => createDisposable()
    }
  };

  class FakeLogsViewProvider {
    public static viewType = 'sfLogViewer';
    private selectedOrg: string | undefined;

    constructor(_context: any) {
      this.selectedOrg = options.initialLogsSelectedOrg;
    }

    public hasResolvedView(): boolean {
      return false;
    }

    public async refresh(): Promise<void> {}

    public async sendOrgs(): Promise<void> {}

    public setSelectedOrg(username?: string): void {
      this.selectedOrg = username;
    }

    public getSelectedOrg(): string | undefined {
      return this.selectedOrg;
    }

    public async tailLogs(): Promise<void> {
      logsTailCalls.push(1);
    }

    public dispose(): void {}
  }

  class FakeTailViewProvider {
    public static viewType = 'sfLogTail';
    private selectedOrg: string | undefined;

    constructor(_context: any) {
      this.selectedOrg = options.initialTailSelectedOrg;
    }

    public getSelectedOrg(): string | undefined {
      return this.selectedOrg;
    }

    public setSelectedOrg(username?: string): void {
      this.selectedOrg = username;
    }

    public async syncSelectedOrg(username?: string): Promise<void> {
      tailSyncSelectedOrgCalls.push(username);
      this.selectedOrg = username;
    }

    public async refreshViewState(): Promise<void> {
      tailRefreshViewStateCalls.push(1);
    }

    public dispose(): void {}
  }

  class FakeCodeLensProvider {}

  const extension = proxyquireStrict('../extension', {
    vscode: vscodeStub,
    './provider/SfLogsViewProvider': { SfLogsViewProvider: FakeLogsViewProvider },
    './provider/SfLogTailViewProvider': { SfLogTailViewProvider: FakeTailViewProvider },
    './provider/ApexLogCodeLensProvider': { ApexLogCodeLensProvider: FakeCodeLensProvider },
    './panel/LogViewerPanel': {
      LogViewerPanel: {
        initialize: () => undefined,
        show: async (args: { logId: string; filePath: string }) => {
          logViewerShows.push(args);
        }
      }
    },
    './panel/DebugFlagsPanel': {
      DebugFlagsPanel: {
        initialize: () => undefined
      }
    },
    './panel/LogsEditorPanel': {
      LogsEditorPanel: {
        initialize: () => undefined,
        show: async (options?: { selectedOrg?: string }) => {
          logsEditorShows.push(options ?? {});
        }
      }
    },
    './panel/TailEditorPanel': {
      TailEditorPanel: {
        initialize: () => undefined,
        show: async (options?: { selectedOrg?: string }) => {
          tailEditorShows.push(options ?? {});
        }
      }
    },
    '../../../src/salesforce/http': {
      setApiVersion: (value?: string) => {
        if (value) {
          setApiVersionCalls.push(value);
        }
      },
      getApiVersion: () => '64.0',
      clearListCache: () => undefined
    },
    '../../../src/utils/logger': {
      logInfo: () => undefined,
      logWarn: () => undefined,
      logError: () => undefined,
      showOutput: () => undefined,
      setTraceEnabled: () => undefined,
      disposeLogger: () => undefined
    },
    '../../../src/utils/localize': {
      localize: (_key: string, defaultValue: string, ...args: Array<string | number>) =>
        defaultValue.replace(/\{(\d+)\}/g, (_match: string, index: string) => String(args[Number(index)] ?? ''))
    },
    './shared/telemetry': {
      activateTelemetry: () => undefined,
      safeSendEvent: (name: string, props?: Record<string, string>) => {
        events.push({ name, props });
      },
      safeSendException: () => undefined,
      disposeTelemetry: () => undefined
    },
    '../../../src/utils/cacheManager': {
      CacheManager: {
        init: () => undefined,
        clearExpired: async () => undefined,
        delete: async () => undefined
      }
    },
    '../../../src/utils/config': {
      getBooleanConfig: (key: string, fallback: boolean) => {
        if (key === 'sfLogs.cliCache.enabled') {
          return options.cliCacheEnabled ?? fallback;
        }
        return fallback;
      },
      affectsConfiguration: () => false
    },
    '../../../src/utils/error': {
      getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
    },
    './runtime/runtimeClient': {
      runtimeClient: {
        orgList: async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}) => {
          orgListCalls.push(forceRefresh);
          return options.orgs ?? [];
        },
        getOrgAuth: async ({ username }: { username?: string } = {}) => {
          getOrgAuthCalls.push(username);
          return { username };
        }
      }
    },
    '../../../src/utils/workspace': {
      findSalesforceProjectInfo: async () => options.salesforceProject,
      isApexLogDocument: () => options.isApexLogDocument ?? true,
      getLogIdFromLogFilePath: () => options.logId
    }
  });

  return {
    extension,
    commands,
    events,
    setApiVersionCalls,
    timeoutCallbacks,
    orgListCalls,
    getOrgAuthCalls,
    logViewerShows,
    infoMessages,
    warningMessages,
    errorMessages,
    logsEditorShows,
    tailEditorShows,
    tailSyncSelectedOrgCalls,
    tailRefreshViewStateCalls,
    logsTailCalls
  };
}

suite('extension activation gating', () => {
  let originalSetTimeout: typeof globalThis.setTimeout;

  setup(() => {
    originalSetTimeout = globalThis.setTimeout;
  });

  teardown(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  test('keeps on-demand commands available without a Salesforce project and skips project preload', async () => {
    const filePath = path.join(process.cwd(), 'tmp', 'standalone.log');
    const activeDocument = {
      isClosed: false,
      uri: { scheme: 'file', fsPath: filePath },
      fileName: filePath
    };
    const harness = createExtensionHarness({
      activeDocument,
      logId: '07L000000000123'
    });
    (globalThis as any).setTimeout = (callback: () => Promise<void> | void) => {
      harness.timeoutCallbacks.push(callback);
      return 1;
    };

    await harness.extension.activate(createContext());

    assert.deepEqual(harness.setApiVersionCalls, []);
    assert.equal(harness.timeoutCallbacks.length, 0, 'should not schedule CLI preload outside Salesforce projects');
    assert.ok(harness.commands.has('sfLogs.refresh'), 'refresh command should stay registered');
    assert.ok(harness.commands.has('sfLogs.openLogsEditor'), 'open logs editor command should stay registered');
    assert.ok(harness.commands.has('sfLogs.openTailEditor'), 'open tail editor command should stay registered');
    assert.ok(harness.commands.has('sfLogs.openLogInViewer'), 'open log viewer command should stay registered');
    assert.ok(harness.commands.has('sfLogs.troubleshootWebview'), 'webview troubleshooting command should stay registered');

    const activationEvent = harness.events.find(event => event.name === 'extension.activate');
    assert.equal(activationEvent?.props?.hasSalesforceProject, 'false');

    await harness.commands.get('sfLogs.openLogInViewer')!();

    assert.deepEqual(harness.logViewerShows, [{ logId: '07L000000000123', filePath }]);
    assert.deepEqual(harness.warningMessages, []);
    assert.deepEqual(harness.errorMessages, []);
  });

  test('applies sourceApiVersion and schedules CLI preload when a Salesforce project is present', async () => {
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot: path.join(process.cwd(), 'workspace-salesforce'),
        projectFilePath: path.join(process.cwd(), 'workspace-salesforce', 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      orgs: [
        { username: 'first@example.com' },
        { username: 'default@example.com', isDefaultUsername: true }
      ]
    });
    (globalThis as any).setTimeout = (callback: () => Promise<void> | void) => {
      harness.timeoutCallbacks.push(callback);
      return 1;
    };

    await harness.extension.activate(createContext());

    assert.deepEqual(harness.setApiVersionCalls, ['60.0']);
    assert.equal(harness.timeoutCallbacks.length, 1, 'should schedule CLI preload for Salesforce projects');

    const activationEvent = harness.events.find(event => event.name === 'extension.activate');
    assert.equal(activationEvent?.props?.hasSalesforceProject, 'true');

    await harness.timeoutCallbacks[0]!();

    assert.deepEqual(harness.orgListCalls, [false]);
  });

  test('syncs the selected logs org into tail before refreshing the tail view', async () => {
    const harness = createExtensionHarness({
      initialLogsSelectedOrg: 'worker@example.com',
      initialTailSelectedOrg: 'other@example.com'
    });

    await harness.extension.activate(createContext());
    await harness.commands.get('sfLogs.tail')!();

    assert.deepEqual(harness.tailSyncSelectedOrgCalls, ['worker@example.com']);
    assert.equal(harness.logsTailCalls.length, 1, 'should open the tail view once');
    assert.equal(harness.tailRefreshViewStateCalls.length, 1, 'should refresh tail after syncing the org');
  });
});
