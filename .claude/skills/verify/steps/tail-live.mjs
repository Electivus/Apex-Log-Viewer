// Tail view → pick a debug level → Start → emit a new Apex log → the live row appears.
// args: { debugLevel?: string } — exact level to test; without it, keeps the current level or picks ALV_E2E / the first option.
export default async function ({ h, expect, session, args }) {
  await h.runCommandWhenAvailable('Electivus Apex Logs: Tail Logs');
  await h.closeQuickInput();
  const tail = await h.tailFrame(180_000);
  await expect(tail.locator('[data-testid="tail-open-debug-flags"]').first()).toBeEnabled({ timeout: 180_000 });

  // Tail does not always default to the workspace target-org when several orgs are authenticated
  // (seen: it picked another alias while the Logs panel showed the session org), so pin the session org.
  const org = tail.getByRole('combobox').first();
  if (((await org.textContent()) || '').trim() !== session.org.alias) {
    await org.click({ force: true });
    await tail
      .locator('[role="listbox"]')
      .last()
      .getByRole('option', { name: session.org.alias, exact: true })
      .first()
      .click({ force: true, timeout: 30_000 });
    await expect(org).toHaveText(session.org.alias, { timeout: 30_000 });
  }

  const level = tail.locator('[data-testid="tail-debug-level"]').first();
  await level.waitFor({ state: 'visible', timeout: 60_000 });
  const levelText = async () => ((await level.textContent()) || '').replace(/\s+/g, ' ').trim();
  const current = await levelText();
  const unset = !current || /^select$/i.test(current);
  if (args.debugLevel ? current !== args.debugLevel : unset) {
    await level.click({ force: true });
    const listbox = tail.locator('[role="listbox"]').last();
    await listbox.waitFor({ state: 'visible', timeout: 30_000 });
    if (args.debugLevel) {
      // A requested level must exist; never fall back to testing a different one.
      await listbox
        .getByRole('option', { name: args.debugLevel, exact: true })
        .first()
        .click({ force: true, timeout: 30_000 });
    } else {
      const preferred = listbox.getByRole('option', { name: 'ALV_E2E', exact: true }).first();
      await ((await preferred.isVisible().catch(() => false)) ? preferred : listbox.getByRole('option').first()).click({
        force: true
      });
    }
  }
  if (args.debugLevel) {
    await expect.poll(levelText, { timeout: 30_000 }).toBe(args.debugLevel);
  } else {
    await expect.poll(levelText, { timeout: 30_000 }).not.toMatch(/^(|select)$/i);
  }

  const startButton = tail.getByRole('button', { name: 'Start' });
  if (await startButton.isVisible().catch(() => false)) {
    await startButton.click({ force: true });
  }
  await expect(
    tail.getByRole('button', { name: 'Stop' }),
    `Tail did not start on ${session.org.alias} with level ${await levelText()} (see Gotchas in features/tail.md)`
  ).toBeVisible({ timeout: 60_000 });

  const emitted = await h.seedLog();
  await expect(tail.locator(`text=${emitted.marker}`).first()).toBeVisible({ timeout: 180_000 });
  const tailShot = await h.shot('tail-live-row', tail);

  await tail.getByRole('button', { name: 'Stop' }).click({ force: true });
  await expect(tail.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 60_000 });
  return { debugLevel: await levelText(), marker: emitted.marker, logId: emitted.logId, tailShot };
}
