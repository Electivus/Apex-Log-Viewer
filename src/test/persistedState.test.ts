import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';

function makeContext() {
  let capturedGetKey: string | undefined;
  const updates: { key: string; value: any }[] = [];
  const context = {
    extensionUri: vscode.Uri.file(path.resolve('.')),
    subscriptions: [] as vscode.Disposable[],
    globalState: {
      get: (key: string) => {
        capturedGetKey = key;
        return 'persisted-org';
      },
      update: async (key: string, value: any) => {
        updates.push({ key, value });
      }
    }
  } as unknown as vscode.ExtensionContext;
  return { context, capturedGetKey: () => capturedGetKey, updates };
}

suite('Persisted org state', () => {
  test('SfLogsViewProvider no longer touches globalState for org persistence', () => {
    const { context, capturedGetKey, updates } = makeContext();
    const provider = new SfLogsViewProvider(context);
    assert.equal(capturedGetKey(), undefined);
    assert.equal((provider as any).orgManager.getSelectedOrg(), undefined);
    provider.setSelectedOrg('next-org');
    assert.equal(updates.length, 0);
    assert.equal((provider as any).orgManager.getSelectedOrg(), 'next-org');
  });

  test('SfLogTailViewProvider keeps org selection in-memory only', () => {
    const { context, capturedGetKey, updates } = makeContext();
    const provider = new SfLogTailViewProvider(context);
    assert.equal(capturedGetKey(), undefined);
    assert.equal((provider as any).selectedOrg, undefined);
    (provider as any).setSelectedOrg('next-org');
    assert.equal(updates.length, 0);
    assert.equal((provider as any).selectedOrg, 'next-org');
  });
});
