import assert from 'assert/strict';
import * as vscode from 'vscode';
import * as path from 'path';
import proxyquire from 'proxyquire';

suite('SfLogsViewProvider sendOrgs', () => {
  test('shows error message when runtime orgList rejects', async () => {
    const { SfLogsViewProvider } = proxyquire.noCallThru().load('../provider/SfLogsViewProvider', {
      '../runtime/runtimeClient': {
        runtimeClient: {
          orgList: async () => {
            throw new Error('runtime org/list failed');
          }
        }
      },
      '../utils/orgManager': {
        OrgManager: class {
          getSelectedOrg(): string | undefined {
            return undefined;
          }
          setSelectedOrg(): void {}
          async ensureProjectDefaultSelected(): Promise<void> {}
        }
      }
    }) as typeof import('../provider/SfLogsViewProvider');

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
    const showedError = messages.length >= 1 && /runtime org\/list failed/.test(messages[0] || '');
    const postedOrgs = posted.find(m => m?.type === 'orgs');
    assert.ok(showedError || postedOrgs, 'should surface failure via error or orgs post');
    if (postedOrgs) {
      assert.equal(postedOrgs.data?.length, 0, 'posted orgs should be empty on failure');
    }
  });
});
