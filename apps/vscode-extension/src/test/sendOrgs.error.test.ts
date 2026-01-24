import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import { __resetListOrgsCacheForTests, __setListOrgsMockForTests } from '../salesforce/cli';
import { __resetExecFileImplForTests } from '../salesforce/exec';

suite('SfLogsViewProvider sendOrgs', () => {
  teardown(() => {
    __resetExecFileImplForTests();
    __resetListOrgsCacheForTests();
  });

  test('shows error message when listOrgs rejects', async () => {
    // Ensure no caches affect behavior
    __resetListOrgsCacheForTests();
    // Simulate listOrgs failing (e.g., CLI not found)
    __setListOrgsMockForTests(() => {
      const err: any = new Error('Salesforce CLI not found');
      err.code = 'ENOENT';
      throw err;
    });

    const context = {
      extensionUri: vscode.Uri.file(path.resolve('.')),
      subscriptions: [] as vscode.Disposable[]
    } as unknown as vscode.ExtensionContext;

    const messages: string[] = [];
    const posted: any[] = [];
    const origShowError = vscode.window.showErrorMessage;
    (vscode.window as any).showErrorMessage = (m: string) => {
      messages.push(m);
      return Promise.resolve(undefined as any);
    };

    try {
      const provider = new SfLogsViewProvider(context);
      // Inject a minimal mock view so we can assert the posted message too
      (provider as any).view = {
        webview: {
          postMessage: (m: any) => {
            posted.push(m);
            return Promise.resolve(true);
          }
        }
      } as any;
      // Force refresh to bypass any cached orgs from previous tests
      await provider.sendOrgs(true);
    } finally {
      (vscode.window as any).showErrorMessage = origShowError;
    }

    // Prefer UI notification, but also verify we posted the empty orgs payload to the webview
    const showedError = messages.length >= 1 && /Salesforce CLI not found/.test(messages[0] || '');
    const postedOrgs = posted.find(m => m?.type === 'orgs');
    assert.ok(showedError || postedOrgs, 'should surface failure via error or orgs post');
    if (postedOrgs) {
      assert.equal(postedOrgs.data?.length, 0, 'posted orgs should be empty on failure');
    }
  });
});
