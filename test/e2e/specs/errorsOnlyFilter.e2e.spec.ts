import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures/alvNoSeed';
import { runCommandWhenAvailable } from '../utils/commandPalette';
import { clearOrgApexLogs, seedApexErrorLog, seedApexLog } from '../utils/seedLog';
import { expectWebviewWithout, webviewWith } from '../utils/webviews';

const ROW = '[role="row"][tabindex="0"]';
const ERROR_BADGE = '[data-testid="logs-error-badge"]';
const REASON_BADGE = '[data-testid="logs-reason-badge"]';

async function setErrorsOnlyEnabled(errorsOnlySwitch: Locator, enabled: boolean): Promise<void> {
  const currentState = await errorsOnlySwitch.getAttribute('data-state');
  const isChecked = currentState === 'checked';
  if (isChecked !== enabled) {
    await errorsOnlySwitch.click();
  }
  await expect(errorsOnlySwitch).toHaveAttribute('data-state', enabled ? 'checked' : 'unchecked');
}

test('filters logs using errors-only toggle', async ({ vscodePage, scratchAlias }) => {
  await clearOrgApexLogs(scratchAlias, 'all');

  const seededLog = await seedApexLog(scratchAlias);
  const seededErrorLog = await seedApexErrorLog(scratchAlias);

  await runCommandWhenAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });

  const logsFrame = webviewWith(vscodePage, 'logs-errors-only-switch');
  await expect(logsFrame.getByTestId('logs-errors-only-switch')).toBeVisible({ timeout: 180_000 });

  const searchInput = logsFrame.locator('input[type="search"]');
  const rows = logsFrame.locator(ROW);
  const errorsOnlySwitch = logsFrame.locator('[data-testid="logs-errors-only-switch"]').first();
  const errorBadges = logsFrame.locator(ERROR_BADGE);
  const reasonBadges = logsFrame.locator(REASON_BADGE);

  await searchInput.waitFor({ state: 'visible', timeout: 60_000 });

  await setErrorsOnlyEnabled(errorsOnlySwitch, false);
  await searchInput.fill(seededLog.marker);
  await expect.poll(async () => await rows.count(), { timeout: 180_000 }).toBeGreaterThan(0);
  await expectWebviewWithout(logsFrame, ERROR_BADGE);
  await expectWebviewWithout(logsFrame, REASON_BADGE);

  await setErrorsOnlyEnabled(errorsOnlySwitch, true);
  await expectWebviewWithout(logsFrame, ROW, { timeout: 180_000 });

  await searchInput.fill(seededErrorLog.marker);
  await expect.poll(async () => await rows.count(), { timeout: 180_000 }).toBeGreaterThan(0);
  await expect.poll(async () => await errorBadges.count(), { timeout: 180_000 }).toBeGreaterThan(0);
  await expect.poll(async () => await reasonBadges.count(), { timeout: 180_000 }).toBeGreaterThan(0);
  await expect(reasonBadges.first()).toHaveText('Fatal exception', { timeout: 180_000 });
});
