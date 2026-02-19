import { test, expect } from '../fixtures/alvE2E';
import { runCommand, waitForCommandAvailable } from '../utils/commandPalette';
import { waitForWebviewFrame } from '../utils/webviews';

test('opens the seeded Apex log in the Log Viewer panel', async ({ vscodePage, seededLog }) => {
  // Activate the extension by running a contributed command.
  // (The command will be updated to ensure the Logs view is visible.)
  await waitForCommandAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
  await runCommand(vscodePage, 'Electivus Apex Logs: Refresh Logs');

  // VS Code webviews often load their actual content in a child frame hosted on
  // a `.../fake.html?...` URL. Grab that frame first, then wait for log rows.
  const logsFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => /\/fake\.html\?id=/i.test(frame.url()),
    { timeoutMs: 180_000 }
  );

  await expect
    .poll(() => logsFrame.locator('[role="row"][tabindex="0"]').count(), { timeout: 180_000 })
    .toBeGreaterThan(0);

  // Select the first row and press Enter to open (LogRow binds Enter/Space to open).
  const firstRow = logsFrame.locator('[role="row"][tabindex="0"]').first();
  await firstRow.click();
  await firstRow.press('Enter');

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
  const searchInput = viewerFrame.locator('input[placeholder=\"Search entries…\"]');
  await searchInput.waitFor({ state: 'visible', timeout: 60_000 });
  await searchInput.fill(seededLog.marker);
  await expect(viewerFrame.locator(`text=${seededLog.marker}`).first()).toBeVisible({ timeout: 60_000 });
});
