import { expect, test } from '../fixtures/alvE2E';
import { runCommand, waitForCommandAvailable } from '../utils/commandPalette';
import { ensureDebugFlagsTestUser, getOrgAuth } from '../utils/tooling';
import { waitForWebviewFrame } from '../utils/webviews';

async function assertUserSearchFiltering(
  debugFlagsFrame: Awaited<ReturnType<typeof waitForWebviewFrame>>,
  userId: string,
  searchToken: string
): Promise<void> {
  const searchInput = debugFlagsFrame.locator('[data-testid="debug-flags-user-search"]');
  const userRows = debugFlagsFrame.locator('[data-testid^="debug-flags-user-row-"]');
  const targetUserRow = debugFlagsFrame.locator(`[data-testid="debug-flags-user-row-${userId}"]`);
  const errorBanner = debugFlagsFrame.locator('[data-testid="debug-flags-error"]');

  const uniqueNoMatch = `__alv_e2e_user_not_found_${Date.now()}__`;

  await searchInput.fill(searchToken);
  await expect(targetUserRow).toBeVisible({ timeout: 60_000 });
  await expect(errorBanner).toHaveCount(0);

  await searchInput.fill(uniqueNoMatch);
  await expect
    .poll(async () => await userRows.count(), { timeout: 60_000 })
    .toBe(0);
  await expect(errorBanner).toHaveCount(0);

  await searchInput.fill(searchToken);
  await expect(targetUserRow).toBeVisible({ timeout: 60_000 });
  await expect(errorBanner).toHaveCount(0);
}

test('filters users correctly in debug flags panel from logs and tail entrypoints', async ({ vscodePage, scratchAlias }) => {
  const auth = await getOrgAuth(scratchAlias);
  const testUser = await ensureDebugFlagsTestUser(auth);
  const userId = testUser.id;
  const searchToken = testUser.username.split('@')[0] || testUser.username;

  await waitForCommandAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
  await runCommand(vscodePage, 'Electivus Apex Logs: Refresh Logs');

  const logsFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
  await logsFrame.locator('[data-testid="logs-open-debug-flags"]').first().click();

  const debugFlagsFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('text=Apex Debug Flags').first().isVisible(),
    { timeoutMs: 180_000 }
  );

  const searchInput = debugFlagsFrame.locator('[data-testid="debug-flags-user-search"]');
  await searchInput.waitFor({ state: 'visible', timeout: 60_000 });
  await assertUserSearchFiltering(debugFlagsFrame, userId, searchToken);

  await runCommand(vscodePage, 'Electivus Apex Logs: Tail Logs');
  const tailFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('[data-testid="tail-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
  await expect(tailFrame.locator('[data-testid="tail-open-debug-flags"]').first()).toBeEnabled({ timeout: 180_000 });
  await tailFrame.locator('[data-testid="tail-open-debug-flags"]').first().click();

  const debugFlagsFrameFromTail = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('text=Apex Debug Flags').first().isVisible(),
    { timeoutMs: 180_000 }
  );
  await expect(debugFlagsFrameFromTail.locator('text=Apex Debug Flags').first()).toBeVisible();
  await assertUserSearchFiltering(debugFlagsFrameFromTail, userId, searchToken);
});
