import { runCommandWhenAvailable } from '../utils/commandPalette';
import { dismissAllNotifications } from '../utils/notifications';
import { test, expect } from '../fixtures/alvE2E';
import { waitForWebviewFrame } from '../utils/webviews';

test.describe.configure({ mode: 'serial' });

test('opens logs in a separate window via the native editor move flow', async ({ vscodeApp, vscodePage }) => {
  expect(vscodeApp.windows().length).toBeGreaterThanOrEqual(1);

  const newWindowPromise = vscodeApp.waitForEvent('window', { timeout: 180_000 });

  await dismissAllNotifications(vscodePage);
  await runCommandWhenAvailable(vscodePage, 'Electivus Apex Logs: Open Logs in New Window', {
    timeoutMs: 120_000
  });

  const logsWindow = await newWindowPromise;
  await logsWindow.waitForLoadState('domcontentloaded');

  expect(logsWindow).not.toBe(vscodePage);
  await expect.poll(() => vscodeApp.windows().length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

  const logsFrame = await waitForWebviewFrame(
    logsWindow,
    async frame => await frame.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );

  await expect(logsFrame.locator('[data-testid="logs-open-debug-flags"]').first()).toBeVisible({ timeout: 60_000 });
  await expect(logsFrame.locator('input[type="search"]').first()).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => await logsFrame.locator('[role="row"][tabindex="0"]').count(), { timeout: 180_000 })
    .toBeGreaterThan(0);
});
