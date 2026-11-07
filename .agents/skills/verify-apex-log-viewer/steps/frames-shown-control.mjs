// Checks the harness: with the Logs panel hidden and a copy in the editor area, both frames call their toolbar
// visible but only the editor copy can be clicked. Requires h.logsFrame() to return that one.
const TOOLBAR = '[data-testid="logs-open-debug-flags"]';

export default async function ({ page, h, expect }) {
  await h.runCommandWhenAvailable('Electivus Apex Logs: Refresh Logs');
  await h.closeQuickInput();
  await h.logsFrame(180_000);
  const tab = page.locator('.tabs-container .tab', { hasText: 'Apex Logs' });
  try {
    await h.runCommand('Electivus Apex Logs: Open Logs in Editor Area');
    await expect(tab).toHaveCount(1, { timeout: 30_000 });
    await h.runCommand('View: Hide Panel');
    await expect(page.locator('.part.panel')).toBeHidden();

    const clickable = frame =>
      frame
        .locator(TOOLBAR)
        .first()
        .click({ trial: true, timeout: 5_000 })
        .then(
          () => true,
          () => false
        );
    await expect
      .poll(
        async () => {
          const copies = [];
          for (const frame of page.frames()) {
            if (
              await frame
                .locator(TOOLBAR)
                .first()
                .isVisible()
                .catch(() => false)
            ) {
              copies.push(await clickable(frame));
            }
          }
          return copies.sort();
        },
        { message: 'one Logs copy that can be clicked and one that cannot', timeout: 60_000 }
      )
      .toEqual([false, true]);

    expect(await clickable(await h.logsFrame(30_000)), 'h.logsFrame() returned the hidden panel copy').toBe(true);
    return { frames: 2, helperReturnedTheShownCopy: true };
  } finally {
    if ((await tab.count()) > 0) {
      await tab.first().click();
      await h.runCommand('View: Close Editor');
    }
    await h.runCommand('Electivus Apex Logs: Refresh Logs');
    await h.closeQuickInput();
  }
}
