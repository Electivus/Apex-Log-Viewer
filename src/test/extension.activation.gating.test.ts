import assert from 'assert/strict';
import * as path from 'path';
import proxyquire from 'proxyquire';
import type { PendingLaunchRequest } from '../shared/newWindowLaunch';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

type RegisteredCommand = (...args: any[]) => Promise<unknown> | unknown;
type CommandCall = { command: string; args: unknown[] };
type RegisteredPanelSerializer = {
  viewType: string;
  serializer: {
    deserializeWebviewPanel: (panel: unknown, state: unknown) => Promise<void> | void;
  };
};

function createDisposable() {
  return { dispose: () => undefined };
}

function createExtensionHarness(options: {
  salesforceProject?: {
    workspaceRoot: string;
    projectFilePath: string;
    sourceApiVersion?: string;
    readErrorMessage?: string;
    parseErrorMessage?: string;
  };
  workspaceRoot?: string;
  workspaceFile?: string;
  cliCacheEnabled?: boolean;
  appRoot?: string;
  activeDocument?: any;
  isApexLogDocument?: boolean;
  logId?: string;
  orgs?: Array<{ username: string; isDefaultUsername?: boolean }>;
  globalState?: Record<string, unknown>;
  openFolderError?: Error | string;
  commandErrors?: Record<string, Error | string>;
  selectedOrg?: string;
  tailSelectedOrg?: string;
  logsEditorAlreadyOpen?: boolean;
  logsViewResolved?: boolean;
  beforeConsumePendingLaunch?: (state: {
    commands: Map<string, RegisteredCommand>;
    registeredCodeLensProviders: number;
  }) => Promise<void> | void;
}) {
  const commands = new Map<string, RegisteredCommand>();
  const events: Array<{ name: string; props?: Record<string, string> }> = [];
  const setApiVersionCalls: string[] = [];
  let resetApiVersionCalls = 0;
  const timeoutCallbacks: Array<() => Promise<void> | void> = [];
  const listOrgsCalls: boolean[] = [];
  const getOrgAuthCalls: Array<string | undefined> = [];
  const setSelectedOrgCalls: string[] = [];
  const tailRestoreCalls: string[] = [];
  const openLogsEditorCalls: string[] = [];
  const sendOrgsCalls: string[] = [];
  const logsRefreshCalls: string[] = [];
  const logViewerShows: Array<{ logId: string; filePath: string }> = [];
  const debugFlagsShows: Array<{ selectedOrg?: string; sourceView?: 'logs' | 'tail' }> = [];
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];
  const errorMessages: string[] = [];
  const globalStateUpdates: Array<{ key: string; value: unknown }> = [];
  const globalStateGetCalls: string[] = [];
  const commandCalls: CommandCall[] = [];
  const panelSerializers: RegisteredPanelSerializer[] = [];
  const workspaceFolderChangeListeners: Array<() => Promise<void> | void> = [];
  const projectFileWatchers: Array<{
    disposed: boolean;
    createListeners: Array<() => Promise<void> | void>;
    changeListeners: Array<() => Promise<void> | void>;
    deleteListeners: Array<() => Promise<void> | void>;
  }> = [];
  let registeredCodeLensProviders = 0;
  let restoreLogsEditorPanelCalls = 0;
  let currentSalesforceProject = options.salesforceProject;
  const defaultWorkspaceRoot = options.workspaceRoot ?? options.salesforceProject?.workspaceRoot;
  const workspaceFolders = defaultWorkspaceRoot
    ? [
        {
          uri: {
            fsPath: defaultWorkspaceRoot,
            toString: () => `file://${defaultWorkspaceRoot}`
          }
        }
      ]
    : [];
  const effectiveWorkspaceFile = options.workspaceFile
    ? {
        toString: () => options.workspaceFile!
      }
    : undefined;

  const state = new Map<string, unknown>(Object.entries(options.globalState ?? {}));
  const getState = (key: string) => state.get(key);
  const setState = (key: string, value: unknown) => {
    globalStateUpdates.push({ key, value });
    if (value === undefined) {
      state.delete(key);
    } else {
      state.set(key, value);
    }
  };

  const vscodeStub = {
    version: '1.102.0',
    env: {
      appRoot: options.appRoot ?? '/usr/share/code'
    },
    RelativePattern: class RelativePattern {
      constructor(
        public readonly base: unknown,
        public readonly pattern: string
      ) {}
    },
    workspace: {
      workspaceFile: effectiveWorkspaceFile,
      workspaceFolders,
      textDocuments: options.activeDocument ? [options.activeDocument] : [],
      onDidChangeConfiguration: () => createDisposable(),
      onDidChangeWorkspaceFolders: (listener: () => Promise<void> | void) => {
        workspaceFolderChangeListeners.push(listener);
        return createDisposable();
      },
      createFileSystemWatcher: () => {
        const watcher = {
          disposed: false,
          createListeners: [] as Array<() => Promise<void> | void>,
          changeListeners: [] as Array<() => Promise<void> | void>,
          deleteListeners: [] as Array<() => Promise<void> | void>
        };
        projectFileWatchers.push(watcher);
        return {
          onDidCreate: (listener: () => Promise<void> | void) => {
            watcher.createListeners.push(listener);
            return createDisposable();
          },
          onDidChange: (listener: () => Promise<void> | void) => {
            watcher.changeListeners.push(listener);
            return createDisposable();
          },
          onDidDelete: (listener: () => Promise<void> | void) => {
            watcher.deleteListeners.push(listener);
            return createDisposable();
          },
          dispose: () => {
            watcher.disposed = true;
          }
        };
      },
      openTextDocument: async () => options.activeDocument
    },
    window: {
      activeTextEditor: options.activeDocument ? { document: options.activeDocument } : undefined,
      registerWebviewViewProvider: () => createDisposable(),
      registerWebviewPanelSerializer: (viewType: string, serializer: RegisteredPanelSerializer['serializer']) => {
        panelSerializers.push({ viewType, serializer });
        return createDisposable();
      },
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
    Uri: {
      parse: (value: string) => ({
        value,
        toString: () => value
      })
    },
    commands: {
      registerCommand: (command: string, handler: RegisteredCommand) => {
        commands.set(command, handler);
        return createDisposable();
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        commandCalls.push({ command, args });
        const commandError = options.commandErrors?.[command];
        if (commandError) {
          throw commandError instanceof Error ? commandError : new Error(String(commandError));
        }
        if (command === 'vscode.openFolder' && options.openFolderError) {
          throw options.openFolderError instanceof Error ? options.openFolderError : new Error(String(options.openFolderError));
        }
        return undefined;
      }
    },
    languages: {
      registerCodeLensProvider: () => {
        registeredCodeLensProviders += 1;
        return createDisposable();
      }
    }
  };

  class FakeLogsViewProvider {
    public static viewType = 'sfLogViewer';
    public static editorPanelViewType = 'sfLogViewer.logsEditor';
    private selectedOrg = options.selectedOrg ?? '';
    private editorAlreadyOpen = options.logsEditorAlreadyOpen ?? false;
    private viewResolved = options.logsViewResolved ?? false;

    constructor(_context: any) {}

    public hasResolvedView(): boolean {
      return this.viewResolved;
    }

    public hasEditorPanel(): boolean {
      return this.editorAlreadyOpen;
    }

    public async refresh(): Promise<void> {
      logsRefreshCalls.push(this.selectedOrg);
    }

    public async sendOrgs(): Promise<void> {
      sendOrgsCalls.push(this.selectedOrg);
    }

    public setSelectedOrg(username?: string): void {
      const normalized = typeof username === 'string' ? username.trim() : '';
      this.selectedOrg = normalized;
      setSelectedOrgCalls.push(normalized);
    }

    public getSelectedOrg(): string {
      return this.selectedOrg;
    }

    public async showEditor(showOptions?: { refreshOnReveal?: boolean }): Promise<void> {
      openLogsEditorCalls.push(this.selectedOrg);
      const wasAlreadyOpen = this.editorAlreadyOpen;
      this.editorAlreadyOpen = true;
      if (wasAlreadyOpen && showOptions?.refreshOnReveal) {
        await this.refresh();
      }
    }

    public async restoreEditorPanel(): Promise<void> {
      restoreLogsEditorPanelCalls += 1;
    }

    public async tailLogs(): Promise<void> {
      await vscodeStub.commands.executeCommand('workbench.view.extension.salesforceTailPanel');
      await vscodeStub.commands.executeCommand('workbench.viewsService.openView', 'sfLogTail');
    }
  }

  class FakeTailViewProvider {
    public static viewType = 'sfLogTail';
    private selectedOrg = options.tailSelectedOrg;

    public async restoreSelectedOrg(username?: string): Promise<void> {
      this.selectedOrg = username?.trim() || undefined;
      tailRestoreCalls.push(this.selectedOrg ?? '');
    }

    public getSelectedOrg(): string | undefined {
      return this.selectedOrg;
    }

    constructor(_context: any) {}
  }

  class FakeCodeLensProvider {}

  class FakeNewWindowLaunchService {
    constructor(private readonly launchContext: any) {}

    public async launchInNewWindow(
      request: Omit<PendingLaunchRequest, 'version' | 'createdAt' | 'nonce'>
    ): Promise<void> {
      const pendingRequest: PendingLaunchRequest = {
        ...request,
        version: 1,
        createdAt: Date.now(),
        nonce: 'test-launch'
      } as PendingLaunchRequest;

      await this.launchContext.globalState.update('pendingNewWindowLaunch', pendingRequest);
      try {
        await this.launchContext.openFolder?.(pendingRequest.workspaceTarget);
      } catch (error) {
        await this.launchContext.globalState.update('pendingNewWindowLaunch', undefined);
        throw error;
      }
    }

    public async consumePendingLaunch(handlers: {
      restoreWindowContext: (request: { selectedOrg?: string }) => Promise<void> | void;
      openLogs: (request: { selectedOrg?: string }) => Promise<void> | void;
      openTail: (request: { selectedOrg?: string }) => Promise<void> | void;
      openDebugFlags: (request: { selectedOrg?: string; sourceView?: 'logs' | 'tail' }) => Promise<void> | void;
      openLogViewer: (request: { selectedOrg?: string; logId: string; filePath: string }) => Promise<void> | void;
    }): Promise<void> {
      await options.beforeConsumePendingLaunch?.({ commands, registeredCodeLensProviders });
      const request = this.launchContext.globalState.get('pendingNewWindowLaunch') as PendingLaunchRequest | undefined;
      if (!request) {
        return;
      }

      await this.launchContext.globalState.update('pendingNewWindowLaunch', undefined);
      await handlers.restoreWindowContext({ selectedOrg: request.selectedOrg });

      switch (request.kind) {
        case 'logs':
          await handlers.openLogs({ selectedOrg: request.selectedOrg });
          break;
        case 'tail':
          await handlers.openTail({ selectedOrg: request.selectedOrg });
          break;
        case 'debugFlags':
          await handlers.openDebugFlags({ selectedOrg: request.selectedOrg, sourceView: request.sourceView });
          break;
        case 'logViewer':
          await handlers.openLogViewer({
            selectedOrg: request.selectedOrg,
            logId: request.logId,
            filePath: request.filePath
          });
          break;
      }
    }
  }

  const extension = proxyquireStrict('../extension', {
    vscode: vscodeStub,
    './provider/SfLogsViewProvider': { SfLogsViewProvider: FakeLogsViewProvider },
    './provider/SfLogTailViewProvider': { SfLogTailViewProvider: FakeTailViewProvider },
    './provider/ApexLogCodeLensProvider': { ApexLogCodeLensProvider: FakeCodeLensProvider },
    './services/NewWindowLaunchService': { NewWindowLaunchService: FakeNewWindowLaunchService },
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
        initialize: () => undefined,
        show: async (showOptions?: { selectedOrg?: string; sourceView?: 'logs' | 'tail' }) => {
          debugFlagsShows.push({ selectedOrg: showOptions?.selectedOrg, sourceView: showOptions?.sourceView });
        }
      }
    },
    './salesforce/http': {
      setApiVersion: (value?: string) => {
        if (value) {
          setApiVersionCalls.push(value);
        }
      },
      resetApiVersion: () => {
        resetApiVersionCalls += 1;
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
      findSalesforceProjectInfo: async () => currentSalesforceProject,
      isApexLogDocument: () => options.isApexLogDocument ?? true,
      getLogIdFromLogFilePath: () => options.logId,
      getCurrentWorkspaceTarget: () => {
        const workspaceRoot = workspaceFolders?.[0]?.uri?.fsPath;
        if (options.workspaceFile && effectiveWorkspaceFile) {
          return { type: 'workspaceFile', uri: effectiveWorkspaceFile.toString() };
        }
        if (!workspaceRoot) {
          return undefined;
        }
        return { type: 'folder', uri: `file://${workspaceRoot}` };
      }
    }
  });

  return {
    extension,
    commands,
    events,
    setApiVersionCalls,
    resetApiVersionCalls: () => resetApiVersionCalls,
    timeoutCallbacks,
    listOrgsCalls,
    getOrgAuthCalls,
    setSelectedOrgCalls,
    tailRestoreCalls,
    openLogsEditorCalls,
    sendOrgsCalls,
    logsRefreshCalls,
    debugFlagsShows,
    logViewerShows,
    infoMessages,
    warningMessages,
    errorMessages,
    commandCalls,
    panelSerializers,
    restoreLogsEditorPanelCalls: () => restoreLogsEditorPanelCalls,
    registeredCodeLensProviders: () => registeredCodeLensProviders,
    setSalesforceProject: (next: typeof options.salesforceProject) => {
      currentSalesforceProject = next;
    },
    fireWorkspaceFoldersChanged: async () => {
      for (const listener of workspaceFolderChangeListeners) {
        await listener();
      }
    },
    fireProjectFileCreated: async () => {
      for (const watcher of projectFileWatchers) {
        if (watcher.disposed) {
          continue;
        }
        for (const listener of watcher.createListeners) {
          await listener();
        }
      }
    },
    fireProjectFileChanged: async () => {
      for (const watcher of projectFileWatchers) {
        if (watcher.disposed) {
          continue;
        }
        for (const listener of watcher.changeListeners) {
          await listener();
        }
      }
    },
    fireProjectFileDeleted: async () => {
      for (const watcher of projectFileWatchers) {
        if (watcher.disposed) {
          continue;
        }
        for (const listener of watcher.deleteListeners) {
          await listener();
        }
      }
    },
    globalStateUpdates,
    globalStateGetCalls,
    context: {
      subscriptions: [],
      globalState: {
        get: (key: string) => {
          globalStateGetCalls.push(key);
          return getState(key);
        },
        update: async (key: string, value: unknown) => {
          setState(key, value);
        },
        keys: () => Array.from(state.keys())
      }
    },
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

    await harness.extension.activate(harness.context);

    assert.deepEqual(harness.setApiVersionCalls, []);
    assert.equal(harness.timeoutCallbacks.length, 0, 'should not schedule CLI preload outside Salesforce projects');
    assert.ok(harness.commands.has('sfLogs.refresh'), 'refresh command should stay registered');
    assert.ok(harness.commands.has('sfLogs.openLogInViewer'), 'open log viewer command should stay registered');
    assert.ok(harness.commands.has('sfLogs.openLogsInNewWindow'), 'open logs in new window should stay registered');
    assert.ok(
      harness.commands.has('sfLogs.openLogsInNewWindowFromLogsView'),
      'logs view toolbar new-window command should stay registered'
    );
    assert.ok(harness.commands.has('sfLogs.openTailInNewWindow'), 'open tail in new window should stay registered');
    assert.ok(harness.commands.has('sfLogs.openDebugFlagsInNewWindow'), 'open debug flags in new window should stay registered');
    assert.ok(
      harness.commands.has('sfLogs.openLogInViewerInNewWindow'),
      'open log viewer in new window should stay registered'
    );
    assert.ok(harness.commands.has('sfLogs.troubleshootWebview'), 'webview troubleshooting command should stay registered');
    assert.equal(harness.panelSerializers.length, 1, 'logs editor serializer should stay registered');
    assert.equal(harness.panelSerializers[0]?.viewType, 'sfLogViewer.logsEditor');

    const activationEvent = harness.events.find(event => event.name === 'extension.activate');
    assert.equal(activationEvent?.props?.hasSalesforceProject, 'false');
    assert.deepEqual(
      harness.commandCalls.find(call => call.command === 'setContext')?.args,
      ['sfLogs.canOpenLogViewerInNewWindow', false]
    );

    await harness.commands.get('sfLogs.openLogInViewer')!();

    assert.deepEqual(harness.logViewerShows, [{ logId: '07L000000000123', filePath }]);
    assert.deepEqual(harness.warningMessages, []);
    assert.deepEqual(harness.errorMessages, []);
  });

  test('registers a serializer for the logs editor panel and restores through the provider', async () => {
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot: path.join(process.cwd(), 'workspace-salesforce'),
        projectFilePath: path.join(process.cwd(), 'workspace-salesforce', 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      }
    });

    await harness.extension.activate(harness.context);

    const serializer = harness.panelSerializers.find(entry => entry.viewType === 'sfLogViewer.logsEditor');
    assert.ok(serializer, 'expected the logs editor webview serializer to be registered');

    await serializer.serializer.deserializeWebviewPanel({}, undefined);

    assert.equal(harness.restoreLogsEditorPanelCalls(), 1);
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

    await harness.extension.activate(harness.context);

    assert.deepEqual(harness.setApiVersionCalls, ['60.0']);
    assert.equal(harness.timeoutCallbacks.length, 1, 'should schedule CLI preload for Salesforce projects');

    const activationEvent = harness.events.find(event => event.name === 'extension.activate');
    assert.equal(activationEvent?.props?.hasSalesforceProject, 'true');
    assert.deepEqual(
      harness.commandCalls.find(call => call.command === 'setContext')?.args,
      ['sfLogs.canOpenLogViewerInNewWindow', true]
    );

    await harness.timeoutCallbacks[0]!();

    assert.deepEqual(harness.listOrgsCalls, [false]);
    assert.deepEqual(harness.getOrgAuthCalls, ['default@example.com']);
  });

  test('recomputes Salesforce workspace gating when workspace folders change', async () => {
    const plainWorkspaceRoot = path.join(process.cwd(), 'workspace-plain');
    const harness = createExtensionHarness({
      workspaceRoot: plainWorkspaceRoot,
      activeDocument: {
        isClosed: false,
        uri: { scheme: 'file', fsPath: path.join(plainWorkspaceRoot, 'example.log') },
        fileName: path.join(plainWorkspaceRoot, 'example.log')
      },
      logId: '07L000000000456'
    });

    await harness.extension.activate(harness.context);

    assert.deepEqual(
      harness.commandCalls.filter(call => call.command === 'setContext').map(call => call.args),
      [['sfLogs.canOpenLogViewerInNewWindow', false]]
    );

    harness.setSalesforceProject({
      workspaceRoot: plainWorkspaceRoot,
      projectFilePath: path.join(plainWorkspaceRoot, 'sfdx-project.json'),
      sourceApiVersion: '60.0'
    });
    await harness.fireWorkspaceFoldersChanged();

    assert.deepEqual(
      harness.commandCalls.filter(call => call.command === 'setContext').map(call => call.args),
      [
        ['sfLogs.canOpenLogViewerInNewWindow', false],
        ['sfLogs.canOpenLogViewerInNewWindow', true]
      ]
    );

    await harness.commands.get('sfLogs.openTailInNewWindow')!();
    assert.equal(
      harness.globalStateUpdates.some(update => update.key === 'pendingNewWindowLaunch'),
      true,
      'tail new-window flow should start working after a Salesforce folder is added'
    );

    harness.setSalesforceProject(undefined);
    await harness.fireWorkspaceFoldersChanged();

    assert.deepEqual(
      harness.commandCalls.filter(call => call.command === 'setContext').map(call => call.args),
      [
        ['sfLogs.canOpenLogViewerInNewWindow', false],
        ['sfLogs.canOpenLogViewerInNewWindow', true],
        ['sfLogs.canOpenLogViewerInNewWindow', false]
      ]
    );

    await harness.commands.get('sfLogs.openLogInViewerInNewWindow')!();
    assert.equal(
      harness.warningMessages.at(-1),
      'Electivus Apex Logs: Open the log viewer in a Salesforce workspace before using this action.'
    );
  });

  test('recomputes Salesforce workspace gating when sfdx-project.json is created or deleted', async () => {
    const plainWorkspaceRoot = path.join(process.cwd(), 'workspace-plain');
    const harness = createExtensionHarness({
      workspaceRoot: plainWorkspaceRoot,
      activeDocument: {
        isClosed: false,
        uri: { scheme: 'file', fsPath: path.join(plainWorkspaceRoot, 'example.log') },
        fileName: path.join(plainWorkspaceRoot, 'example.log')
      },
      logId: '07L000000000457'
    });

    await harness.extension.activate(harness.context);

    assert.deepEqual(
      harness.commandCalls.filter(call => call.command === 'setContext').map(call => call.args),
      [['sfLogs.canOpenLogViewerInNewWindow', false]]
    );

    harness.setSalesforceProject({
      workspaceRoot: plainWorkspaceRoot,
      projectFilePath: path.join(plainWorkspaceRoot, 'sfdx-project.json'),
      sourceApiVersion: '61.0'
    });
    await harness.fireProjectFileCreated();

    assert.deepEqual(
      harness.commandCalls.filter(call => call.command === 'setContext').map(call => call.args),
      [
        ['sfLogs.canOpenLogViewerInNewWindow', false],
        ['sfLogs.canOpenLogViewerInNewWindow', true]
      ]
    );
    assert.deepEqual(harness.setApiVersionCalls, ['61.0']);

    await harness.commands.get('sfLogs.openTailInNewWindow')!();
    assert.equal(
      harness.globalStateUpdates.some(update => update.key === 'pendingNewWindowLaunch'),
      true,
      'tail new-window flow should start working after sfdx-project.json is created'
    );

    harness.setSalesforceProject(undefined);
    await harness.fireProjectFileDeleted();

    assert.deepEqual(
      harness.commandCalls.filter(call => call.command === 'setContext').map(call => call.args),
      [
        ['sfLogs.canOpenLogViewerInNewWindow', false],
        ['sfLogs.canOpenLogViewerInNewWindow', true],
        ['sfLogs.canOpenLogViewerInNewWindow', false]
      ]
    );

    await harness.commands.get('sfLogs.openLogInViewerInNewWindow')!();
    assert.equal(
      harness.warningMessages.at(-1),
      'Electivus Apex Logs: Open the log viewer in a Salesforce workspace before using this action.'
    );
  });

  test('resets the API version when the workspace loses sourceApiVersion', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '61.0'
      }
    });

    await harness.extension.activate(harness.context);

    assert.deepEqual(harness.setApiVersionCalls, ['61.0']);
    assert.equal(harness.resetApiVersionCalls(), 0);

    harness.setSalesforceProject({
      workspaceRoot,
      projectFilePath: path.join(workspaceRoot, 'sfdx-project.json')
    });
    await harness.fireProjectFileChanged();

    assert.deepEqual(harness.setApiVersionCalls, ['61.0']);
    assert.equal(harness.resetApiVersionCalls(), 1);
    assert.deepEqual(
      harness.commandCalls.filter(call => call.command === 'setContext').map(call => call.args),
      [
        ['sfLogs.canOpenLogViewerInNewWindow', true],
        ['sfLogs.canOpenLogViewerInNewWindow', true]
      ]
    );
  });

  test('consumes pending logViewer requests on activation', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const request: PendingLaunchRequest = {
      version: 1,
      kind: 'logViewer',
      workspaceTarget: { type: 'folder', uri: `file://${workspaceRoot}` },
      createdAt: Date.now(),
      nonce: 'req-001',
      logId: '07L000000000123',
      filePath: path.join(process.cwd(), 'package.json'),
      selectedOrg: 'org-from-pending@example.com'
    };
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      globalState: { pendingNewWindowLaunch: request }
    });
    await harness.extension.activate(harness.context);
    await Promise.resolve();

    assert.deepEqual(harness.logViewerShows, [{ logId: request.logId, filePath: request.filePath }]);
    assert.deepEqual(harness.globalStateUpdates, [{ key: 'pendingNewWindowLaunch', value: undefined }]);
    assert.deepEqual(harness.globalStateGetCalls.filter(call => call === 'pendingNewWindowLaunch'), ['pendingNewWindowLaunch']);
    assert.deepEqual(harness.tailRestoreCalls, ['org-from-pending@example.com']);
    assert.deepEqual(harness.warningMessages, []);
    assert.deepEqual(harness.errorMessages, []);
  });

  test('registers commands and CodeLens before starting pending launch restore', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const request: PendingLaunchRequest = {
      version: 1,
      kind: 'logViewer',
      workspaceTarget: { type: 'folder', uri: `file://${workspaceRoot}` },
      createdAt: Date.now(),
      nonce: 'req-order-001',
      logId: '07L000000000789',
      filePath: path.join(process.cwd(), 'package.json')
    };
    let consumeSawRegistrations: {
      openLogInViewer: boolean;
      showOutput: boolean;
      troubleshootWebview: boolean;
      codeLensProviders: number;
    } | undefined;
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      globalState: { pendingNewWindowLaunch: request },
      beforeConsumePendingLaunch: ({ commands, registeredCodeLensProviders }) => {
        consumeSawRegistrations = {
          openLogInViewer: commands.has('sfLogs.openLogInViewer'),
          showOutput: commands.has('sfLogs.showOutput'),
          troubleshootWebview: commands.has('sfLogs.troubleshootWebview'),
          codeLensProviders: registeredCodeLensProviders
        };
      }
    });

    await harness.extension.activate(harness.context);

    assert.deepEqual(consumeSawRegistrations, {
      openLogInViewer: true,
      showOutput: true,
      troubleshootWebview: true,
      codeLensProviders: 1
    });
    assert.equal(harness.registeredCodeLensProviders(), 1);
  });

  test('consumes pending tail requests on activation without auto-starting tail', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const request: PendingLaunchRequest = {
      version: 1,
      kind: 'tail',
      workspaceTarget: { type: 'folder', uri: `file://${workspaceRoot}` },
      createdAt: Date.now(),
      nonce: 'req-tail-001',
      selectedOrg: 'tail-from-pending@example.com',
      sourceView: 'tail'
    };
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      globalState: { pendingNewWindowLaunch: request }
    });

    await harness.extension.activate(harness.context);

    assert.deepEqual(harness.tailRestoreCalls, ['tail-from-pending@example.com']);
    assert.deepEqual(
      harness.commandCalls.filter(call => call.command !== 'setContext').map(call => call.command),
      ['workbench.view.extension.salesforceTailPanel', 'workbench.viewsService.openView']
    );
    assert.equal(
      harness.commandCalls.some(call => call.command === 'sfLogs.tail'),
      false,
      'pending tail restore should reveal the tail view directly instead of re-entering the tail command'
    );
  });

  test('opens the logs editor and moves it into a new window without persisting launch state', async () => {
    const harness = createExtensionHarness({
      workspaceFile: undefined
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogsInNewWindow')!();

    assert.deepEqual(harness.openLogsEditorCalls, ['']);
    assert.deepEqual(harness.warningMessages, []);
    assert.equal(
      harness.globalStateUpdates.some(update => update.key === 'pendingNewWindowLaunch'),
      false,
      'should not persist pending launch request for the logs editor move flow'
    );
    assert.deepEqual(
      harness.commandCalls.filter(call => call.command !== 'setContext').map(call => call.command),
      ['workbench.action.moveEditorToNewWindow']
    );
  });

  test('reuses the currently selected org when opening logs in a new window', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      selectedOrg: 'selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogsInNewWindow')!();

    assert.deepEqual(harness.openLogsEditorCalls, ['selected@example.com']);
    assert.deepEqual(
      harness.commandCalls.filter(call => call.command !== 'setContext').map(call => call.command),
      ['workbench.action.moveEditorToNewWindow']
    );
  });

  test('refreshes the originating logs view when opening logs in a new window for another org', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      selectedOrg: 'logs@example.com',
      tailSelectedOrg: 'tail@example.com',
      logsViewResolved: true
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogsInNewWindow')!();

    assert.deepEqual(harness.setSelectedOrgCalls, ['tail@example.com']);
    assert.deepEqual(harness.sendOrgsCalls, ['tail@example.com']);
    assert.deepEqual(harness.logsRefreshCalls, ['tail@example.com']);
    assert.deepEqual(harness.openLogsEditorCalls, ['tail@example.com']);
  });

  test('posts updated org metadata when reseeding an open logs editor without the sidebar view', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      selectedOrg: 'logs@example.com',
      tailSelectedOrg: 'tail@example.com',
      logsEditorAlreadyOpen: true
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogsInNewWindow')!();

    assert.deepEqual(harness.setSelectedOrgCalls, ['tail@example.com']);
    assert.deepEqual(harness.sendOrgsCalls, ['tail@example.com']);
    assert.deepEqual(harness.logsRefreshCalls, ['tail@example.com']);
    assert.deepEqual(harness.openLogsEditorCalls, ['tail@example.com']);
  });

  test('falls back to the tail org when opening logs in a new window before logs has selected one', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogsInNewWindow')!();

    assert.deepEqual(harness.openLogsEditorCalls, ['tail-selected@example.com']);
    assert.deepEqual(
      harness.commandCalls.filter(call => call.command !== 'setContext').map(call => call.command),
      ['workbench.action.moveEditorToNewWindow']
    );
  });

  test('prefers the tail org when opening logs in a new window after tail diverges from logs', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      selectedOrg: 'logs-selected@example.com',
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogsInNewWindow')!();

    assert.deepEqual(harness.openLogsEditorCalls, ['tail-selected@example.com']);
    assert.deepEqual(
      harness.commandCalls.filter(call => call.command !== 'setContext').map(call => call.command),
      ['workbench.action.moveEditorToNewWindow']
    );
  });

  test('prefers the logs org when opening logs in a new window from the logs view toolbar action', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      selectedOrg: 'logs-selected@example.com',
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogsInNewWindowFromLogsView')!();

    assert.deepEqual(harness.openLogsEditorCalls, ['logs-selected@example.com']);
    assert.deepEqual(
      harness.commandCalls.filter(call => call.command !== 'setContext').map(call => call.command),
      ['workbench.action.moveEditorToNewWindow']
    );
  });

  test('refreshes an existing logs editor after reseeding it to a different org', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      selectedOrg: 'logs-selected@example.com',
      tailSelectedOrg: 'tail-selected@example.com',
      logsEditorAlreadyOpen: true
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogsInNewWindow')!();

    assert.deepEqual(harness.openLogsEditorCalls, ['tail-selected@example.com']);
    assert.deepEqual(harness.logsRefreshCalls, ['tail-selected@example.com']);
  });

  test('propagates move-into-new-window failures for logs editor flow', async () => {
    const harness = createExtensionHarness({
      selectedOrg: 'selected@example.com',
      commandErrors: {
        'workbench.action.moveEditorToNewWindow': new Error('Cannot move editor')
      }
    });

    await harness.extension.activate(harness.context);

    const openLogsInNewWindow = harness.commands.get('sfLogs.openLogsInNewWindow');
    assert.ok(openLogsInNewWindow);
    await assert.rejects(async () => openLogsInNewWindow(), /Cannot move editor/);

    assert.deepEqual(harness.openLogsEditorCalls, ['selected@example.com']);
    assert.equal(
      harness.globalStateUpdates.some(update => update.key === 'pendingNewWindowLaunch'),
      false,
      'logs editor move flow should not touch pending launch state on failure'
    );
    assert.deepEqual(harness.warningMessages, []);
  });

  test('uses the current tail org when opening tail in a new window', async () => {
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot: path.join(process.cwd(), 'workspace-salesforce'),
        projectFilePath: path.join(process.cwd(), 'workspace-salesforce', 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      selectedOrg: 'logs-selected@example.com',
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openTailInNewWindow')!();

    assert.equal(
      (harness.globalStateUpdates.find(update => update.key === 'pendingNewWindowLaunch')?.value as PendingLaunchRequest | undefined)
        ?.selectedOrg,
      'tail-selected@example.com'
    );
  });

  test('falls back to the logs org when opening tail in a new window before tail has selected one', async () => {
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot: path.join(process.cwd(), 'workspace-salesforce'),
        projectFilePath: path.join(process.cwd(), 'workspace-salesforce', 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      selectedOrg: 'logs-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openTailInNewWindow')!();

    assert.equal(
      (harness.globalStateUpdates.find(update => update.key === 'pendingNewWindowLaunch')?.value as PendingLaunchRequest | undefined)
        ?.selectedOrg,
      'logs-selected@example.com'
    );
  });

  test('warns instead of launching tail in a new window when the workspace is not a Salesforce project', async () => {
    const harness = createExtensionHarness({
      workspaceRoot: path.join(process.cwd(), 'workspace-plain'),
      selectedOrg: 'logs-selected@example.com',
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openTailInNewWindow')!();

    assert.equal(
      harness.warningMessages.at(-1),
      'Electivus Apex Logs: Open a Salesforce workspace before opening Tail in a new window.'
    );
    assert.equal(
      harness.globalStateUpdates.some(update => update.key === 'pendingNewWindowLaunch'),
      false,
      'tail new-window flow should not persist a pending launch outside a Salesforce workspace'
    );
  });

  test('falls back to the tail org when opening debug flags in a new window before logs has selected one', async () => {
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot: path.join(process.cwd(), 'workspace-salesforce'),
        projectFilePath: path.join(process.cwd(), 'workspace-salesforce', 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openDebugFlagsInNewWindow')!();

    const pendingRequest = harness.globalStateUpdates.find(update => update.key === 'pendingNewWindowLaunch')
      ?.value as PendingLaunchRequest | undefined;
    assert.equal(pendingRequest?.selectedOrg, 'tail-selected@example.com');
    assert.equal(pendingRequest?.sourceView, 'tail');
  });

  test('prefers the tail org and source when opening debug flags in a new window after tail diverges from logs', async () => {
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot: path.join(process.cwd(), 'workspace-salesforce'),
        projectFilePath: path.join(process.cwd(), 'workspace-salesforce', 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      selectedOrg: 'logs-selected@example.com',
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openDebugFlagsInNewWindow')!();

    const pendingRequest = harness.globalStateUpdates.find(update => update.key === 'pendingNewWindowLaunch')
      ?.value as PendingLaunchRequest | undefined;
    assert.equal(pendingRequest?.selectedOrg, 'tail-selected@example.com');
    assert.equal(pendingRequest?.sourceView, 'tail');
  });

  test('warns instead of launching debug flags in a new window when the workspace is not a Salesforce project', async () => {
    const harness = createExtensionHarness({
      workspaceRoot: path.join(process.cwd(), 'workspace-plain'),
      selectedOrg: 'logs-selected@example.com',
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openDebugFlagsInNewWindow')!();

    assert.equal(
      harness.warningMessages.at(-1),
      'Electivus Apex Logs: Open a Salesforce workspace before opening Debug Flags in a new window.'
    );
    assert.equal(
      harness.globalStateUpdates.some(update => update.key === 'pendingNewWindowLaunch'),
      false,
      'debug flags new-window flow should not persist a pending launch outside a Salesforce workspace'
    );
  });

  test('falls back to the tail org when opening log viewer in a new window before logs has selected one', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const filePath = path.join(process.cwd(), 'tmp', 'tail-selected.log');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      activeDocument: {
        isClosed: false,
        uri: { scheme: 'file', fsPath: filePath },
        fileName: filePath
      },
      logId: '07L000000000999',
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogInViewerInNewWindow')!();

    const pendingRequest = harness.globalStateUpdates.find(update => update.key === 'pendingNewWindowLaunch')
      ?.value as PendingLaunchRequest | undefined;
    assert.equal(pendingRequest?.kind, 'logViewer');
    assert.equal(pendingRequest?.selectedOrg, 'tail-selected@example.com');
    assert.equal(pendingRequest?.logId, '07L000000000999');
    assert.equal(pendingRequest?.filePath, filePath);
  });

  test('prefers the tail org when opening log viewer in a new window after tail diverges from logs', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const filePath = path.join(process.cwd(), 'tmp', 'tail-current.log');
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      activeDocument: {
        isClosed: false,
        uri: { scheme: 'file', fsPath: filePath },
        fileName: filePath
      },
      logId: '07L000000001000',
      selectedOrg: 'logs-selected@example.com',
      tailSelectedOrg: 'tail-selected@example.com'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogInViewerInNewWindow')!();

    const pendingRequest = harness.globalStateUpdates.find(update => update.key === 'pendingNewWindowLaunch')
      ?.value as PendingLaunchRequest | undefined;
    assert.equal(pendingRequest?.kind, 'logViewer');
    assert.equal(pendingRequest?.selectedOrg, 'tail-selected@example.com');
    assert.equal(pendingRequest?.logId, '07L000000001000');
    assert.equal(pendingRequest?.filePath, filePath);
  });

  test('warns instead of launching log viewer in a new window when no Salesforce project is present', async () => {
    const filePath = path.join(process.cwd(), 'tmp', 'standalone.log');
    const harness = createExtensionHarness({
      activeDocument: {
        isClosed: false,
        uri: { scheme: 'file', fsPath: filePath },
        fileName: filePath
      },
      logId: '07L000000001001'
    });

    await harness.extension.activate(harness.context);

    await harness.commands.get('sfLogs.openLogInViewerInNewWindow')!();

    assert.equal(
      harness.warningMessages.at(-1),
      'Electivus Apex Logs: Open the log viewer in a Salesforce workspace before using this action.'
    );
    assert.equal(
      harness.globalStateUpdates.some(update => update.key === 'pendingNewWindowLaunch'),
      false,
      'standalone log-viewer flow should not persist a pending new-window launch outside a Salesforce workspace'
    );
  });

  test('swallows pending launch restore failures so activation can continue', async () => {
    const workspaceRoot = path.join(process.cwd(), 'workspace-salesforce');
    const request: PendingLaunchRequest = {
      version: 1,
      kind: 'tail',
      workspaceTarget: { type: 'folder', uri: `file://${workspaceRoot}` },
      createdAt: Date.now(),
      nonce: 'req-tail-error-001',
      selectedOrg: 'tail-from-pending@example.com',
      sourceView: 'tail'
    };
    const harness = createExtensionHarness({
      salesforceProject: {
        workspaceRoot,
        projectFilePath: path.join(workspaceRoot, 'sfdx-project.json'),
        sourceApiVersion: '60.0'
      },
      globalState: { pendingNewWindowLaunch: request },
      commandErrors: {
        'workbench.view.extension.salesforceTailPanel': new Error('Tail restore failed')
      }
    });

    await harness.extension.activate(harness.context);

    assert.deepEqual(harness.tailRestoreCalls, ['tail-from-pending@example.com']);
    assert.deepEqual(harness.globalStateUpdates, [{ key: 'pendingNewWindowLaunch', value: undefined }]);
    assert.equal(
      harness.commands.has('sfLogs.troubleshootWebview'),
      true,
      'activation should continue registering commands after a pending launch restore failure'
    );
    assert.deepEqual(harness.errorMessages, [
      'Electivus Apex Logs: Failed to restore the requested surface in the new window. Tail restore failed'
    ]);
  });
});
