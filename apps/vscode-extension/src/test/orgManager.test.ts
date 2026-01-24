import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import proxyquire from 'proxyquire';
import type * as vscode from 'vscode';
import type { OrgItem } from '../shared/types';

suite('OrgManager', () => {
  test('setSelectedOrg keeps value in memory', () => {
    const { OrgManager } = proxyquire('../utils/orgManager', {
      './orgs': {
        pickSelectedOrg: () => undefined,
        '@noCallThru': true
      },
      '../salesforce/cli': { listOrgs: async () => [], '@noCallThru': true }
    });
    const mgr = new OrgManager({} as vscode.ExtensionContext);
    assert.equal(mgr.getSelectedOrg(), undefined);
    mgr.setSelectedOrg('user1');
    assert.equal(mgr.getSelectedOrg(), 'user1');
  });

  test('list returns orgs and selected', async () => {
    const { OrgManager } = proxyquire('../utils/orgManager', {
      './orgs': {
        pickSelectedOrg: () => 'u1',
        '@noCallThru': true
      },
      '../salesforce/cli': {
        listOrgs: async () => [{ username: 'u1' }],
        '@noCallThru': true
      }
    });
    const mgr = new OrgManager({} as any);
    const res = await mgr.list();
    assert.equal(res.selected, 'u1');
    assert.equal(res.orgs.length, 1);
    assert.equal(mgr.getSelectedOrg(), 'u1');
  });

  test('list clears selected org when none returned', async () => {
    const { OrgManager } = proxyquire('../utils/orgManager', {
      './orgs': {
        pickSelectedOrg: () => undefined,
        '@noCallThru': true
      },
      '../salesforce/cli': {
        listOrgs: async () => [],
        '@noCallThru': true
      }
    });
    const mgr = new OrgManager({} as any);
    mgr.setSelectedOrg('existing');
    const res = await mgr.list();
    assert.equal(res.selected, undefined);
    assert.equal(res.orgs.length, 0);
    assert.equal(mgr.getSelectedOrg(), undefined);
  });

  test('uses project default org from config on first list', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'alv-org-'));
    try {
      const sfDir = path.join(tmp, '.sf');
      mkdirSync(sfDir, { recursive: true });
      writeFileSync(path.join(sfDir, 'config.json'), JSON.stringify({ 'target-org': 'ProjectDefault' }), 'utf8');
      const orgs: OrgItem[] = [
        { username: 'other@example.com', alias: 'Other' },
        { username: 'project@example.com', alias: 'ProjectDefault' }
      ];
      const { OrgManager } = proxyquire('../utils/orgManager', {
        '../salesforce/cli': {
          listOrgs: async () => orgs,
          '@noCallThru': true
        },
        './workspace': {
          getWorkspaceRoot: () => tmp,
          '@noCallThru': true
        },
        './logger': {
          logWarn: () => {},
          '@noCallThru': true
        }
      });
      const mgr = new OrgManager({} as any);
      const res = await mgr.list();
      assert.equal(res.selected, 'project@example.com');
      assert.equal(mgr.getSelectedOrg(), 'project@example.com');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
