import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import { SELECTED_ORG_KEY } from '../shared/constants';

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
  test('SfLogsViewProvider restores and persists selected org', () => {
    const { context, capturedGetKey, updates } = makeContext();
    const provider = new SfLogsViewProvider(context);
    assert.equal(capturedGetKey(), SELECTED_ORG_KEY);
    assert.equal((provider as any).selectedOrg, 'persisted-org');
    (provider as any).setSelectedOrg('next-org');
    assert.equal(updates[0]?.key, SELECTED_ORG_KEY);
    assert.equal(updates[0]?.value, 'next-org');
    assert.equal((provider as any).selectedOrg, 'next-org');
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
});
