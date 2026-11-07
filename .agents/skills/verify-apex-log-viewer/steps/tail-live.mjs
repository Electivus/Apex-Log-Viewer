// Tail view → pick a debug level → Start → emit a new Apex log → the live row appears → Stop, and put the
// user's DEVELOPER_LOG flags and the Debug Only switch back the way the step found them.
// args: { debugLevel?: string } — exact level to test, which must exist. Without it, picks ALV_E2E; when ALV_E2E
// is missing, keeps the current level, or picks the first one when none is set.
import { userDeveloperLogFlags } from './lib/traceFlags.mjs';

export default async function ({ page, h, expect, session, args }) {
  await h.runCommandWhenAvailable('Electivus Apex Logs: Tail Logs');
  await h.closeQuickInput();
  const tail = await h.tailFrame(180_000);
  await expect(tail.locator('[data-testid="tail-open-debug-flags"]').first()).toBeEnabled({ timeout: 180_000 });
  // Org and level reloads cover the toolbar with a loading overlay (Tail's only role=status); a forced click
  // during it is lost.
  const idle = () => expect(tail.getByRole('status')).toHaveCount(0, { timeout: 60_000 });
  const stopButton = tail.getByRole('button', { name: 'Stop' });
  const startButton = tail.getByRole('button', { name: 'Start' });
  const stopTail = async () => {
    if (await stopButton.isVisible().catch(() => false)) {
      await stopButton.click();
      await expect(startButton).toBeVisible({ timeout: 60_000 });
    }
  };
  // Debug Only persists in webview state and hides the `=== ApexLog` header rows this step asserts.
  const debugOnly = tail.getByRole('switch', { name: 'Debug Only' });
  const setDebugOnly = async on => {
    if (((await debugOnly.getAttribute('aria-checked')) === 'true') !== on) {
      await debugOnly.click();
      await expect(debugOnly).toHaveAttribute('aria-checked', String(on));
    }
  };

  const flags = await userDeveloperLogFlags(h, session);
  let flagsBefore;
  let debugOnlyWasOn;
  let stepError;
  try {
    await idle();
    await expect(
      tail.getByRole('combobox').first(),
      `Refusing to press Start, which writes a trace flag, unless Tail shows the session org '${session.org.alias}'`
    ).toHaveText(session.org.alias, { timeout: 30_000 });
    // A tail left running by an earlier step would skip Start, and its flag changes would look like the baseline.
    await stopTail();
    debugOnlyWasOn = (await debugOnly.getAttribute('aria-checked')) === 'true';
    await setDebugOnly(false);

    const level = tail.locator('[data-testid="tail-debug-level"]').first();
    await level.waitFor({ state: 'visible', timeout: 60_000 });
    const levelText = async () => ((await level.textContent()) || '').replace(/\s+/g, ' ').trim();
    const placeholder = /^(|select)$/i;
    const current = await levelText();
    // The webview remembers the last level, so without an argument pick ALV_E2E again instead of keeping it.
    const wanted = args.debugLevel || 'ALV_E2E';
    if (current !== wanted) {
      await level.click();
      const listbox = tail.locator('[role="listbox"]').last();
      await listbox.waitFor({ state: 'visible', timeout: 30_000 });
      const option = listbox.getByRole('option', { name: wanted, exact: true }).first();
      if (args.debugLevel || (await option.isVisible().catch(() => false))) {
        // A requested level must exist; never fall back to testing a different one.
        await option.click({ timeout: 30_000 });
      } else if (placeholder.test(current)) {
        await listbox
          .getByRole('option')
          .filter({ hasNotText: /^\s*select\s*$/i })
          .first()
          .click();
      } else {
        await page.keyboard.press('Escape');
      }
    }
    if (args.debugLevel) {
      await expect.poll(levelText, { timeout: 30_000 }).toBe(args.debugLevel);
    } else {
      await expect.poll(levelText, { timeout: 30_000 }).not.toMatch(placeholder);
    }

    // Start points the user's newest DEVELOPER_LOG flag, the harness seed, at the chosen level for 30 minutes
    // (and creates one when none exists). Snapshot the flags before it; `finally` puts them back.
    flagsBefore = await flags.read();
    const search = tail.getByLabel('Search live logs…');
    await search.fill('');
    await tail.getByRole('button', { name: 'Clear' }).click();
    await expect(startButton).toBeEnabled({ timeout: 60_000 });
    await startButton.click();
    await expect(
      stopButton,
      `Tail did not start on ${session.org.alias} with level ${await levelText()} (see Gotchas in features/tail.md)`
    ).toBeVisible({ timeout: 60_000 });

    // h.seedLog() would renew the seed flag Tail just moved (or, after a Start at another level, fail on
    // Tail's overlapping flag), so run the anonymous Apex directly; Tail's own trace flag makes the log.
    const marker = `ALV_TAIL_MARKER_${Date.now()}`;
    const emittedAfter = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await h.tooling.executeAnonymousApex(flags.auth, `System.debug('${marker}');`);
    const flagDuringTail = (await flags.read()).map(f => ({
      id: f.Id,
      debugLevel: f.DebugLevel?.DeveloperName,
      expirationDate: f.ExpirationDate
    }));
    // Search filters the buffer inside the webview, so the marker lines render even when auto-scroll is paused.
    await search.fill(marker);
    await expect(tail.locator('[role="row"]', { hasText: marker }).first()).toBeAttached({ timeout: 180_000 });
    await search.fill('');
    // The anonymous run above is this user's only executeAnonymous log since just before it; its row must be there.
    const [log] = await flags.query(
      `SELECT Id FROM ApexLog WHERE LogUserId = '${flags.userId}' AND Operation LIKE '%executeAnonymous%' AND StartTime >= ${emittedAfter} ORDER BY StartTime DESC LIMIT 1`,
      { toolingApi: false }
    );
    // The panel is short and Auto-scroll pins the list to the end, so filter to the header row to keep it rendered.
    await search.fill(`=== ApexLog ${log?.Id}`);
    const header = tail.locator('[role="row"]', { hasText: `=== ApexLog ${log?.Id}` }).first();
    await expect(header).toBeAttached({ timeout: 30_000 });
    const headerText = (await header.innerText()).trim();
    const tailShot = await h.shot('tail-live-row', tail);
    return {
      debugLevel: await levelText(),
      marker,
      logId: log.Id,
      header: headerText,
      flagDuringTail,
      debugOnlyWasOn,
      tailShot
    };
  } catch (error) {
    stepError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try {
      await stopTail();
    } catch (error) {
      cleanupErrors.push(`stop: ${error.message}`);
    }
    if (flagsBefore) {
      try {
        cleanupErrors.push(...(await flags.restore(flagsBefore)).errors);
      } catch (error) {
        cleanupErrors.push(`restore: ${error.message}`);
      }
    }
    if (debugOnlyWasOn) {
      await setDebugOnly(true).catch(error => cleanupErrors.push(`Debug Only: ${error.message}`));
    }
    if (cleanupErrors.length) {
      const message = `tail-live cleanup failed; check the user's DEVELOPER_LOG flags: ${cleanupErrors.join('; ')}`;
      if (stepError) {
        // Keep the step's own failure as the reported error; the host prints its stack.
        stepError.message += `\n${message}`;
        if (typeof stepError.stack === 'string') {
          stepError.stack += `\n${message}`;
        }
      } else {
        throw new Error(message);
      }
    }
  }
}
