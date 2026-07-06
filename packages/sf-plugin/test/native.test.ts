import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildApexLogListSoql,
  executeElectivus,
  formatJsonResult,
  formatTextResult,
  materializeCachedLogAtDatedPath,
  normalizeSoqlDateTimeLiteral,
  removeLegacyLogIndexFiles,
  resolveOrgRequestPath,
  summarizeTraceFlagRecords,
  toolingQuery,
  writeLogBody
} from '../src/native.ts';

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

test('buildApexLogListSoql normalizes Salesforce cursor timestamps', () => {
  const soql = buildApexLogListSoql({
    limit: 50,
    offset: 0,
    cursor: {
      beforeStartTime: '2026-03-30T18:39:58.000+0000',
      beforeId: '07L000000000009AAA'
    }
  });

  assert.match(soql, /StartTime < 2026-03-30T18:39:58\.000Z/);
  assert.match(soql, /Id < '07L000000000009AAA'/);
  assert.doesNotMatch(soql, /OFFSET/);
  assert.equal(normalizeSoqlDateTimeLiteral('not-a-date'), undefined);
});

test('buildApexLogListSoql ignores invalid cursor values', () => {
  const soql = buildApexLogListSoql({
    limit: 25,
    offset: 10,
    cursor: {
      beforeStartTime: "2026-03-30T18:39:58.000Z) OR Name != ''",
      beforeId: 'not-an-id'
    }
  });

  assert.match(soql, /ORDER BY StartTime DESC, Id DESC LIMIT 25 OFFSET 10$/);
  assert.doesNotMatch(soql, /Name !=/);
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
  assert.equal(path.basename(saved.path), '07L000000000003AAA.log');
  assert.equal(path.basename(path.dirname(saved.path)), '2026-07-06');
  const dirFiles = await fs.readdir(path.dirname(saved.path));
  assert.deepEqual(
    dirFiles.filter(fileName => fileName.includes('.tmp')),
    []
  );
});

test('removeLegacyLogIndexFiles deletes SQLite search index leftovers', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-legacy-index-'));
  const alvRoot = path.join(workspaceRoot, 'apexlogs', '.alv');
  await fs.mkdir(alvRoot, { recursive: true });
  for (const fileName of ['log-index.sqlite', 'log-index.sqlite-wal', 'log-index.sqlite-shm']) {
    await fs.writeFile(path.join(alvRoot, fileName), 'legacy');
  }

  await removeLegacyLogIndexFiles(workspaceRoot);

  for (const fileName of ['log-index.sqlite', 'log-index.sqlite-wal', 'log-index.sqlite-shm']) {
    await assert.rejects(fs.access(path.join(alvRoot, fileName)));
  }
});

test('materializeCachedLogAtDatedPath copies unknown-date cache to dated sync path', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-materialize-log-'));
  const logId = '07L000000000006AAA';
  const unknownDir = path.join(workspaceRoot, 'apexlogs', 'orgs', 'demo@example.com', 'logs', 'unknown-date');
  await fs.mkdir(unknownDir, { recursive: true });
  await fs.writeFile(path.join(unknownDir, `${logId}.log`), 'cached body');

  const datedPath = await materializeCachedLogAtDatedPath(
    workspaceRoot,
    'demo@example.com',
    { Id: logId, StartTime: '2026-07-06T10:00:00.000+0000' }
  );

  assert.equal(path.basename(datedPath || ''), `${logId}.log`);
  assert.equal(path.basename(path.dirname(datedPath || '')), '2026-07-06');
  assert.equal(await fs.readFile(datedPath || '', 'utf8'), 'cached body');
});

test('executeElectivus reads cached logs before requiring target org auth', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-read-cache-fallback-'));
  const logId = '07L000000000007AAA';
  await fs.mkdir(path.join(workspaceRoot, 'apexlogs', 'orgs', 'cached@example.com', 'logs', '2026-07-06'), {
    recursive: true
  });
  await fs.writeFile(
    path.join(workspaceRoot, 'apexlogs', 'orgs', 'cached@example.com', 'logs', '2026-07-06', `${logId}.log`),
    'raw cached body'
  );

  const result = (await executeElectivus([
    'logs',
    'read',
    logId,
    '--target-org',
    'definitely-not-a-local-org@example.com',
    '--workspace-root',
    workspaceRoot
  ])) as any;

  assert.equal(result.body, 'raw cached body');
  assert.equal(result.sizeBytes, 'raw cached body'.length);
});

test('formatTextResult prints logs read bodies without JSON wrapping', () => {
  assert.equal(
    formatTextResult({
      logId: '07L000000000008AAA',
      path: '/tmp/07L000000000008AAA.log',
      body: 'line one\nline two',
      sizeBytes: 17,
      truncated: false
    }),
    'line one\nline two'
  );
});

