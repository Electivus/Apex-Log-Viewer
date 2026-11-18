import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApexLogViewerCore } from '../src/index.ts';
import { authSourceDouble, removeOrgAuth, saveOrgAuth } from './support/salesforceDouble.ts';

const GLOBAL_ORG = 'global@example.com';
const WORKSPACE_ORG = 'workspace@example.com';
const WORKSPACE_ALIAS = 'workspace-scratch';
const OTHER_ORG = 'other@example.com';
const INSTANCE = 'https://default-org.example.com';

/** The orgs `sf` lists, `defaultOrg` the one the project's config names. Each test's orgs go when it ends. */
function saveOrgs(t: test.TestContext, defaultOrg: string | undefined): void {
  saveOrgAuth(GLOBAL_ORG, INSTANCE, { isDefaultUsername: defaultOrg === GLOBAL_ORG });
  saveOrgAuth(WORKSPACE_ORG, INSTANCE, { alias: WORKSPACE_ALIAS, isDefaultUsername: defaultOrg === WORKSPACE_ORG });
  saveOrgAuth(OTHER_ORG, INSTANCE, { isDefaultUsername: defaultOrg === OTHER_ORG });
  t.after(() => [GLOBAL_ORG, WORKSPACE_ORG, OTHER_ORG].forEach(removeOrgAuth));
}

const defaults = (orgs: Array<{ username: string; isDefaultUsername?: boolean }>): string[] =>
  orgs.filter(org => org.isDefaultUsername).map(org => org.username);

test('the org the auth source marks as default sorts first and serves every call without a target', async t => {
  saveOrgs(t, WORKSPACE_ORG);
  const core = createApexLogViewerCore({ auth: authSourceDouble() });
  t.after(() => core.dispose());

  const orgs = await core.org.list();

  assert.deepEqual(defaults(orgs), [WORKSPACE_ORG]);
  assert.equal(orgs[0]?.username, WORKSPACE_ORG, 'the default org sorts first');
  assert.equal((await core.org.getAuth()).username, WORKSPACE_ORG);
  assert.deepEqual(await core.org.resolve(), {
    requested: WORKSPACE_ALIAS,
    username: WORKSPACE_ORG,
    alias: WORKSPACE_ALIAS,
    instanceUrl: INSTANCE,
    source: 'alias'
  });
});

test('an alias and a username in another case resolve to the listed org', async t => {
  saveOrgs(t, undefined);
  const core = createApexLogViewerCore({ auth: authSourceDouble() });
  t.after(() => core.dispose());

  assert.equal((await core.org.resolve({ targetOrg: WORKSPACE_ALIAS })).username, WORKSPACE_ORG);
  assert.equal((await core.org.resolve({ targetOrg: 'GLOBAL@example.com' })).username, GLOBAL_ORG);
});

test('without a default org, a call without a target asks the user to pick one', async t => {
  saveOrgs(t, undefined);
  const core = createApexLogViewerCore({ auth: authSourceDouble() });
  t.after(() => core.dispose());

  await assert.rejects(core.org.resolve(), /No default Salesforce org is configured/);
  await assert.rejects(core.org.getAuth(), /No default Salesforce org is configured/);
});

const SYNCED_LOGS: Record<string, string> = {
  [GLOBAL_ORG]: '07L000000000001AAA',
  [WORKSPACE_ORG]: '07L000000000002AAA'
};

/** A workspace whose Apex log store holds `synced`, both orgs of SYNCED_LOGS by default. */
async function workspaceWithSyncedOrgs(t: test.TestContext, synced = Object.keys(SYNCED_LOGS)): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-default-org-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const core = createApexLogViewerCore({
    auth: authSourceDouble(),
    apexLogRemote: {
      resolveOrg: async targetOrg => ({ username: targetOrg ?? assert.fail('the test names the org it syncs') }),
      listLogs: async ({ org }) => [{ logId: SYNCED_LOGS[org.username]!, startTime: '2026-11-06T10:00:00.000Z' }],
      readBody: async () => 'log body'
    }
  });
  for (const username of synced) {
    assert.equal((await core.log.sync({ targetOrg: username, workspaceRoot: workspace })).status, 'success');
  }
  core.dispose();
  return workspace;
}

test('log status reports the default org, not the first org in the store', async t => {
  const workspace = await workspaceWithSyncedOrgs(t);
  saveOrgs(t, WORKSPACE_ORG);
  const core = createApexLogViewerCore({ auth: authSourceDouble() });
  t.after(() => core.dispose());

  const status = await core.log.status({ workspaceRoot: workspace });

  assert.equal(status.targetOrg, WORKSPACE_ORG);
  assert.equal(status.lastSyncedLogId, SYNCED_LOGS[WORKSPACE_ORG]);
  assert.equal(status.logCount, 1);
});

test('log status reports no state for a default org the store never synced', async t => {
  const workspace = await workspaceWithSyncedOrgs(t);
  saveOrgs(t, OTHER_ORG);
  const core = createApexLogViewerCore({ auth: authSourceDouble() });
  t.after(() => core.dispose());

  const status = await core.log.status({ workspaceRoot: workspace });

  assert.equal(status.targetOrg, OTHER_ORG);
  assert.equal(status.hasState, false);
  assert.equal(status.logCount, 0);
  assert.equal(status.lastSyncedLogId, undefined);
});

test('an explicit target org still wins over the default org', async t => {
  const workspace = await workspaceWithSyncedOrgs(t);
  saveOrgs(t, WORKSPACE_ORG);
  const core = createApexLogViewerCore({ auth: authSourceDouble() });
  t.after(() => core.dispose());

  const status = await core.log.status({ targetOrg: GLOBAL_ORG, workspaceRoot: workspace });

  assert.equal(status.targetOrg, GLOBAL_ORG);
  assert.equal(status.lastSyncedLogId, SYNCED_LOGS[GLOBAL_ORG]);
});

test('log status still reports the local store when the Salesforce CLI cannot list orgs', async t => {
  const workspace = await workspaceWithSyncedOrgs(t, [GLOBAL_ORG]);
  const unavailable = () => Promise.reject(new Error('the Salesforce CLI (sf) was not found'));
  const core = createApexLogViewerCore({ auth: { listOrgs: unavailable, session: unavailable } });
  t.after(() => core.dispose());

  const status = await core.log.status({ workspaceRoot: workspace });

  assert.equal(status.targetOrg, GLOBAL_ORG);
  assert.equal(status.lastSyncedLogId, SYNCED_LOGS[GLOBAL_ORG]);
});
