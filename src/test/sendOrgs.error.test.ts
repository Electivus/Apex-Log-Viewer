import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import { __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce/cli';

suite('SfLogsViewProvider sendOrgs', () => {
  teardown(() => {
    __resetExecFileImplForTests();
  });

  test('shows error message when listOrgs rejects', async () => {
    __setExecFileImplForTests(((file: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const messages: string[] = [];
    const origShowError = vscode.window.showErrorMessage;
    (vscode.window as any).showErrorMessage = (m: string) => {
      messages.push(m);
      return Promise.resolve(undefined as any);
    };

    try {
      const provider = new SfLogsViewProvider(context);
      // Force refresh to bypass any cached orgs from previous tests
      await provider.sendOrgs(true);
    } finally {
      (vscode.window as any).showErrorMessage = origShowError;
    }

    assert.equal(messages.length, 1, 'should show one error message');
    assert.ok(messages[0]?.includes('Salesforce CLI not found'), 'message should include context');
  });
});