test('formatJsonResult serializes undefined as JSON null', () => {
  assert.equal(formatJsonResult(undefined), 'null\n');
});

test('executeElectivus installs the bundled Codex skill', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-codex-home-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const result = (await executeElectivus(['skills', 'install'])) as any;

    assert.equal(result.status, 'installed');
    assert.equal(result.skillName, 'apex-log-viewer-cli');
    assert.equal(result.destination, path.join(codexHome, 'skills', 'apex-log-viewer-cli'));
    assert.equal(result.files >= 2, true);
    assert.match(
      await fs.readFile(path.join(codexHome, 'skills', 'apex-log-viewer-cli', 'SKILL.md'), 'utf8'),
      /sf electivus skills install/
    );
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
});

test('executeElectivus triage reports unavailable local bodies as warnings, not log errors', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-triage-missing-'));
  const result = (await executeElectivus([
    'logs',
    'triage',
    '07L000000000004AAA',
    '--target-org',
    'definitely-not-a-local-org@example.com',
    '--workspace-root',
    workspaceRoot
  ])) as any[];

  assert.equal(result[0]?.summary?.hasErrors, false);
  assert.equal(result[0]?.summary?.reasons?.[0]?.severity, 'warning');
});

test('executeElectivus triages cached local bodies when target org auth cannot resolve', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-triage-cache-fallback-'));
  const logId = '07L000000000005AAA';
  await fs.mkdir(path.join(workspaceRoot, 'apexlogs', 'orgs', 'cached@example.com', 'logs', '2026-07-06'), {
    recursive: true
  });
  await fs.writeFile(
    path.join(workspaceRoot, 'apexlogs', 'orgs', 'cached@example.com', 'logs', '2026-07-06', `${logId}.log`),
    '45.0 APEX_CODE,FINEST\n10:00:00.0 (1)|EXCEPTION_THROWN|[1]|System.Exception: local cache\n'
  );

  const result = (await executeElectivus([
    'logs',
    'triage',
    logId,
    '--target-org',
    'definitely-not-a-local-org@example.com',
    '--workspace-root',
    workspaceRoot
  ])) as any[];

  assert.equal(result[0]?.summary?.hasErrors, true);
  assert.equal(result[0]?.summary?.primaryReason, 'Fatal exception');
});

test('summarizeTraceFlagRecords collapses active flags by resolved target', () => {
  const status = summarizeTraceFlagRecords({
    target: { type: 'automatedProcess' },
    targetLabel: 'Automated Process',
    resolvedIds: ['005000000000001AAA', '005000000000002AAA'],
    records: [
      {
        Id: '0Tf000000000001AAA',
        TracedEntityId: '005000000000001AAA',
        StartDate: '2026-01-01T00:00:00.000+0000',
        ExpirationDate: '2999-01-01T00:00:00.000+0000',
        DebugLevel: { DeveloperName: 'ALV_Debug' }
      },
      {
        Id: '0Tf000000000002AAA',
        TracedEntityId: '005000000000001AAA',
        StartDate: '2026-01-01T00:00:00.000+0000',
        ExpirationDate: '2999-01-01T00:00:00.000+0000',
        DebugLevel: { DeveloperName: 'ALV_Debug' }
      }
    ]
  });

  assert.equal(status.isActive, true);
  assert.equal(status.resolvedTargetCount, 2);
  assert.equal(status.activeTargetCount, 1);
  assert.equal(status.traceFlagId, undefined);
  assert.deepEqual(status.traceFlagIds, ['0Tf000000000001AAA']);
  assert.equal(status.debugLevelName, undefined);
  assert.equal(status.debugLevelMixed, true);
});

test('summarizeTraceFlagRecords reports one debug level only when all targets match', () => {
  const status = summarizeTraceFlagRecords({
    target: { type: 'platformIntegration' },
    targetLabel: 'Platform Integration',
    resolvedIds: ['005000000000001AAA', '005000000000002AAA'],
    records: [
      {
        Id: '0Tf000000000001AAA',
        TracedEntityId: '005000000000001AAA',
        StartDate: '2026-01-01T00:00:00.000+0000',
        ExpirationDate: '2999-01-01T00:00:00.000+0000',
        DebugLevel: { DeveloperName: 'ALV_Debug' }
      },
      {
        Id: '0Tf000000000002AAA',
        TracedEntityId: '005000000000002AAA',
        StartDate: '2026-01-01T00:00:00.000+0000',
        ExpirationDate: '2999-01-01T00:00:00.000+0000',
        DebugLevel: { DeveloperName: 'ALV_Debug' }
      }
    ]
  });

  assert.equal(status.activeTargetCount, 2);
  assert.equal(status.debugLevelName, 'ALV_Debug');
  assert.equal(status.debugLevelMixed, false);
});
