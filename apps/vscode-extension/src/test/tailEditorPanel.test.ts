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
    title: 'Electivus Apex Logs Tail',
    viewColumn: 1,
    webview: {},
    revealCount: 0,
    reveal() {
      this.revealCount += 1;
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

suite('TailEditorPanel', () => {
  test('creates a panel once and syncs the selected org when reusing it', async () => {
    const createdProviders: any[] = [];
    const panel = createPanel();

    class FakeTailProvider {
      selectedOrgs: Array<string | undefined> = [];
      syncedOrgs: Array<string | undefined> = [];
      resolvedPanels: any[] = [];

      constructor(_context: any) {
        createdProviders.push(this);
      }

      setSelectedOrg(org?: string): void {
        this.selectedOrgs.push(org);
      }

      async syncSelectedOrg(org?: string): Promise<void> {
        this.syncedOrgs.push(org);
      }

      onDidReadyTimeout(): { dispose(): void } {
        return createDisposable();
      }

      resolveWebviewPanel(nextPanel: any): void {
        this.resolvedPanels.push(nextPanel);
      }

      dispose(): void {}
    }

    const vscodeStub = {
      window: {
        createWebviewPanel: () => panel
      },
      ViewColumn: {
        Active: 1
      },
      Uri: {
        joinPath: (...parts: any[]) => parts
      }
    };

    const { TailEditorPanel } = proxyquireStrict('../panel/TailEditorPanel', {
      vscode: vscodeStub,
      '../provider/SfLogTailViewProvider': { SfLogTailViewProvider: FakeTailProvider },
      '../../../../src/utils/localize': {
        localize: (_key: string, defaultValue: string) => defaultValue
      }
    });

    const context = {
      extensionUri: {},
      subscriptions: [] as any[]
    };

    TailEditorPanel.initialize(context as any);
    await TailEditorPanel.show({ selectedOrg: 'tail-first@example.com' });
    await TailEditorPanel.show({ selectedOrg: 'tail-second@example.com' });

    assert.equal(createdProviders.length, 1, 'should create only one provider/controller');
    assert.deepEqual(createdProviders[0]?.selectedOrgs, ['tail-first@example.com']);
    assert.deepEqual(createdProviders[0]?.syncedOrgs, ['tail-second@example.com']);
    assert.equal(createdProviders[0]?.resolvedPanels.length, 1, 'should bind the editor panel once');
    assert.equal(panel.revealCount, 1, 'should reveal the existing panel on reopen');
  });

  test('clears the singleton after dispose so a new editor panel can be created', async () => {
    const createdProviders: any[] = [];
    const panels = [createPanel(), createPanel()];
    let panelIndex = 0;

    class FakeTailProvider {
      disposeCount = 0;

      constructor(_context: any) {
        createdProviders.push(this);
      }

      setSelectedOrg(_org?: string): void {}

      onDidReadyTimeout(): { dispose(): void } {
        return createDisposable();
      }

      resolveWebviewPanel(_panel: any): void {}

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

    const { TailEditorPanel } = proxyquireStrict('../panel/TailEditorPanel', {
      vscode: vscodeStub,
      '../provider/SfLogTailViewProvider': { SfLogTailViewProvider: FakeTailProvider },
      '../../../../src/utils/localize': {
        localize: (_key: string, defaultValue: string) => defaultValue
      }
    });

    const context = {
      extensionUri: {},
      subscriptions: [] as any[]
    };

    TailEditorPanel.initialize(context as any);
    await TailEditorPanel.show({ selectedOrg: 'tail-first@example.com' });
    panels[0]!.fireDispose();
    await TailEditorPanel.show({ selectedOrg: 'tail-second@example.com' });

    assert.equal(createdProviders.length, 2, 'should create a new provider after dispose');
    assert.equal(createdProviders[0]?.disposeCount, 1, 'should dispose the previous provider on panel close');
  });
});
