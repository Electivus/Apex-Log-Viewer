import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '../fixtures/alvCliE2E';
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

test('logs sync --json downloads the seeded Apex log into the workspace cache', async ({ runCli, workspacePath, seededLog, scratchAlias }) => {
  const scratchAuth = await getOrgAuth(scratchAlias);
  const result = await runCli(['logs', 'sync', '--json', '--target-org', scratchAlias]);
  const json = result.stdoutJson;

  expect(result.exitCode).toBe(0);
  expect(json).toBeTruthy();
  expect(json?.status).toBe('success');
  expect(Number(json?.downloaded ?? 0)).toBeGreaterThanOrEqual(1);
  expect(json?.last_synced_log_id).toBeTruthy();
  expect(json?.last_synced_log_id).toBe(seededLog.logId);
  expect(scratchAuth.username).toBeTruthy();
  expect(json?.target_org).toBe(scratchAuth.username);
  expect(String(json?.safe_target_org || '')).toBeTruthy();

  const syncStatePath = path.join(workspacePath, 'apexlogs', '.alv', 'sync-state.json');
  await expect(access(syncStatePath)).resolves.toBeUndefined();

  const canonicalOrgRoot = path.join(workspacePath, 'apexlogs', 'orgs', String(json?.safe_target_org || ''));
  const orgMetadataPath = path.join(canonicalOrgRoot, 'org.json');
  await expect(access(orgMetadataPath)).resolves.toBeUndefined();

  const orgMetadata = JSON.parse(await readFile(orgMetadataPath, 'utf8'));
  expect(orgMetadata.resolvedUsername).toBe(json?.target_org);
  expect(orgMetadata.targetOrg).toBe(scratchAlias);
  expect(orgMetadata.safeTargetOrg).toBe(json?.safe_target_org);

  const seededLogPath = await findFileNamed(path.join(canonicalOrgRoot, 'logs'), `${seededLog.logId}.log`);
  expect(seededLogPath).toBeTruthy();
});
