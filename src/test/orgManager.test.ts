import assert from 'assert/strict';
import proxyquire from 'proxyquire';
import type * as vscode from 'vscode';

suite('OrgManager', () => {
  test('setSelectedOrg persists value', () => {
    let saved: string | undefined;
    const { OrgManager } = proxyquire('../utils/orgManager', {
      './orgs': {
        persistSelectedOrg: (_ctx: vscode.ExtensionContext, val?: string) => {
          saved = val;
        },
        restoreSelectedOrg: () => undefined,
        pickSelectedOrg: () => undefined
      },
      '../salesforce/cli': { listOrgs: async () => [] }
    });
    const mgr = new OrgManager({} as any);
    mgr.setSelectedOrg('user1');
    assert.equal(saved, 'user1');
  });

  test('list returns orgs and selected', async () => {
    const { OrgManager } = proxyquire('../utils/orgManager', {
      './orgs': {
        persistSelectedOrg: () => {},
        restoreSelectedOrg: () => 'u1',
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
