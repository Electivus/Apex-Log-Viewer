// Custom Logs view → open one row in the transaction viewer, which selects that entry; optionally its linked Apex log.
// args: { source?: string, rowId?: string, title?: string, openApexLog?: boolean }
//   source: the label in the Source picker (only needed when the org has several ready sources)
//   rowId (or the older logId) / title: which listed row to open, by record id or by text in the row, such as
//   its message; the first row when both are omitted. A title is typed into the list's search first, so a row
//   below the fold of the virtual list can be opened too.
export default async function ({ h, expect, args }) {
  // Custom Logs is experimental and off by default; a user turns it on in the workspace settings.
  await h.setWorkspaceSetting('electivus.apexLogViewer.customLogs.enabled', true);
  await h.runCommandWhenAvailable('Electivus Apex Logs: Refresh Custom Logs');
  await h.closeQuickInput();
  const logs = await h.customLogsFrame(180_000);

  if (args.source) {
    await logs.getByTestId('custom-logs-source').click();
    await logs.getByRole('option', { name: args.source }).click();
  }

  const rows = logs.locator('[data-row-id]');
  await expect(rows.first()).toBeVisible({ timeout: 180_000 });
  const search = logs.getByRole('searchbox', { name: 'Search loaded rows' });
  if (args.title) {
    await search.fill(args.title);
  }
  const rowId = args.rowId ?? args.logId;
  const row = rowId
    ? logs.locator(`[data-row-id="${rowId}"]`)
    : args.title
      ? rows.filter({ hasText: args.title }).first()
      : rows.first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  const openedId = await row.getAttribute('data-row-id');
  // An entry row names its transaction in the Log column, and the viewer's header shows that name.
  const headers = await logs.locator('[role="columnheader"]').allInnerTexts();
  const logColumn = headers.findIndex(header => header.trim() === 'Log');
  const logName =
    logColumn >= 0 ? (await row.locator('[role="gridcell"]').nth(logColumn).innerText()).trim() : undefined;
  const listShot = await h.shot('custom-logs-list', logs);
  await h.dismissNotifications();
  await row.dblclick();

  const viewer = await h.customLogViewerFrame(120_000, logName || undefined);
  const selected = viewer.locator(`[data-entry-id="${openedId}"][aria-selected="true"]`);
  await expect(selected).toBeVisible({ timeout: 120_000 });
  await expect(selected).toBeInViewport();
  const title = await viewer.getByTestId('custom-log-viewer-title').innerText();
  const entryCount = await viewer.locator('[data-entry-id]').count();
  const selectedText = await selected.innerText();
  const viewerShot = await h.shot('custom-log-viewer', viewer);
  const result = { openedId, logName, title, entryCount, selectedText, listShot, viewerShot };

  if (args.openApexLog) {
    const openApexLog = viewer.getByRole('button', { name: 'Open Apex log' });
    await expect(openApexLog).toBeVisible({ timeout: 30_000 });
    await openApexLog.click();
    const apex = await h.viewerFrame(180_000);
    result.apexLogShot = await h.shot('apex-log-from-custom-log', apex);
  } else {
    // Without a link the header explains why: no trace flag, no request id, or no access to debug logs.
    const hint = viewer.getByTestId('custom-log-apex-hint');
    result.apexLogHint = (await hint.count()) ? await hint.innerText() : undefined;
  }
  if (args.title) {
    await search.fill('');
  }
  return result;
}
