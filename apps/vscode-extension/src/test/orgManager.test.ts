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
      '../../../../src/utils/orgs': {
        pickSelectedOrg: () => undefined,
        '@noCallThru': true
      },
      '../runtime/runtimeClient': { runtimeClient: { orgList: async () => [] }, '@noCallThru': true }
    });
    const mgr = new OrgManager({} as vscode.ExtensionContext);
    assert.equal(mgr.getSelectedOrg(), undefined);
    mgr.setSelectedOrg('user1');
    assert.equal(mgr.getSelectedOrg(), 'user1');
  });

  test('list returns orgs and selected', async () => {
    const { OrgManager } = proxyquire('../utils/orgManager', {
      '../../../../src/utils/orgs': {
        pickSelectedOrg: () => 'u1',
        '@noCallThru': true
      },
      '../runtime/runtimeClient': {
        runtimeClient: { orgList: async () => [{ username: 'u1' }] },
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
      '../../../../src/utils/orgs': {
        pickSelectedOrg: () => undefined,
        '@noCallThru': true
      },
      '../runtime/runtimeClient': {
        runtimeClient: { orgList: async () => [] },
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
        '../runtime/runtimeClient': {
          runtimeClient: { orgList: async () => orgs },
          '@noCallThru': true
        },
        '../../../../src/utils/workspace': {
          getWorkspaceRoot: () => tmp,
          '@noCallThru': true
        },
        '../../../../src/utils/logger': {
          logWarn: () => {},
          '@noCallThru': true
        },
        '../../../../src/utils/error': {
          getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
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

  test('list does not mutate selection after cancellation', async () => {
    const controller = new AbortController();
    const { OrgManager } = proxyquire('../utils/orgManager', {
      '../../../../src/utils/orgs': {
        pickSelectedOrg: () => 'u1',
        '@noCallThru': true
      },
      '../runtime/runtimeClient': {
        runtimeClient: {
          orgList: async (_params: unknown, signal?: AbortSignal) => {
            controller.abort();
            if (signal?.aborted) {
              const error = new Error('Request aborted');
              error.name = 'AbortError';
              throw error;
            }
            return [{ username: 'u1' }];
          }
        },
        '@noCallThru': true
      }
    });
    const mgr = new OrgManager({} as any);
    mgr.setSelectedOrg('existing');

    await assert.rejects(
      mgr.list(false, controller.signal),
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );
    assert.equal(mgr.getSelectedOrg(), 'existing');
  });
});
