import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  alignConnectionApiVersion,
  buildApexLogListSoql,
  executeElectivus,
  formatJsonResult,
  formatTextResult,
  materializeCachedLogAtDatedPath,
  normalizeSoqlDateTimeLiteral,
  parseApexLogIds,
  removeLegacyLogIndexFiles,
  resolveLogDeleteIds,
  resolveOrgRequestPath,
  shouldUseOrgMaxApiVersion,
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

test('executeElectivus logs status without a workspace flag uses the current directory cache', async () => {
  const result = (await executeElectivus(['logs', 'status'])) as any;

  assert.equal(result.workspace_root, process.cwd());
  assert.equal(result.apexlogs_root, path.join(process.cwd(), 'apexlogs'));
  assert.equal(result.state_file, path.join(process.cwd(), 'apexlogs', '.alv', 'sync-state.json'));
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

  assert.deepEqual(calls, [
    'query:SELECT Id FROM ApexClass',
    'queryMore:/services/data/v63.0/tooling/query/01g-page-2'
  ]);
  assert.equal(result.done, true);
  assert.equal(result.totalSize, 3);
  assert.deepEqual(
    result.records?.map(record => record.Id),
    ['01p000000000001AAA', '01p000000000002AAA', '01p000000000003AAA']
  );
});

test('alignConnectionApiVersion falls back when configured API version is above the org max', async () => {
  let apiVersion = '65.0';
  const result = await alignConnectionApiVersion({
    getApiVersion: () => apiVersion,
    setApiVersion: value => {
      apiVersion = value;
    },
    retrieveMaxApiVersion: async () => '61.0'
  } as any);

  assert.equal(result, '61.0');
  assert.equal(apiVersion, '61.0');
  assert.equal(shouldUseOrgMaxApiVersion('65.0', '61.0'), true);
  assert.equal(shouldUseOrgMaxApiVersion('60.0', '61.0'), false);
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

test('parseApexLogIds normalizes comma and whitespace separated ApexLog ids', () => {
  assert.deepEqual(
    parseApexLogIds('07L000000000010AAA, invalid\n07L000000000011AAA 07L000000000010AAA'),
    ['07L000000000010AAA', '07L000000000011AAA']
  );
});

test('resolveLogDeleteIds reads --ids-file before scoped delete fallback', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-delete-ids-'));
  await fs.writeFile(
    path.join(workspaceRoot, 'ids.txt'),
    '07L000000000012AAA\nnot-an-id\n07L000000000013AAA\n'
  );

  const ids = await resolveLogDeleteIds({
    ids: '07L000000000012AAA,07L000000000014AAA',
    idsProvided: true,
    idsFile: 'ids.txt',
    idsFileProvided: true,
    cwd: workspaceRoot
  });

  assert.deepEqual(ids, ['07L000000000012AAA', '07L000000000014AAA', '07L000000000013AAA']);
});

test('resolveLogDeleteIds rejects empty explicit id sources', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-delete-empty-'));
  await fs.writeFile(path.join(workspaceRoot, 'ids.txt'), 'not-an-id\n');

  await assert.rejects(
    resolveLogDeleteIds({
      idsFile: 'ids.txt',
      idsFileProvided: true,
      cwd: workspaceRoot
    }),
    /No valid ApexLog ids were found in --ids-file/
  );
  await assert.rejects(
    resolveLogDeleteIds({ ids: 'not-an-id', idsProvided: true }),
    /No valid ApexLog ids were found in --ids/
  );
});

test('executeElectivus rejects invalid log delete scopes before live deletes', async () => {
  await assert.rejects(
    executeElectivus(['logs', 'delete', '--scope', 'alll', '--yes']),
    /Invalid --scope value/
  );
});

test('executeElectivus rejects conflicting trace flag targets', async () => {
  await assert.rejects(
    executeElectivus([
      'trace-flags',
      'apply',
      '--current-user',
      '--automated-process',
      '--debug-level',
      'ALV_DEBUG',
      '--yes'
    ]),
    /Trace flag target flags are mutually exclusive/
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

  const datedPath = await materializeCachedLogAtDatedPath(workspaceRoot, 'demo@example.com', {
    Id: logId,
    StartTime: '2026-07-06T10:00:00.000+0000'
  });

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
  const result = (await executeElectivus(['skills', 'install', '--codex-home', codexHome])) as any;

  assert.equal(result.status, 'installed');
  assert.equal(result.skill_name, 'apex-log-viewer-cli');
  assert.equal(result.skillName, 'apex-log-viewer-cli');
  assert.equal(result.codex_home, codexHome);
  assert.equal(result.destination_dir, path.join(codexHome, 'skills', 'apex-log-viewer-cli'));
  assert.deepEqual(result.files, ['SKILL.md', 'agents/openai.yaml']);
  assert.equal(result.fileCount, 2);
  assert.equal(result.dry_run, false);
  assert.equal(result.replaced, false);
  assert.match(
    await fs.readFile(path.join(codexHome, 'skills', 'apex-log-viewer-cli', 'SKILL.md'), 'utf8'),
    /sf electivus skills install/
  );
});

test('executeElectivus refuses to replace an installed Codex skill without force', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-codex-existing-'));
  const skillDir = path.join(codexHome, 'skills', 'apex-log-viewer-cli');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'custom skill', 'utf8');

  await assert.rejects(
    executeElectivus(['skills', 'install', '--codex-home', codexHome]),
    /rerun with --force/
  );
  assert.equal(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), 'custom skill');
});

test('executeElectivus force replaces an installed Codex skill', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-codex-force-'));
  const skillDir = path.join(codexHome, 'skills', 'apex-log-viewer-cli');
  await fs.mkdir(path.join(skillDir, 'agents'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'custom skill', 'utf8');
  await fs.writeFile(path.join(skillDir, 'agents', 'stale.yaml'), 'stale', 'utf8');

  const result = (await executeElectivus(['skills', 'install', '--codex-home', codexHome, '--force'])) as any;

  assert.equal(result.status, 'replaced');
  assert.equal(result.replaced, true);
  assert.equal(result.dry_run, false);
  assert.match(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), /sf electivus skills install/);
  await assert.rejects(fs.access(path.join(skillDir, 'agents', 'stale.yaml')));
});

test('executeElectivus skills install dry-run does not replace files', async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'electivus-codex-dry-run-'));
  const skillDir = path.join(codexHome, 'skills', 'apex-log-viewer-cli');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'custom skill', 'utf8');

  const result = (await executeElectivus(['skills', 'install', '--codex-home', codexHome, '--dry-run'])) as any;

  assert.equal(result.status, 'would_replace');
  assert.equal(result.replaced, false);
  assert.equal(result.dry_run, true);
  assert.equal(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), 'custom skill');
  await assert.rejects(fs.access(path.join(skillDir, 'agents', 'openai.yaml')));
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
