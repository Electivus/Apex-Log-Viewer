import type { Frame } from '@playwright/test';
import { expect, test } from '../fixtures/alvE2E';
import {
  ensureDebugFlagsTestUser,
  getOrgAuth,
  removeUserDebugTraceFlags,
  waitForDebugFlagsUserSearchAvailability
} from '../utils/tooling';
import { openDebugFlagsFromLogs, openDebugFlagsFromTail } from './debugFlagsPanel.shared';

async function assertUserSearchFiltering(
  debugFlagsFrame: Frame,
  userId: string,
  searchToken: string
): Promise<void> {
  const searchInput = debugFlagsFrame.locator('[data-testid="debug-flags-user-search"]');
  const userRows = debugFlagsFrame.locator('[data-testid^="debug-flags-user-row-"]');
  const targetUserRow = debugFlagsFrame.locator(`[data-testid="debug-flags-user-row-${userId}"]`);
  const errorBanner = debugFlagsFrame.locator('[data-testid="debug-flags-error"]');

  const uniqueNoMatch = `__alv_e2e_user_not_found_${Date.now()}__`;

  await searchInput.fill('');
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

async function assertSelectedScratchOrg(
  debugFlagsFrame: Frame,
  scratchAlias: string
): Promise<void> {
  await expect(debugFlagsFrame.locator('[data-testid="debug-flags-org-select"]')).toContainText(scratchAlias, {
    timeout: 60_000
  });
}

test('filters users correctly in debug flags panel from logs and tail entrypoints', async ({ vscodePage, scratchAlias }) => {
  const auth = await getOrgAuth(scratchAlias);
  const testUser = await ensureDebugFlagsTestUser(auth);
  const userId = testUser.id;
  const searchToken = testUser.username.split('@')[0] || testUser.username;
  await waitForDebugFlagsUserSearchAvailability(auth, userId, searchToken);
  await removeUserDebugTraceFlags(auth, userId).catch(() => {});

  try {
    const debugFlagsFrame = await openDebugFlagsFromLogs(vscodePage);

    const searchInput = debugFlagsFrame.locator('[data-testid="debug-flags-user-search"]');
    await searchInput.waitFor({ state: 'visible', timeout: 60_000 });
    await assertSelectedScratchOrg(debugFlagsFrame, scratchAlias);
    await assertUserSearchFiltering(debugFlagsFrame, userId, searchToken);

    const debugFlagsFrameFromTail = await openDebugFlagsFromTail(vscodePage);
    await expect(debugFlagsFrameFromTail.locator('text=Apex Debug Flags').first()).toBeVisible();
    await assertSelectedScratchOrg(debugFlagsFrameFromTail, scratchAlias);
    await assertUserSearchFiltering(debugFlagsFrameFromTail, userId, searchToken);
  } finally {
    await removeUserDebugTraceFlags(auth, userId).catch(() => {});
  }
});
