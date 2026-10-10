// Logs panel "Debug Flags" button → Apex Debug Flags editor → apply a USER_DEBUG trace flag to the
// E2E test user → confirm it exists in the org → remove it → confirm it is gone.
// args: { ttlMinutes?: number } — defaults to 45.
export default async function ({ h, expect, args }) {
  const auth = await h.orgAuth();
  const user = await h.tooling.ensureDebugFlagsTestUser(auth);
  await h.tooling.removeUserDebugTraceFlags(auth, user.id);
  const traceFlagId = async () => (await h.tooling.getUserDebugTraceFlag(auth, user.id))?.id || '';

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

  return { user: user.username, appliedTraceFlag: applied, removed: true, appliedShot, removedShot };
}
