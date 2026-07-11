import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, sfJsonResult, test } from '../fixtures/alvCliE2E';
import { getOrgAuth } from '../../utils/tooling';

async function findFileNamed(rootDir: string, fileName: string): Promise<string | undefined> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFileNamed(entryPath, fileName);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
  }

  return undefined;
}

test('logs sync --json downloads the seeded Apex log into the workspace cache', async ({ syncLogs, workspacePath, seededLog, scratchAlias }) => {
  const scratchAuth = await getOrgAuth(scratchAlias);
  const { result, json } = await syncLogs();

  expect(result.exitCode).toBe(0);
  expect(json).toBeTruthy();
  expect(json?.status).toBe('success');
  expect(Number(json?.downloaded ?? 0)).toBeGreaterThanOrEqual(1);
  expect(json?.lastSyncedLogId).toBeTruthy();
  expect(json?.lastSyncedLogId).toBe(seededLog.logId);
  expect(scratchAuth.username).toBeTruthy();
  expect(json?.targetOrg).toBe(scratchAuth.username);
  expect(String(json?.safeTargetOrg || '')).toBeTruthy();

  const syncStatePath = path.join(workspacePath, 'apexlogs', '.alv', 'sync-state.json');
  await expect(access(syncStatePath)).resolves.toBeUndefined();

  const canonicalOrgRoot = path.join(workspacePath, 'apexlogs', 'orgs', String(json?.safeTargetOrg || ''));
  const orgMetadataPath = path.join(canonicalOrgRoot, 'org.json');
  await expect(access(orgMetadataPath)).resolves.toBeUndefined();

  const orgMetadata = JSON.parse(await readFile(orgMetadataPath, 'utf8'));
  expect(orgMetadata.resolvedUsername).toBe(json?.targetOrg);
  expect(orgMetadata.targetOrg).toBe(scratchAlias);
  expect(orgMetadata.safeTargetOrg).toBe(json?.safeTargetOrg);

  const seededLogPath = await findFileNamed(path.join(canonicalOrgRoot, 'logs'), `${seededLog.logId}.log`);
  expect(seededLogPath).toBeTruthy();
});

test('logs status --json reports sync metadata for the seeded scratch org', async ({ runCli, seededLog, syncLogs, scratchAlias }) => {
  const { json: syncJson } = await syncLogs();
  const result = await runCli(['log', 'status', '--json', '--target-org', scratchAlias]);
  const json = sfJsonResult(result);

  expect(result.exitCode).toBe(0);
  expect(json).toBeTruthy();
  expect(json?.targetOrg).toBe(syncJson?.targetOrg);
  expect(json?.safeTargetOrg).toBe(syncJson?.safeTargetOrg);
  expect(json?.hasState).toBe(true);
  expect(Number(json?.downloadedCount ?? 0)).toBeGreaterThanOrEqual(1);
  expect(json?.lastSyncedLogId).toBe(seededLog.logId);
  expect(Number(json?.logCount ?? 0)).toBeGreaterThanOrEqual(1);
});
