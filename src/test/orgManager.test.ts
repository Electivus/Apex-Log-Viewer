import assert from 'assert/strict';
import proxyquire from 'proxyquire';
import type * as vscode from 'vscode';

suite('OrgManager', () => {
  test('setSelectedOrg keeps value in memory', () => {
    const { OrgManager } = proxyquire('../utils/orgManager', {
      './orgs': {
        pickSelectedOrg: () => undefined
      },
      '../salesforce/cli': { listOrgs: async () => [] }
    });
    const mgr = new OrgManager({} as vscode.ExtensionContext);
    assert.equal(mgr.getSelectedOrg(), undefined);
    mgr.setSelectedOrg('user1');
    assert.equal(mgr.getSelectedOrg(), 'user1');
  });

  test('list returns orgs and selected', async () => {
    const { OrgManager } = proxyquire('../utils/orgManager', {
      './orgs': {
        pickSelectedOrg: () => 'u1'
      },
      '../salesforce/cli': {
        listOrgs: async () => [{ username: 'u1' }]
      }
    });
    const mgr = new OrgManager({} as any);
    const res = await mgr.list();
    assert.equal(res.selected, 'u1');
    assert.equal(res.orgs.length, 1);
  });
});
