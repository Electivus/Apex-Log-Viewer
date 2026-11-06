import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApexLogViewerCore } from '../src/index.ts';
import { isolateSalesforceHome, saveOrgAuth } from './support/salesforceDouble.ts';

isolateSalesforceHome();

test('doctor reports a missing apexlogs without creating it, and warns when the CLI lists no org', async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-doctor-empty-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const core = createApexLogViewerCore();
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
  await saveOrgAuth('doctor@example.com', 'https://doctor.example.com');
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());

  const result = await core.doctor({ workspaceRoot, targetOrg: 'doctor@example.com' });

  assert.deepEqual(result.writableApexlogs, { ok: true, message: 'apexlogs is writable' });
  assert.deepEqual(result.cacheLayout, {
    ok: true,
    message: 'org-first layout with 1 org folder(s); 1 legacy log file(s) at the apexlogs root'
  });
  assert.deepEqual(result.sf, { ok: true, message: 'the Salesforce CLI auth store lists 1 org(s)' });
  assert.equal(result.orgAuth?.ok, true);
  assert.equal(result.status, 'ok');
});
