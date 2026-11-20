import { test, expect } from '../fixtures/alvE2E';
import { runCommandWhenAvailable } from '../utils/commandPalette';
import { closeQuickInputIfOpen, dismissAllNotifications } from '../utils/notifications';
import { webviewWith } from '../utils/webviews';

test('searches a gitignored Apex log body and opens it in the Log Viewer panel', async ({ vscodePage, seededLog }) => {
  // Activate the extension by running a contributed command.
  // (The command will be updated to ensure the Logs view is visible.)
  await runCommandWhenAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
  await closeQuickInputIfOpen(vscodePage);

  const logsFrame = webviewWith(vscodePage, 'logs-open-debug-flags');
  await expect(logsFrame.getByTestId('logs-open-debug-flags')).toBeVisible({ timeout: 180_000 });

  const searchInput = logsFrame.locator('input[type="search"]').first();
  const rows = logsFrame.locator('[role="row"][tabindex="0"]');
  await searchInput.waitFor({ state: 'visible', timeout: 60_000 });
  await searchInput.fill(seededLog.marker);
  await expect.poll(() => rows.count(), { timeout: 180_000 }).toBeGreaterThan(0);
  const matchingRow = logsFrame.locator(`[data-log-id="${seededLog.logId}"]`);
  await expect(matchingRow).toBeVisible({ timeout: 180_000 });
  await expect(matchingRow.locator('mark.match-highlight').filter({ hasText: seededLog.marker }).first()).toBeVisible({
    timeout: 180_000
  });

  await dismissAllNotifications(vscodePage);
  await closeQuickInputIfOpen(vscodePage);
  await matchingRow.click();

  const viewerFrame = webviewWith(vscodePage, 'log-viewer');
  await expect(viewerFrame.getByTestId('log-viewer')).toBeVisible({ timeout: 180_000 });

  // The header lists the file name beside the entry point; it should include the seeded log id (e.g., 07L...log).
  await expect(viewerFrame.locator(`text=${seededLog.logId}`).first()).toBeVisible({ timeout: 60_000 });

  // Use the built-in search to ensure the marker is present in the parsed entries.
  const viewerSearchInput = viewerFrame.locator('input[placeholder=\"Search entries…\"]');
  await viewerSearchInput.waitFor({ state: 'visible', timeout: 60_000 });
  await viewerSearchInput.fill(seededLog.marker);
  await expect(viewerFrame.locator(`text=${seededLog.marker}`).first()).toBeVisible({ timeout: 60_000 });
});
