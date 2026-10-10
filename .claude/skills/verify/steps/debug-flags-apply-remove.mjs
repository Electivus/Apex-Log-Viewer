// Logs panel "Debug Flags" button → Apex Debug Flags editor → apply a USER_DEBUG trace flag to the
// E2E test user → confirm it exists in the org → remove it → confirm it is gone.
// args: { ttlMinutes?: number, currentUser?: boolean } — TTL defaults to 45. currentUser targets the
// authenticated user, which is also the fallback when the org has no spare license for the E2E user.
export default async function ({ h, expect, args }) {
  const auth = await h.orgAuth();
  const currentUserId = await h.tooling.getCurrentUserId(auth);
  const user = args.currentUser
    ? { id: currentUserId, username: auth.username }
    : await h.tooling.ensureDebugFlagsTestUser(auth);
  // The authenticated user's flag (seeded ALV_E2E, or a real one with --target-org) is not ours to lose:
  // snapshot it and put it back. A leftover flag on the dedicated E2E user is just cleared.
  const prior = user.id === currentUserId ? await h.tooling.getUserDebugTraceFlag(auth, user.id) : undefined;
  await h.tooling.removeUserDebugTraceFlags(auth, user.id);
  const traceFlagId = async () => (await h.tooling.getUserDebugTraceFlag(auth, user.id))?.id || '';

  try {
    const flags = await h.openDebugFlagsFromLogs();
    await flags.locator('[data-testid="debug-flags-user-search"]').fill(user.username);
    const row = flags.locator(`[data-testid="debug-flags-user-row-${user.id}"]`);
    await row.waitFor({ state: 'visible', timeout: 60_000 });
    await row.click();
    await flags.locator('[data-testid="debug-flags-ttl"]').fill(String(args.ttlMinutes || 45));

    const apply = flags.locator('[data-testid="debug-flags-apply"]');
    await expect(apply).toBeEnabled({ timeout: 120_000 });
    await apply.click();
    await expect(flags.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });
    await expect.poll(traceFlagId, { timeout: 60_000 }).not.toBe('');
    const applied = await h.tooling.getUserDebugTraceFlag(auth, user.id);
    const appliedShot = await h.shot('debug-flags-applied', flags);

    const remove = flags.locator('[data-testid="debug-flags-remove"]');
    await expect(remove).toBeEnabled({ timeout: 120_000 });
    await remove.click();
    await expect(flags.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });
    await expect.poll(traceFlagId, { timeout: 60_000 }).toBe('');
    const removedShot = await h.shot('debug-flags-removed', flags);

    return {
      user: user.username,
      appliedTraceFlag: applied,
      removed: true,
      appliedShot,
      removedShot,
      priorTraceFlag: prior
    };
  } finally {
    if (prior?.debugLevelName) {
      const minutesLeft = Math.ceil((Date.parse(prior.expirationDate || '') - Date.now()) / 60_000);
      await h.tooling.ensureE2eTraceFlag(auth, {
        debugLevelName: prior.debugLevelName,
        ttlMinutes: Number.isFinite(minutesLeft) ? Math.max(5, minutesLeft) : undefined
      });
    }
  }
}
