// Tail view → pick a debug level → Start → emit a new Apex log → the live row appears → Stop, and put the
// user's DEVELOPER_LOG flags back the way Start found them.
// args: { debugLevel?: string } — exact level to test, which must exist. Without it, picks ALV_E2E; when ALV_E2E
// is missing, keeps the current level, or picks the first one when none is set.
export default async function ({ page, h, expect, session, args }) {
  await h.runCommandWhenAvailable('Electivus Apex Logs: Tail Logs');
  await h.closeQuickInput();
  const tail = await h.tailFrame(180_000);
  await expect(tail.locator('[data-testid="tail-open-debug-flags"]').first()).toBeEnabled({ timeout: 180_000 });
  // The toolbar fills the default panel and the list is virtualized, so streamed rows stay out of the DOM
  // until the panel is taller. Put the panel back at the end, because a maximized panel hides editor tabs.
  const maximized = ((await page.locator('.part.panel').boundingBox())?.height ?? 0) < 500;
  if (maximized) {
    await h.runCommand('View: Toggle Maximized Panel');
  }
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

  const auth = await h.orgAuth();
  const api = `${auth.instanceUrl}/services/data/v${auth.apiVersion}`;
  const headers = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' };
  const query = async (soql, { toolingApi = true } = {}) => {
    const res = await fetch(`${api}${toolingApi ? '/tooling' : ''}/query?q=${encodeURIComponent(soql)}`, { headers });
    if (!res.ok) {
      throw new Error(`Query failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()).records.map(({ attributes, ...record }) => record);
  };
  const [user] = await query(`SELECT Id FROM User WHERE Username = '${session.org.username}'`, { toolingApi: false });
  const flagsSoql = `SELECT Id, DebugLevelId, DebugLevel.DeveloperName, StartDate, ExpirationDate FROM TraceFlag WHERE LogType = 'DEVELOPER_LOG' AND TracedEntityId = '${user.Id}'`;

  let flagsBefore;
  let stepError;
  try {
    await idle();
    // Tail opened before the Logs panel resolves its org from the extension host's working directory, not the
    // workspace target-org (#1224), so pin the session org.
    const org = tail.getByRole('combobox').first();
    if (((await org.textContent()) || '').trim() !== session.org.alias) {
      await org.click();
      await tail
        .locator('[role="listbox"]')
        .last()
        .getByRole('option', { name: session.org.alias, exact: true })
        .first()
        .click({ timeout: 30_000 });
      await expect(org).toHaveText(session.org.alias, { timeout: 30_000 });
      await idle();
    }
    // A tail left running by an earlier step would skip Start, and its flag changes would look like the baseline.
    await stopTail();

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
    flagsBefore = await query(flagsSoql);
    const search = tail.getByLabel('Search live logs…');
    await search.fill('');
    await tail.getByRole('button', { name: 'Clear' }).click();
    await expect(startButton).toBeEnabled({ timeout: 60_000 });
    await startButton.click();
    await expect(
      stopButton,
      `Tail did not start on ${session.org.alias} with level ${await levelText()} (see Gotchas in features/tail.md)`
    ).toBeVisible({ timeout: 60_000 });

    // Stop appears before the /systemTopic/Logging subscription is live, and Salesforce does not stream a log
    // written in that window (#1225: one written 70 ms after "subscribed" never arrived). The UI shows no
    // readiness signal, so wait a few seconds before writing the log.
    await h.sleep(5_000);
    // h.seedLog() would renew the seed flag Tail just moved (or, after a Start at another level, fail on
    // Tail's overlapping flag), so run the anonymous Apex directly; Tail's own trace flag makes the log.
    const marker = `ALV_TAIL_MARKER_${Date.now()}`;
    const emittedAfter = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await h.tooling.executeAnonymousApex(auth, `System.debug('${marker}');`);
    const flagDuringTail = (await query(flagsSoql)).map(f => ({
      id: f.Id,
      debugLevel: f.DebugLevel?.DeveloperName,
      expirationDate: f.ExpirationDate
    }));
    // Search filters the buffer inside the webview, so the marker lines render even when auto-scroll is paused.
    await search.fill(marker);
    await expect(tail.locator('[role="row"]', { hasText: marker }).first()).toBeAttached({ timeout: 180_000 });
    await search.fill('');
    // The anonymous run above is this user's only executeAnonymous log since just before it; its row must be there.
    const [log] = await query(
      `SELECT Id FROM ApexLog WHERE LogUserId = '${user.Id}' AND Operation LIKE '%executeAnonymous%' AND StartTime >= ${emittedAfter} ORDER BY StartTime DESC LIMIT 1`,
      { toolingApi: false }
    );
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
        const known = new Map(flagsBefore.map(f => [f.Id, f]));
        for (const now of await query(flagsSoql)) {
          const before = known.get(now.Id);
          if (!before) {
            // Start created this flag because the user had none.
            const res = await fetch(`${api}/tooling/sobjects/TraceFlag/${now.Id}`, { method: 'DELETE', headers });
            if (!res.ok) cleanupErrors.push(`delete TraceFlag ${now.Id}: ${res.status} ${await res.text()}`);
          } else if (now.DebugLevelId !== before.DebugLevelId || now.ExpirationDate !== before.ExpirationDate) {
            const res = await fetch(`${api}/tooling/sobjects/TraceFlag/${before.Id}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({
                DebugLevelId: before.DebugLevelId,
                StartDate: before.StartDate,
                ExpirationDate: before.ExpirationDate
              })
            });
            if (!res.ok) cleanupErrors.push(`restore TraceFlag ${before.Id}: ${res.status} ${await res.text()}`);
          }
        }
      } catch (error) {
        cleanupErrors.push(`restore: ${error.message}`);
      }
    }
    if (maximized) {
      await h.runCommand('View: Toggle Maximized Panel').catch(error => cleanupErrors.push(`panel: ${error.message}`));
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
