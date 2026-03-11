import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/alvE2E';
import { runCommand, waitForCommandAvailable } from '../utils/commandPalette';
import { dismissAllNotifications } from '../utils/notifications';
import { waitForWebviewFrame } from '../utils/webviews';

test.use({ supportExtensionIds: ['salesforce.salesforcedx-vscode-apex-replay-debugger'] });

async function closeQuickInputIfOpen(page: Page): Promise<void> {
  const widget = page.locator('div.quick-input-widget');
  const visible = await widget.isVisible().catch(() => false);
  if (!visible) {
    return;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await widget.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

test('launches replay debugger from logs table without missing-extension toast', async ({ vscodePage, seededLog }) => {
  void seededLog;

  // Activate the extension by running a contributed command.
  await waitForCommandAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
  await runCommand(vscodePage, 'Electivus Apex Logs: Refresh Logs');
  await closeQuickInputIfOpen(vscodePage);

  const logsFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );

  await expect
    .poll(() => logsFrame.locator('[role="row"][tabindex="0"]').count(), { timeout: 180_000 })
    .toBeGreaterThan(0);

  // Click the per-row "Apex Replay" icon button.
  const replayButton = logsFrame.locator('button[aria-label="Apex Replay"]').first();
  await replayButton.waitFor({ state: 'visible', timeout: 60_000 });
  await dismissAllNotifications(vscodePage);
  await closeQuickInputIfOpen(vscodePage);
  await replayButton.click({ force: true });

  // Historically we surfaced a toast claiming Replay Debugger was unavailable even when installed,
  // because the dependent extension registers commands at activation time.
  await vscodePage.waitForTimeout(1_000);
  await expect(vscodePage.locator('text=Apex Replay Debugger is unavailable')).toHaveCount(0, { timeout: 5_000 });
});
