import { test, expect } from '../fixtures/alvE2E';
import { runCommandWhenAvailable } from '../utils/commandPalette';
import { closeQuickInputIfOpen, dismissAllNotifications } from '../utils/notifications';
import { waitForWebviewFrame } from '../utils/webviews';

test('searches a gitignored Apex log body and opens it in the Log Viewer panel', async ({ vscodePage, seededLog }) => {
  // Activate the extension by running a contributed command.
  // (The command will be updated to ensure the Logs view is visible.)
  await runCommandWhenAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
  await closeQuickInputIfOpen(vscodePage);

  const logsFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );

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

  // Select the matching row and press Enter to open (LogRow binds Enter/Space to open).
  await dismissAllNotifications(vscodePage);
  await closeQuickInputIfOpen(vscodePage);
  await matchingRow.click();
  await matchingRow.press('Enter');

  // Find the Log Viewer panel webview by its stable header text.
  const viewerFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('text=Apex Log Viewer').first().isVisible(),
    { timeoutMs: 180_000 }
  );

  await expect(viewerFrame.locator('text=Apex Log Viewer').first()).toBeVisible();

  // The header shows the file name; it should include the seeded log id (e.g., 07L...log).
  await expect(viewerFrame.locator(`text=${seededLog.logId}`).first()).toBeVisible({ timeout: 60_000 });

  // Use the built-in search to ensure the marker is present in the parsed entries.
  const viewerSearchInput = viewerFrame.locator('input[placeholder=\"Search entries…\"]');
  await viewerSearchInput.waitFor({ state: 'visible', timeout: 60_000 });
  await viewerSearchInput.fill(seededLog.marker);
  await expect(viewerFrame.locator(`text=${seededLog.marker}`).first()).toBeVisible({ timeout: 60_000 });
});
