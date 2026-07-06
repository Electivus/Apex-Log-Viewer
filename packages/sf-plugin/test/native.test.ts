import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeElectivus, resolveOrgRequestPath, toolingQuery, writeLogBody } from '../src/native.ts';

test('executeElectivus rejects unknown commands clearly', async () => {
  await assert.rejects(
    executeElectivus(['definitely', 'missing', '--json']),
    /Unknown sf electivus command: definitely missing/
  );
});

test('executeElectivus returns local org-first logs status', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-status-'));
  const username = 'demo@example.com';
  const safeOrg = username;
  await fs.mkdir(path.join(workspaceRoot, 'apexlogs', '.alv'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'apexlogs', 'orgs', safeOrg, 'logs', '2026-07-06'), {
    recursive: true
  });
  await fs.writeFile(
    path.join(workspaceRoot, 'apexlogs', '.alv', 'sync-state.json'),
    JSON.stringify({
      version: 1,
      orgs: {
        [username]: {
          targetOrg: username,
          safeTargetOrg: safeOrg,
          orgDir: `apexlogs/orgs/${safeOrg}`,
          lastSyncStartedAt: '2026-07-06T10:00:00.000Z',
          lastSyncCompletedAt: '2026-07-06T10:01:00.000Z',
          lastSyncedLogId: '07L000000000001AAA',
          lastSyncedStartTime: '2026-07-06T09:59:00.000Z',
          downloadedCount: 1,
          cachedCount: 2
        }
      }
    })
  );
  await fs.writeFile(
    path.join(workspaceRoot, 'apexlogs', 'orgs', safeOrg, 'org.json'),
    JSON.stringify({
      targetOrg: 'demo',
      safeTargetOrg: safeOrg,
      resolvedUsername: username,
      alias: 'demo',
      updatedAt: '2026-07-06T10:01:00.000Z'
    })
  );
  await fs.writeFile(
    path.join(workspaceRoot, 'apexlogs', 'orgs', safeOrg, 'logs', '2026-07-06', '07L000000000001AAA.log'),
    'log body'
  );

  const result = await executeElectivus(['logs', 'status', '--target-org', 'demo', '--workspace-root', workspaceRoot]);

  assert.deepEqual(result, {
    target_org: username,
    safe_target_org: safeOrg,
    workspace_root: workspaceRoot,
    apexlogs_root: path.join(workspaceRoot, 'apexlogs'),
    state_file: path.join(workspaceRoot, 'apexlogs', '.alv', 'sync-state.json'),
    log_count: 1,
    has_state: true,
    last_sync_started_at: '2026-07-06T10:00:00.000Z',
    last_sync_completed_at: '2026-07-06T10:01:00.000Z',
    last_synced_log_id: '07L000000000001AAA',
    last_synced_start_time: '2026-07-06T09:59:00.000Z',
    downloaded_count: 1,
    cached_count: 2,
    last_error: undefined
  });
});

test('executeElectivus triages exception events as fatal exceptions', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-triage-'));
  const logId = '07L000000000002AAA';
  await fs.mkdir(path.join(workspaceRoot, 'apexlogs', 'orgs', 'demo@example.com', 'logs', '2026-07-06'), {
    recursive: true
  });
  await fs.writeFile(
    path.join(workspaceRoot, 'apexlogs', 'orgs', 'demo@example.com', 'logs', '2026-07-06', `${logId}.log`),
    '09:00:00.0|USER_DEBUG|noop\n09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n'
  );

  const result = await executeElectivus(['logs', 'triage', logId, '--workspace-root', workspaceRoot]);

  assert.equal(Array.isArray(result), true);
  assert.equal((result as any[])[0]?.summary?.primaryReason, 'Fatal exception');
  assert.equal((result as any[])[0]?.summary?.reasons?.[0]?.code, 'fatal_exception');
});

test('resolveOrgRequestPath rejects absolute URLs outside the authenticated org', () => {
  const ctx = { instanceUrl: 'https://example.my.salesforce.com' };

  assert.equal(resolveOrgRequestPath(ctx, '/services/data/v63.0/tooling/query'), '/services/data/v63.0/tooling/query');
  assert.equal(
    resolveOrgRequestPath(ctx, 'https://example.my.salesforce.com/services/data/v63.0/tooling/query?q=SELECT+Id'),
    '/services/data/v63.0/tooling/query?q=SELECT+Id'
  );
  assert.throws(
    () => resolveOrgRequestPath(ctx, 'https://attacker.example/services/data/v63.0/tooling/query'),
    /must target the authenticated org instance/
  );
});

test('toolingQuery follows all Tooling API result pages', async () => {
  const calls: string[] = [];
  const connection = {
    tooling: {
      async query(soql: string) {
        calls.push(`query:${soql}`);
        return {
          done: false,
          totalSize: 3,
          records: [{ Id: '01p000000000001AAA' }],
          nextRecordsUrl: '/services/data/v63.0/tooling/query/01g-page-2'
        };
      },
      async queryMore(locator: string) {
        calls.push(`queryMore:${locator}`);
        return {
          done: true,
          totalSize: 3,
          records: [{ Id: '01p000000000002AAA' }, { Id: '01p000000000003AAA' }]
        };
      }
    }
  };

  const result = await toolingQuery<{ Id: string }>(connection as any, 'SELECT Id FROM ApexClass');

  assert.deepEqual(calls, ['query:SELECT Id FROM ApexClass', 'queryMore:/services/data/v63.0/tooling/query/01g-page-2']);
  assert.equal(result.done, true);
  assert.equal(result.totalSize, 3);
  assert.deepEqual(
    result.records?.map(record => record.Id),
    ['01p000000000001AAA', '01p000000000002AAA', '01p000000000003AAA']
  );
});

test('writeLogBody saves fetched bodies without leaving temp files', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-write-log-'));
  const saved = await writeLogBody(
    workspaceRoot,
    'demo@example.com',
    { Id: '07L000000000003AAA', StartTime: '2026-07-06T10:00:00.000+0000' },
    'complete body'
  );

  assert.equal(await fs.readFile(saved.path, 'utf8'), 'complete body');
  const dirFiles = await fs.readdir(path.dirname(saved.path));
  assert.deepEqual(
    dirFiles.filter(fileName => fileName.includes('.tmp')),
    []
  );
});
