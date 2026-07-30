import assert from 'assert/strict';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

function createDisposable() {
  return { dispose: () => undefined };
}

function createPanel() {
  let onDispose: (() => void) | undefined;
  return {
    active: true,
    visible: true,
    options: {},
    title: 'Electivus Apex Logs',
    viewColumn: 1,
    webview: {},
    revealCount: 0,
    reveal() {
      this.revealCount += 1;
    },
    dispose() {
      onDispose?.();
    },
    onDidDispose(listener: () => void) {
      onDispose = listener;
      return createDisposable();
    },
    onDidChangeViewState() {
      return createDisposable();
    },
    fireDispose() {
      onDispose?.();
    }
  };
}

suite('LogsEditorPanel', () => {
  test('creates a panel once and syncs the selected org when reusing it', async () => {
    const createdProviders: any[] = [];
    const panel = createPanel();
    const panelOptions: any[] = [];

    class FakeLogsProvider {
      selectedOrgs: Array<string | undefined> = [];
      syncedOrgs: Array<string | undefined> = [];
      resolvedPanels: any[] = [];
      recoveryCallbacks: Array<() => void | Promise<void>> = [];

      constructor(_context: any) {
        createdProviders.push(this);
      }

      setSelectedOrg(org?: string): void {
        this.selectedOrgs.push(org);
      }

      async syncSelectedOrg(org?: string): Promise<void> {
        this.syncedOrgs.push(org);
      }

      resolveWebviewPanel(nextPanel: any, recover: () => void | Promise<void>): void {
        this.resolvedPanels.push(nextPanel);
        this.recoveryCallbacks.push(recover);
      }

      dispose(): void {}
    }

    const vscodeStub = {
      window: {
        createWebviewPanel: (_viewType: string, _title: string, _showOptions: unknown, options: unknown) => {
          panelOptions.push(options);
          return panel;
        }
      },
      ViewColumn: {
        Active: 1
      },
      Uri: {
        joinPath: (...parts: any[]) => parts
      }
    };

    const { LogsEditorPanel } = proxyquireStrict('../panel/LogsEditorPanel', {
      vscode: vscodeStub,
      '../provider/SfLogsViewProvider': { SfLogsViewProvider: FakeLogsProvider },
      '../host/utils/localize': {
        localize: (_key: string, defaultValue: string) => defaultValue
      }
    });

    const context = {
      extensionUri: {},
      subscriptions: [] as any[]
    };

    LogsEditorPanel.initialize(context as any);
    await LogsEditorPanel.show({ selectedOrg: 'first@example.com' });
    await LogsEditorPanel.show({ selectedOrg: 'second@example.com' });

    assert.equal(createdProviders.length, 1, 'should create only one provider/controller');
    assert.deepEqual(createdProviders[0]?.selectedOrgs, ['first@example.com']);
    assert.deepEqual(createdProviders[0]?.syncedOrgs, ['second@example.com']);
    assert.equal(createdProviders[0]?.resolvedPanels.length, 1, 'should bind the editor panel once');
    assert.equal(panel.revealCount, 1, 'should reveal the existing panel on reopen');
    assert.equal(panelOptions[0]?.retainContextWhenHidden, true, 'logs editor should retain context while hidden');
  });

  test('replaces a timed-out editor through the bound host recovery capability', async () => {
    const createdProviders: any[] = [];
    const panels = [createPanel(), createPanel()];
    let panelIndex = 0;

    class FakeLogsProvider {
      resolvedPanels: any[] = [];
      recoveryCallbacks: Array<() => void | Promise<void>> = [];

      constructor(_context: any) {
        createdProviders.push(this);
      }

      setSelectedOrg(_org?: string): void {}

      resolveWebviewPanel(nextPanel: any, recover: () => void | Promise<void>): void {
        this.resolvedPanels.push(nextPanel);
        this.recoveryCallbacks.push(recover);
      }

      dispose(): void {}
    }

    const vscodeStub = {
      window: {
        createWebviewPanel: () => panels[panelIndex++]
      },
      ViewColumn: {
        Active: 1
      },
      Uri: {
        joinPath: (...parts: any[]) => parts
      }
    };

    const { LogsEditorPanel } = proxyquireStrict('../panel/LogsEditorPanel', {
      vscode: vscodeStub,
      '../provider/SfLogsViewProvider': { SfLogsViewProvider: FakeLogsProvider },
      '../host/utils/localize': {
        localize: (_key: string, defaultValue: string) => defaultValue
      }
    });

    const context = {
      extensionUri: {},
      subscriptions: [] as any[]
    };

    LogsEditorPanel.initialize(context as any);
    await LogsEditorPanel.show();
    await createdProviders[0]?.recoveryCallbacks[0]?.();

    assert.deepEqual(createdProviders[0]?.resolvedPanels, panels);
    assert.equal(panelIndex, 2, 'ready timeout should create one replacement panel');
  });

  test('clears the singleton after dispose so a new editor panel can be created', async () => {
    const createdProviders: any[] = [];
    const panels = [createPanel(), createPanel()];
    let panelIndex = 0;

    class FakeLogsProvider {
      disposeCount = 0;

      constructor(_context: any) {
        createdProviders.push(this);
      }

      setSelectedOrg(_org?: string): void {}

      resolveWebviewPanel(_panel: any, _recover: () => void | Promise<void>): void {}

      dispose(): void {
        this.disposeCount += 1;
      }
    }

    const vscodeStub = {
      window: {
        createWebviewPanel: () => panels[panelIndex++]
      },
      ViewColumn: {
        Active: 1
      },
      Uri: {
        joinPath: (...parts: any[]) => parts
      }
    };

    const { LogsEditorPanel } = proxyquireStrict('../panel/LogsEditorPanel', {
      vscode: vscodeStub,
      '../provider/SfLogsViewProvider': { SfLogsViewProvider: FakeLogsProvider },
      '../host/utils/localize': {
        localize: (_key: string, defaultValue: string) => defaultValue
      }
    });

    const context = {
      extensionUri: {},
      subscriptions: [] as any[]
    };

    LogsEditorPanel.initialize(context as any);
    await LogsEditorPanel.show({ selectedOrg: 'first@example.com' });
    panels[0]!.fireDispose();
    await LogsEditorPanel.show({ selectedOrg: 'second@example.com' });

    assert.equal(createdProviders.length, 2, 'should create a new provider after dispose');
    assert.equal(createdProviders[0]?.disposeCount, 1, 'should dispose the previous provider on panel close');
  });
});
