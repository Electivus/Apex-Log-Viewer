import { expect, test } from '../fixtures/alvE2E';
import { runCommand, waitForCommandAvailable } from '../utils/commandPalette';
import { ensureDebugFlagsTestUser, getOrgAuth, getUserDebugTraceFlag, removeUserDebugTraceFlags } from '../utils/tooling';
import { waitForWebviewFrame } from '../utils/webviews';

test('configures and removes debug flags from logs and tail entrypoints', async ({ vscodePage, scratchAlias }) => {
  const auth = await getOrgAuth(scratchAlias);
  const testUser = await ensureDebugFlagsTestUser(auth);
  const userId = testUser.id;
  await removeUserDebugTraceFlags(auth, userId);

  try {
    await waitForCommandAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
    await runCommand(vscodePage, 'Electivus Apex Logs: Refresh Logs');

    const logsFrame = await waitForWebviewFrame(
      vscodePage,
      async frame => await frame.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
      { timeoutMs: 180_000 }
    );
    const openDebugFlags = logsFrame.locator('[data-testid="logs-open-debug-flags"]').first();
    await expect(openDebugFlags).toBeEnabled({ timeout: 180_000 });
    await openDebugFlags.click();

    const debugFlagsFrame = await waitForWebviewFrame(
      vscodePage,
      async frame => await frame.locator('text=Apex Debug Flags').first().isVisible(),
      { timeoutMs: 180_000 }
    );

    const searchInput = debugFlagsFrame.locator('[data-testid="debug-flags-user-search"]');
    await searchInput.waitFor({ state: 'visible', timeout: 60_000 });
    await searchInput.fill(testUser.username);

    const userRow = debugFlagsFrame.locator(`[data-testid="debug-flags-user-row-${userId}"]`);
    await userRow.waitFor({ state: 'visible', timeout: 60_000 });
    await userRow.click();

    const ttlInput = debugFlagsFrame.locator('[data-testid="debug-flags-ttl"]');
    await ttlInput.fill('45');

    await debugFlagsFrame.locator('[data-testid="debug-flags-apply"]').click();
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(async () => {
        const status = await getUserDebugTraceFlag(auth, userId);
        return status?.id || '';
      }, { timeout: 60_000 })
      .not.toBe('');

    await debugFlagsFrame.locator('[data-testid="debug-flags-remove"]').click();
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(async () => {
        const status = await getUserDebugTraceFlag(auth, userId);
        return status?.id || '';
      }, { timeout: 60_000 })
      .toBe('');

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
  } finally {
    await removeUserDebugTraceFlags(auth, userId).catch(() => {});
  }
});
