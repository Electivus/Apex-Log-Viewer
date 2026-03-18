import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures/alvNoSeed';
import { runCommandWhenAvailable } from '../utils/commandPalette';
import { clearOrgApexLogs, seedApexErrorLog, seedApexLog } from '../utils/seedLog';
import { waitForWebviewFrame } from '../utils/webviews';

async function setErrorsOnlyEnabled(
  errorsOnlySwitch: Locator,
  enabled: boolean
): Promise<void> {
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

  const logsFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('[data-testid="logs-errors-only-switch"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );

  const searchInput = logsFrame.locator('input[type="search"]');
  const rows = logsFrame.locator('[role="row"][tabindex="0"]');
  const errorsOnlySwitch = logsFrame.locator('[data-testid="logs-errors-only-switch"]').first();
  const errorBadges = logsFrame.locator('[data-testid="logs-error-badge"]');
  const reasonBadges = logsFrame.locator('[data-testid="logs-reason-badge"]');

  await searchInput.waitFor({ state: 'visible', timeout: 60_000 });
  await expect(searchInput).toBeEnabled({ timeout: 180_000 });

  await setErrorsOnlyEnabled(errorsOnlySwitch, false);
  await searchInput.fill(seededLog.marker);
  await expect
    .poll(async () => await rows.count(), { timeout: 180_000 })
    .toBeGreaterThan(0);
  await expect(errorBadges).toHaveCount(0);
  await expect(reasonBadges).toHaveCount(0);

  await setErrorsOnlyEnabled(errorsOnlySwitch, true);
  await expect
    .poll(async () => await rows.count(), { timeout: 180_000 })
    .toBe(0);

  await searchInput.fill(seededErrorLog.marker);
  await expect
    .poll(async () => await rows.count(), { timeout: 180_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => await errorBadges.count(), { timeout: 180_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => await reasonBadges.count(), { timeout: 180_000 })
    .toBeGreaterThan(0);
  await expect(reasonBadges.first()).toHaveText('Fatal exception', { timeout: 180_000 });
});
