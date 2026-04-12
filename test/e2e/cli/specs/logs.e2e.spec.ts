import { access } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '../fixtures/alvCliE2E';

test('logs sync --json downloads the seeded Apex log into the workspace cache', async ({ runCli, workspacePath, seededLog }) => {
  const result = await runCli(['logs', 'sync', '--json']);

  expect(result.exitCode).toBe(0);
  expect(result.json?.status).toBe('success');
  expect(Number(result.json?.downloaded ?? 0)).toBeGreaterThanOrEqual(1);
  expect(result.json?.last_synced_log_id).toBeTruthy();
  expect(result.json?.last_synced_log_id).toBe(seededLog.logId);
  expect(String(result.json?.target_org || '')).toContain('@');

  const syncStatePath = path.join(workspacePath, 'apexlogs', '.alv', 'sync-state.json');
  await expect(access(syncStatePath)).resolves.toBeUndefined();
});
