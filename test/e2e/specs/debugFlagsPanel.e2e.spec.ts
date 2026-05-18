import { expect, test } from '../fixtures/alvNoSeed';
import { getOrgAuth, getUserDebugTraceFlag, removeUserDebugTraceFlags, ensureDebugFlagsTestUser } from '../utils/tooling';
import { openDebugFlagsFromLogs, openDebugFlagsFromTail } from './debugFlagsPanel.shared';

test('configures and removes debug flags from logs and tail entrypoints', async ({ scratchAlias, vscodePage }) => {
  const auth = await getOrgAuth(scratchAlias);
  const testUser = await ensureDebugFlagsTestUser(auth);
  const userId = testUser.id;
  await removeUserDebugTraceFlags(auth, userId);

  try {
    const debugFlagsFrame = await openDebugFlagsFromLogs(vscodePage);

    const searchInput = debugFlagsFrame.locator('[data-testid="debug-flags-user-search"]');
    await searchInput.waitFor({ state: 'visible', timeout: 60_000 });
    await searchInput.fill(testUser.username);

    const userRow = debugFlagsFrame.locator(`[data-testid="debug-flags-user-row-${userId}"]`);
    await userRow.waitFor({ state: 'visible', timeout: 60_000 });
    await userRow.click({ timeout: 30_000 });

    const ttlInput = debugFlagsFrame.locator('[data-testid="debug-flags-ttl"]');
    await ttlInput.fill('45');

    const applyButton = debugFlagsFrame.locator('[data-testid="debug-flags-apply"]');
    await expect(applyButton).toBeEnabled({ timeout: 120_000 });
    await applyButton.click({ timeout: 30_000 });
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(
        async () => {
          const status = await getUserDebugTraceFlag(auth, userId);
          return status?.id || '';
        },
        { timeout: 60_000 }
      )
      .not.toBe('');

    const removeButton = debugFlagsFrame.locator('[data-testid="debug-flags-remove"]');
    await expect(removeButton).toBeEnabled({ timeout: 120_000 });
    await removeButton.click({ timeout: 30_000 });
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(
        async () => {
          const status = await getUserDebugTraceFlag(auth, userId);
          return status?.id || '';
        },
        { timeout: 60_000 }
      )
      .toBe('');

    const debugFlagsFrameFromTail = await openDebugFlagsFromTail(vscodePage);
    await expect(debugFlagsFrameFromTail.locator('text=Apex Debug Flags').first()).toBeVisible({ timeout: 60_000 });
  } finally {
    await removeUserDebugTraceFlags(auth, userId).catch(() => {});
  }
});
