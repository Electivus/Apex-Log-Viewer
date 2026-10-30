import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

type FakePanel = ReturnType<typeof createPanel>;

function createPanel() {
  let onDispose: (() => void) | undefined;
  return {
    visible: true,
    revealCount: 0,
    reveal() {
      this.revealCount += 1;
    },
    dispose() {
      onDispose?.();
    },
    onDidDispose(listener: () => void) {
      onDispose = listener;
      return { dispose: () => undefined };
    },
    fireDispose() {
      onDispose?.();
    }
  };
}

class FakeController {
  selectedOrgs: Array<string | undefined> = [];
  syncedOrgs: Array<string | undefined> = [];
  resolvedPanels: FakePanel[] = [];
  recoveryCallbacks: Array<() => void | Promise<void>> = [];
  disposeCount = 0;

  setSelectedOrg(org?: string): void {
    this.selectedOrgs.push(org);
  }

  async syncSelectedOrg(org?: string): Promise<void> {
    this.syncedOrgs.push(org);
  }

  resolveWebviewPanel(panel: FakePanel, recover: () => void | Promise<void>): void {
    this.resolvedPanels.push(panel);
    this.recoveryCallbacks.push(recover);
  }

  getWebviewDiagnosticState() {
    return { surface: 'customLogs' as const };
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

function load(panels: FakePanel[]) {
  const controllers: FakeController[] = [];
  const created: Array<{ viewType: string; title: string; options: Record<string, unknown> }> = [];
  let index = 0;
  const vscodeStub = {
    window: {
      createWebviewPanel: (viewType: string, title: string, _show: unknown, options: Record<string, unknown>) => {
        created.push({ viewType, title, options });
        return panels[index++];
      }
    },
    ViewColumn: { Active: 1 },
    Uri: { joinPath: (...parts: unknown[]) => parts }
  };
  const { createSessionEditorPanel } = proxyquireStrict('../../panel/sessionEditorPanel', {
    vscode: vscodeStub
  }) as typeof import('../../panel/sessionEditorPanel');
  const editor = createSessionEditorPanel({
    viewType: 'test.editorPanel',
    title: () => 'Test Title',
    createController: () => {
      const controller = new FakeController();
      controllers.push(controller);
      return controller as never;
    }
  });
  editor.initialize({ extensionUri: {}, subscriptions: [] } as never);
  return { editor, controllers, created };
}

suite('Session editor panel', () => {
  test('does nothing before the extension context is known', async () => {
    const { editor, controllers } = load([createPanel()]);
    const bare = proxyquireStrict('../../panel/sessionEditorPanel', {
      vscode: { window: {}, ViewColumn: {}, Uri: {} }
    }) as typeof import('../../panel/sessionEditorPanel');
    const uninitialized = bare.createSessionEditorPanel({
      viewType: 'x',
      title: () => 'x',
      createController: () => ({}) as never
    });

    await uninitialized.show();

    assert.equal(uninitialized.getDiagnosticState(), undefined);
    assert.equal(controllers.length, 0);
    assert.equal(editor.getDiagnosticState(), undefined);
  });

  test('opens one tab, retains its context, and reuses it by revealing and syncing the org', async () => {
    const panel = createPanel();
    const { editor, controllers, created } = load([panel]);

    await editor.show({ selectedOrg: 'first@example.com' });
    await editor.show({ selectedOrg: 'second@example.com' });

    assert.equal(controllers.length, 1);
    assert.deepEqual(controllers[0]?.selectedOrgs, ['first@example.com']);
    assert.deepEqual(controllers[0]?.syncedOrgs, ['second@example.com']);
    assert.equal(controllers[0]?.resolvedPanels.length, 1);
    assert.equal(panel.revealCount, 1);
    assert.equal(created[0]?.viewType, 'test.editorPanel');
    assert.equal(created[0]?.title, 'Test Title');
    assert.equal(created[0]?.options.retainContextWhenHidden, true);
    assert.deepEqual(editor.getDiagnosticState(), { surface: 'customLogs' });
  });

  test('replaces a tab whose webview never became ready, once, through the controller recovery', async () => {
    const panels = [createPanel(), createPanel(), createPanel()];
    const { editor, controllers, created } = load(panels);
    await editor.show();

    await controllers[0]?.recoveryCallbacks[0]?.();
    await controllers[0]?.recoveryCallbacks[1]?.();

    assert.equal(created.length, 2, 'one replacement, not a retry loop');
    assert.deepEqual(controllers[0]?.resolvedPanels, [panels[0], panels[1]]);
    assert.equal(controllers[0]?.disposeCount, 0, 'replacing the tab keeps the controller');
  });

  test('closing the tab disposes the controller and the next show opens a fresh one', async () => {
    const panels = [createPanel(), createPanel()];
    const { editor, controllers } = load(panels);
    await editor.show();

    panels[0]!.fireDispose();
    await editor.show();

    assert.equal(controllers.length, 2);
    assert.equal(controllers[0]?.disposeCount, 1);
    assert.equal(controllers[1]?.disposeCount, 0);
  });
});
