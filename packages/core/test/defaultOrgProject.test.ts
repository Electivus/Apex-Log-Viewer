import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { StateAggregator } from '@salesforce/core';

import { createApexLogViewerCore } from '../src/index.ts';

const originalCwd = process.cwd();
const sfHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alv-default-org-')));
process.env.HOME = sfHome;
process.env.USERPROFILE = sfHome;
process.env.SF_USE_GENERIC_UNIX_KEYCHAIN = 'true';
process.env.SF_DISABLE_LOG_FILE = 'true';
process.env.SF_DISABLE_DNS_CHECK = 'true';
process.env.SFDX_IGNORE_API_VERSION_CACHE = 'true';
delete process.env.SF_TARGET_ORG;
process.chdir(sfHome);
after(() => {
  process.chdir(originalCwd);
  fs.rmSync(sfHome, { recursive: true, force: true });
});

const GLOBAL_ORG = 'global@example.com';
const WORKSPACE_ORG = 'workspace@example.com';
const WORKSPACE_ALIAS = 'workspace-scratch';
const CWD_ORG = 'cwd@example.com';

function writeProjectConfig(root: string, values: Record<string, string>): string {
  fs.mkdirSync(path.join(root, '.sf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sf', 'config.json'), JSON.stringify(values));
  return root;
}

async function saveOrgs(instanceUrl: string): Promise<void> {
  const state = await StateAggregator.getInstance();
  for (const username of [GLOBAL_ORG, WORKSPACE_ORG, CWD_ORG]) {
    state.orgs.set(username, {
      username,
      orgId: '00D000000000001AAA',
      instanceUrl,
      loginUrl: instanceUrl,
      accessToken: `token-${username}`
    });
    await state.orgs.write(username);
  }
  await state.aliases.setAndSave(WORKSPACE_ALIAS, WORKSPACE_ORG);
}

const salesforce = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify([{ label: "Spring '25", url: '/services/data/v63.0', version: '63.0' }]));
});

test.before(async () => {
  await new Promise<void>(resolve => salesforce.listen(0, '127.0.0.1', resolve));
  await saveOrgs(`http://127.0.0.1:${(salesforce.address() as AddressInfo).port}`);
  writeProjectConfig(sfHome, { 'target-org': GLOBAL_ORG });
});
after(() => {
  salesforce.closeAllConnections();
  salesforce.close();
});

const defaults = (orgs: Array<{ username: string; isDefaultUsername?: boolean }>): string[] =>
  orgs.filter(org => org.isDefaultUsername).map(org => org.username);

function workspaceFolder(values: Record<string, string> = { 'target-org': WORKSPACE_ALIAS }): string {
  return writeProjectConfig(fs.mkdtempSync(path.join(sfHome, 'workspace-')), values);
}

test('the project path decides the default org over the global target-org', async () => {
  const workspace = workspaceFolder();
  const core = createApexLogViewerCore({ projectPath: () => workspace });

  const orgs = await core.org.list();

  assert.deepEqual(defaults(orgs), [WORKSPACE_ORG]);
  assert.equal(orgs[0]?.username, WORKSPACE_ORG, 'the default org sorts first');
  assert.equal((await core.org.getAuth()).username, WORKSPACE_ORG);
  assert.equal((await core.org.resolve()).username, WORKSPACE_ORG);
});

test('the project path decides the default org over the process working directory', async () => {
  const project = writeProjectConfig(fs.mkdtempSync(path.join(sfHome, 'cwd-')), { 'target-org': CWD_ORG });
  fs.writeFileSync(path.join(project, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app"}]}');
  const workspace = workspaceFolder();
  process.chdir(project);
  try {
    const orgs = await createApexLogViewerCore({ projectPath: () => workspace }).org.list();
    assert.deepEqual(defaults(orgs), [WORKSPACE_ORG]);
  } finally {
    process.chdir(sfHome);
  }
});

test('a project with no target-org falls back to the global one', async () => {
  const workspace = workspaceFolder({});
  const orgs = await createApexLogViewerCore({ projectPath: () => workspace }).org.list();

  assert.deepEqual(defaults(orgs), [GLOBAL_ORG]);
});

test('the project path is read on each call, so a changed workspace folder takes effect', async () => {
  let current = workspaceFolder();
  const core = createApexLogViewerCore({ projectPath: () => current });
  assert.deepEqual(defaults(await core.org.list()), [WORKSPACE_ORG]);

  current = workspaceFolder({ 'target-org': CWD_ORG });

  assert.deepEqual(defaults(await core.org.list()), [CWD_ORG]);
});

test('a surface with no project path keeps resolving from the process working directory', async () => {
  const project = writeProjectConfig(fs.mkdtempSync(path.join(sfHome, 'cli-')), { 'target-org': CWD_ORG });
  fs.writeFileSync(path.join(project, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app"}]}');
  fs.mkdirSync(path.join(project, 'force-app'));
  const core = createApexLogViewerCore();

  assert.deepEqual(defaults(await core.org.list()), [GLOBAL_ORG], 'outside a project the global target-org applies');

  process.chdir(path.join(project, 'force-app'));
  try {
    assert.deepEqual(defaults(await core.org.list()), [CWD_ORG], 'inside a project its target-org applies');
    assert.equal((await core.org.getAuth()).username, CWD_ORG);
  } finally {
    process.chdir(sfHome);
  }
});
