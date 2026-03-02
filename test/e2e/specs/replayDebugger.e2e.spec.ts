import { test, expect } from '../fixtures/alvE2E';
import { runCommand, waitForCommandAvailable } from '../utils/commandPalette';
import { waitForWebviewFrame } from '../utils/webviews';

test('launches replay debugger from logs table without missing-extension toast', async ({ vscodePage, seededLog }) => {
  void seededLog;

  // Activate the extension by running a contributed command.
  await waitForCommandAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
  await runCommand(vscodePage, 'Electivus Apex Logs: Refresh Logs');

  const logsFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => {
      if (!/\/fake\.html\?id=/i.test(frame.url())) return false;
      const hasRefresh = await frame.locator('text=Refresh').count().catch(() => 0);
      const hasDownloadAll = await frame.locator('text=Download all logs').count().catch(() => 0);
      return hasRefresh > 0 && hasDownloadAll > 0;
    },
    { timeoutMs: 180_000 }
  );

  await expect
    .poll(() => logsFrame.locator('[role="row"][tabindex="0"]').count(), { timeout: 180_000 })
    .toBeGreaterThan(0);

  // Click the per-row "Apex Replay" icon button.
  const replayButton = logsFrame.locator('button[aria-label="Apex Replay"]').first();
  await replayButton.waitFor({ state: 'visible', timeout: 60_000 });
  await replayButton.click();

  // Historically we surfaced a toast claiming Replay Debugger was unavailable even when installed,
  // because the dependent extension registers commands at activation time.
  await vscodePage.waitForTimeout(1_000);
  await expect(vscodePage.locator('text=Apex Replay Debugger is unavailable')).toHaveCount(0, { timeout: 5_000 });
});
