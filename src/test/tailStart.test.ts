import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import * as salesforce from '../salesforce';

suite('SfLogTailViewProvider startTail', () => {
  test('requires debug level', async () => {
    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;
    const provider = new SfLogTailViewProvider(context);
    const posted: any[] = [];
    (provider as any).post = (m: any) => posted.push(m);
    const original = salesforce.getOrgAuth;
    (salesforce as any).getOrgAuth = async () => {
      throw new Error('getOrgAuth should not be called');
    };
    await (provider as any).startTail(undefined);
    assert.equal(posted[0]?.type, 'error');
    (salesforce as any).getOrgAuth = original;
  });
});
