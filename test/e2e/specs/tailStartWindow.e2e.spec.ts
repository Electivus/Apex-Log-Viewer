import { expect, test } from '../fixtures/alvE2E';
import { ensureE2eTraceFlag, executeAnonymousApex, getOrgAuth } from '../utils/tooling';
import { runCommand } from '../utils/commandPalette';
import { waitForWebviewFrame } from '../utils/webviews';

test('Tail opened before Logs targets the workspace org and shows a log written right after Start', async ({
  vscodePage,
  scratchAlias
}) => {
  const auth = await getOrgAuth(scratchAlias);
  await ensureE2eTraceFlag(auth);

  await runCommand(vscodePage, 'Electivus Apex Logs: Tail Logs');
  const tail = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('[data-testid="tail-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
  await expect(tail.getByRole('status')).toHaveCount(0, { timeout: 180_000 });
  await expect(tail.getByRole('combobox').first()).toContainText(scratchAlias, { timeout: 60_000 });

  await runCommand(vscodePage, 'View: Toggle Maximized Panel');
  const start = tail.getByRole('button', { name: 'Start' });
  const stop = tail.getByRole('button', { name: 'Stop' });
  await expect(start).toBeEnabled({ timeout: 60_000 });

  const marker = `ALV_TAIL_START_WINDOW_${Date.now()}`;
  await start.click();
  await executeAnonymousApex(auth, `System.debug('${marker}');`);
  try {
    await expect(stop).toBeVisible({ timeout: 60_000 });
    await tail.getByLabel('Search live logs…').fill(marker);
    await expect(tail.locator('[role="row"]', { hasText: marker }).first()).toBeAttached({ timeout: 60_000 });
  } finally {
    await stop.click({ timeout: 5_000 }).catch(() => undefined);
  }
});
