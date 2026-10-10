// Logs panel → search a log body → open the matching row in the Log Viewer.
// args: { query?: string, logId?: string } — defaults to the log seeded at session start.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export default async function ({ h, expect, session, args }) {
  const query = args.query || session.seeded?.marker;
  const logId = args.logId || session.seeded?.logId;
  if (!query || !logId) {
    throw new Error('Pass {"query","logId"} or start the session with seeding enabled.');
  }

  await h.runCommandWhenAvailable('Electivus Apex Logs: Refresh Logs');
  await h.closeQuickInput();
  const logs = await h.logsFrame(180_000);
  const search = logs.locator('input[type="search"]').first();
  await search.waitFor({ state: 'visible', timeout: 60_000 });
  await search.fill(query);

  const row = logs.locator(`[data-log-id="${logId}"]`);
  await expect(row).toBeVisible({ timeout: 180_000 });
  await expect(row.locator('mark.match-highlight').filter({ hasText: query }).first()).toBeVisible({
    timeout: 180_000
  });
  // The panel is ~260 px tall; maximize it so the matching row is inside the shot, then restore the layout.
  await h.runCommand('View: Toggle Maximized Panel');
  const panelShot = await h.shot('logs-search-match', logs);
  await h.runCommand('View: Toggle Maximized Panel');
  await h.closeQuickInput();

  await h.dismissNotifications();
  await row.click();
  await row.press('Enter');

  const viewer = await h.viewerFrame(180_000);
  await expect(viewer.locator(`text=${logId}`).first()).toBeVisible({ timeout: 60_000 });
  const viewerSearch = viewer.locator('input[placeholder="Search entries…"]');
  await viewerSearch.fill(query);
  await expect(viewer.locator(`text=${query}`).first()).toBeVisible({ timeout: 60_000 });
  const viewerShot = await h.shot('log-viewer-open', viewer);

  // Side effect: searching downloads log bodies into the workspace's gitignored apexlogs/ cache.
  const cached = (await readdir(path.join(session.workspacePath, 'apexlogs'), { recursive: true })).filter(file =>
    file.endsWith(`${logId}.log`)
  );
  expect(cached.length).toBeGreaterThan(0);
  return { query, logId, panelShot, viewerShot, cachedLogFiles: cached };
}
