// Custom Logs view → open one record in the transaction viewer, optionally its linked Apex log.
// args: { source?: string, logId?: string, title?: string, openApexLog?: boolean }
//   source: the label in the Source picker (only needed when the org has several ready sources)
//   logId / title: which listed row to open; the first row when both are omitted
export default async function ({ h, expect, args }) {
  await h.runCommandWhenAvailable('Electivus Apex Logs: Refresh Custom Logs');
  await h.closeQuickInput();
  const logs = await h.customLogsFrame(180_000);

  if (args.source) {
    await logs.getByTestId('custom-logs-source').click();
    await logs.getByRole('option', { name: args.source }).click();
  }

  const rows = logs.locator('[data-row-id]');
  await expect(rows.first()).toBeVisible({ timeout: 180_000 });
  const row = args.logId
    ? logs.locator(`[data-row-id="${args.logId}"]`)
    : args.title
      ? rows.filter({ hasText: args.title }).first()
      : rows.first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  const listShot = await h.shot('custom-logs-list', logs);
  await h.dismissNotifications();
  await row.dblclick();

  const viewer = await h.customLogViewerFrame(120_000, args.title);
  const entries = viewer.locator('[data-entry-id]');
  await expect(entries.first()).toBeVisible({ timeout: 120_000 });
  const title = await viewer.getByTestId('custom-log-viewer-title').innerText();
  const entryCount = await entries.count();
  const viewerShot = await h.shot('custom-log-viewer', viewer);
  const result = { title, entryCount, listShot, viewerShot };

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
  return result;
}
