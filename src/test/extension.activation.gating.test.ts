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
}) {
  const commands = new Map<string, RegisteredCommand>();
  const events: Array<{ name: string; props?: Record<string, string> }> = [];
  const setApiVersionCalls: string[] = [];
  const timeoutCallbacks: Array<() => Promise<void> | void> = [];
  const listOrgsCalls: boolean[] = [];
  const getOrgAuthCalls: Array<string | undefined> = [];
  const logViewerShows: Array<{ logId: string; filePath: string }> = [];
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];
  const errorMessages: string[] = [];

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

    constructor(_context: any) {}

    public hasResolvedView(): boolean {
      return false;
    }

    public async refresh(): Promise<void> {}

    public async sendOrgs(): Promise<void> {}

    public setSelectedOrg(_username: string): void {}

    public async tailLogs(): Promise<void> {}
  }

  class FakeTailViewProvider {
    public static viewType = 'sfLogTail';

    constructor(_context: any) {}
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
    './salesforce/http': {
      setApiVersion: (value?: string) => {
        if (value) {
          setApiVersionCalls.push(value);
        }
      },
      getApiVersion: () => '64.0',
      clearListCache: () => undefined
    },
    './utils/logger': {
      logInfo: () => undefined,
      logWarn: () => undefined,
      logError: () => undefined,
      showOutput: () => undefined,
      setTraceEnabled: () => undefined,
      disposeLogger: () => undefined
    },
    './utils/localize': {
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
    './utils/cacheManager': {
      CacheManager: {
        init: () => undefined,
        clearExpired: async () => undefined,
        delete: async () => undefined
      }
    },
    './utils/config': {
      getBooleanConfig: (key: string, fallback: boolean) => {
        if (key === 'sfLogs.cliCache.enabled') {
          return options.cliCacheEnabled ?? fallback;
        }
        return fallback;
      },
      affectsConfiguration: () => false
    },
    './utils/error': {
      getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
    },
    './salesforce/cli': {
      listOrgs: async (forceRefresh = false) => {
        listOrgsCalls.push(forceRefresh);
        return options.orgs ?? [];
      },
      getOrgAuth: async (username?: string) => {
        getOrgAuthCalls.push(username);
        return { username };
      }
    },
    './utils/workspace': {
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
    listOrgsCalls,
    getOrgAuthCalls,
    logViewerShows,
    infoMessages,
    warningMessages,
    errorMessages
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

    assert.deepEqual(harness.listOrgsCalls, [false]);
    assert.deepEqual(harness.getOrgAuthCalls, ['default@example.com']);
  });
});
