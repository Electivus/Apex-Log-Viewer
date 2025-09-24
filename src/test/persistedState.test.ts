import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import { PREFETCH_LOG_BODIES_KEY, SELECTED_ORG_KEY } from '../shared/constants';

function makeContext(options: { prefetch?: boolean } = {}) {
  const getCalls: string[] = [];
  const updates: { key: string; value: any }[] = [];
  const context = {
    extensionUri: vscode.Uri.file(path.resolve('.')),
    subscriptions: [] as vscode.Disposable[],
    globalState: {
      get: (key: string) => {
        getCalls.push(key);
        if (key === PREFETCH_LOG_BODIES_KEY) {
          return options.prefetch ?? false;
        }
        if (key === SELECTED_ORG_KEY) {
          return 'persisted-org';
        }
        return undefined;
      },
      update: async (key: string, value: any) => {
        updates.push({ key, value });
      }
    }
  } as unknown as vscode.ExtensionContext;
  return { context, capturedGetKey: () => getCalls[getCalls.length - 1], getCalls: () => [...getCalls], updates };
}

suite('Persisted org state', () => {
  test('SfLogsViewProvider restores and persists selected org', () => {
    const { context, capturedGetKey, updates, getCalls } = makeContext();
    const provider = new SfLogsViewProvider(context);
    assert.equal(capturedGetKey(), SELECTED_ORG_KEY);
    assert.ok(getCalls().includes(PREFETCH_LOG_BODIES_KEY));
    assert.equal((provider as any).orgManager.getSelectedOrg(), 'persisted-org');
    provider.setSelectedOrg('next-org');
    assert.equal(updates[0]?.key, SELECTED_ORG_KEY);
    assert.equal(updates[0]?.value, 'next-org');
    assert.equal((provider as any).orgManager.getSelectedOrg(), 'next-org');
  });

  test('SfLogTailViewProvider restores and persists selected org', () => {
    const { context, capturedGetKey, updates } = makeContext();
    const provider = new SfLogTailViewProvider(context);
    assert.equal(capturedGetKey(), SELECTED_ORG_KEY);
    assert.equal((provider as any).selectedOrg, 'persisted-org');
    (provider as any).setSelectedOrg('next-org');
    assert.equal(updates[0]?.key, SELECTED_ORG_KEY);
    assert.equal(updates[0]?.value, 'next-org');
    assert.equal((provider as any).selectedOrg, 'next-org');
  });

  test('SfLogsViewProvider restores and persists prefetch preference', async () => {
    const { context, updates } = makeContext({ prefetch: true });
    const provider = new SfLogsViewProvider(context);
    assert.equal((provider as any).prefetchLogBodies, true);

    const originalWarning = vscode.window.showWarningMessage;
    (vscode.window as any).showWarningMessage = async () => 'Disable';
    try {
      await (provider as any).setPrefetchLogBodies(false);
    } finally {
      (vscode.window as any).showWarningMessage = originalWarning;
    }

    const persisted = updates.find(update => update.key === PREFETCH_LOG_BODIES_KEY);
    assert.ok(persisted, 'expected prefetch preference to be persisted');
    assert.equal(persisted?.value, false);
    assert.equal((provider as any).prefetchLogBodies, false);
  });
});
