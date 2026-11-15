import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AlvError, createApexLogViewerCore } from '../src/index.ts';
import { authSourceDouble, saveOrgAuth } from './support/salesforceDouble.ts';

test('doctor reports a missing apexlogs without creating it, and warns when the CLI lists no org', async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-doctor-empty-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const core = createApexLogViewerCore({ auth: authSourceDouble() });
  t.after(() => core.dispose());

  const result = await core.doctor({ workspaceRoot });

  assert.equal(result.workspaceRoot, workspaceRoot);
  assert.equal(result.apexlogsRoot, path.join(workspaceRoot, 'apexlogs'));
  assert.deepEqual(result.writableApexlogs, {
    ok: true,
    message: 'apexlogs does not exist yet; the workspace is writable, so the first sync creates it'
  });
  assert.deepEqual(result.cacheLayout, { ok: true, message: 'no apexlogs directory yet' });
  assert.equal(result.sf.ok, false);
  assert.match(result.sf.message, /lists no org/);
  assert.equal(result.status, 'warning');
  await assert.rejects(fs.stat(path.join(workspaceRoot, 'apexlogs')), { code: 'ENOENT' });
});

test('doctor counts org folders and legacy files and the orgs the CLI knows', async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-doctor-store-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const apexlogs = path.join(workspaceRoot, 'apexlogs');
  await fs.mkdir(path.join(apexlogs, 'orgs', 'dev_example.com', 'logs'), { recursive: true });
  await fs.writeFile(path.join(apexlogs, 'dev_07L000000000001AAA.log'), 'legacy body');
  await fs.writeFile(path.join(apexlogs, 'notes.md'), 'not a log');
  saveOrgAuth('doctor@example.com', 'https://doctor.example.com');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  const result = await core.doctor({ workspaceRoot, targetOrg: 'doctor@example.com' });

  assert.deepEqual(result.writableApexlogs, { ok: true, message: 'apexlogs is writable' });
  assert.deepEqual(result.cacheLayout, {
    ok: true,
    message: 'org-first layout with 1 org folder(s); 1 legacy log file(s) at the apexlogs root'
  });
  assert.deepEqual(result.sf, { ok: true, message: 'the Salesforce CLI lists 1 org(s)' });
  assert.deepEqual(result.orgAuth, { ok: true, message: 'authenticated as doctor@example.com' });
  assert.deepEqual(auth.sessionReasons('doctor@example.com'), ['first-use']);
  assert.equal(result.status, 'ok');
});

test('doctor warns with the reason when the Salesforce CLI cannot list orgs', async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-doctor-no-cli-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const missingCli = new AlvError('SF_CLI_NOT_FOUND', 'The Salesforce CLI (sf) was not found.');
  const core = createApexLogViewerCore({
    auth: {
      listOrgs: () => Promise.reject(missingCli),
      session: () => Promise.reject(missingCli)
    }
  });
  t.after(() => core.dispose());

  const result = await core.doctor({ workspaceRoot, targetOrg: 'doctor@example.com' });

  assert.deepEqual(result.sf, {
    ok: false,
    message: 'the Salesforce CLI could not list orgs: The Salesforce CLI (sf) was not found.'
  });
  assert.equal(result.orgAuth?.ok, false);
  assert.equal(result.status, 'warning');
});
