// Tail view → pick a debug level → Start → emit a new Apex log → the live row appears.
// args: { debugLevel?: string } — defaults to ALV_E2E (created by session seeding) or the first option.
export default async function ({ h, expect, args }) {
  await h.runCommandWhenAvailable('Electivus Apex Logs: Tail Logs');
  await h.closeQuickInput();
  const tail = await h.tailFrame(180_000);
  await expect(tail.locator('[data-testid="tail-open-debug-flags"]').first()).toBeEnabled({ timeout: 180_000 });

  const level = tail.locator('[data-testid="tail-debug-level"]').first();
  await level.waitFor({ state: 'visible', timeout: 60_000 });
  const levelText = async () => ((await level.textContent()) || '').replace(/\s+/g, ' ').trim();
  if (!(await levelText()) || /^select$/i.test(await levelText())) {
    await level.click({ force: true });
    const listbox = tail.locator('[role="listbox"]').last();
    await listbox.waitFor({ state: 'visible', timeout: 30_000 });
    const preferred = listbox.getByRole('option', { name: args.debugLevel || 'ALV_E2E' }).first();
    await ((await preferred.isVisible().catch(() => false)) ? preferred : listbox.getByRole('option').first()).click({
      force: true
    });
  }
  await expect.poll(levelText, { timeout: 30_000 }).not.toMatch(/^(|select)$/i);

  const startButton = tail.getByRole('button', { name: 'Start' });
  if (await startButton.isVisible().catch(() => false)) {
    await startButton.click({ force: true });
  }
  await expect(tail.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 60_000 });

  const emitted = await h.seedLog();
  await expect(tail.locator(`text=${emitted.marker}`).first()).toBeVisible({ timeout: 180_000 });
  const tailShot = await h.shot('tail-live-row', tail);

  await tail.getByRole('button', { name: 'Stop' }).click({ force: true });
  await expect(tail.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 60_000 });
  return { debugLevel: await levelText(), marker: emitted.marker, logId: emitted.logId, tailShot };
}
