# Logs panel

The Logs panel lists the Apex logs in the selected org. A user can refresh it, filter it, search inside log bodies, narrow it to logs with errors, download or delete logs, jump from a row to the Log Viewer or Apex Replay, and open Debug Flags from the toolbar. A refresh also starts a background sync that copies every new org log into the workspace's `apexlogs/` store, which search reads.

## Sub-features

- `logs-list` loads one page of rows (`logs.pageSize`, default 100, at least 10 and at most 200) with the columns User, Application, Operation, Time, Duration, Status, Size and Match. Clicking a header sorts by it (`[role="columnheader"][aria-sort]`), except Match, which has no sort; the default is Time, descending. `Load more logs` pages on, and reads `Load more results` while a filter is active.
- `logs-org` switches orgs with the `Org` select. The palette command `Electivus Apex Logs: Select Org` opens a QuickPick with the placeholder `Select an authenticated org`.
- `logs-sync` runs on a refresh, unless one succeeded in the last 5 minutes. Then only the error scan runs, which caches the loaded rows' logs and does not rewrite `sync-state.json`. The sync caches each new log at `apexlogs/orgs/<safe org username>/logs/<YYYY-MM-DD>/<logId>.log`, where the date is the log's StartTime day, and writes `apexlogs/.alv/sync-state.json`.
- `logs-search` matches row metadata at once and log bodies 300 ms after the last keystroke, so a typed word sends one search to the host. Changing the text hides, at once, rows that matched only the previous query. Search reads only the cached bodies of the loaded rows; below the search box, `Waiting for 1 log to finish downloading…` or `Waiting for N logs…` counts those still downloading. Body hits show the Match snippet with `mark.match-highlight`.
- `logs-filters` narrows rows with the `User`, `Operation` and `Status` selects (labels look uppercase through CSS). Their options are the distinct values of the loaded rows plus `All`. `Clear filters` resets them, the search text and `Errors only`.
- `logs-errors-only` limits rows to logs with failures. Matching rows show `logs-error-badge` and a `logs-reason-badge` such as `Fatal exception`.
- `logs-columns` shows, hides and reorders columns in the `Columns` popover (a switch per column, `Move up`, `Move down`, `Reset to defaults`). A header's `[role="separator"][aria-label="Resize <Column>"]` resizes it (`widths` in the setting). The layout persists to the user (Global) setting `electivus.apexLogViewer.logs.columns`.
- `logs-download-all` asks `Download all Apex logs for the selected org?` in a modal, runs a forced full sync of every org log while its notification counts `Processed n/N logs…` and fills its bar as each log is saved, and ends with `Bulk download finished. N logs are available locally (D downloaded, C already cached).`
- `logs-cleanup` uses `Clear logs` to choose `Delete my logs` or `Delete all org logs`, asks in a modal (`Delete your Apex logs for the selected org?`), and reports `Deleted N Apex log(s).`
- `logs-open` opens a row in the Log Viewer with Enter or Space on the focused row, or its `Open` button (`button[aria-label="Open"]`).
- `logs-replay` starts Apex Replay from the row button `Apex Replay` or Shift+Enter. This needs the Replay Debugger extension.
- `logs-editor-area` uses `Open Logs in Editor Area` to open a second, independent Logs UI in an editor tab, with its own search, filters and org. Running the command again reveals the tab and resets it to the panel's org.
- `logs-support`: `Electivus Apex Logs: Show Extension Output` shows the `Electivus Apex Log Viewer` channel in the Output panel. `Electivus Apex Logs: Copy Diagnostics Package` writes Markdown headed `# Electivus Apex Logs Diagnostics` to the system clipboard, replacing what is there, and confirms with `Electivus Apex Logs: diagnostics package copied to clipboard.`. The view title's `...` menu holds both.

## How to get to it (user POV)

- Run `Electivus Apex Logs: Refresh Logs` from the command palette. This activates the extension and reveals the `Electivus Apex Logs` panel tab.
- Click the `Electivus Apex Logs` tab in the bottom panel.
- Run `Electivus Apex Logs: Open Logs in Editor Area`, or use the panel's title-bar action.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`.
- To test `logs-errors-only`, an error log exists (`await h.seedErrorLog()`).

- **Open the panel.** In a step, call `await h.runCommandWhenAvailable('Electivus Apex Logs: Refresh Logs'); await h.closeQuickInput(); const logs = await h.logsFrame(180_000);`. The frame contains `[data-testid="logs-open-debug-flags"]` and an `input[type="search"]`.
- **Org.** Maximize the panel first; in the short panel the option list cannot be clicked. `logs.getByRole('combobox').first().click()`, then `logs.getByRole('option', { name: alias, exact: true })`.
- **Search a body.** Fill `logs.locator('input[type="search"]').first()` with `session.seeded.marker`, as `logs-open-viewer` does. `[data-log-id="<logId>"]` becomes visible and contains `mark.match-highlight` with the marker. Afterwards `readdir(path.join(session.workspacePath, 'apexlogs'), { recursive: true })` lists `<logId>.log`. The canned step `logs-open-viewer` asserts all of this.
- **Debounce.** Type the marker with `search.pressSequentially(marker, { delay: 60 })`. The extension's Output log, `<userDataDir>/logs/<stamp>/window1/exthost/electivus.apex-log-viewer/Electivus Apex Log Viewer.log` (`userDataDir` is in `output/verify/session/session.json`), gains one `Logs: setSearchQuery` line, not one per character.
- **Errors only.** Seed with `const e = await h.seedErrorLog()`, then search `e.marker` and click `[data-testid="logs-errors-only-switch"]` until `data-state="checked"`. `[data-testid="logs-reason-badge"]` reads `Fatal exception`. Searching the plain seeded marker with the switch on leaves zero `[role="row"][tabindex="0"]` rows. Second channel: `node … sf -- log triage --log-id <e.logId> --json` reports `primaryReason: "Fatal exception"`.
- **Filters.** The select has no test id: use `logs.locator('div:has(> label:text-is("Status"))').getByRole('combobox')`. Every harness log is `Success` from the same user and operation, so the options are only `All` and the one value, and the row count does not drop. A real filter test needs logs with different values.
- **Columns.** Maximize the panel first (`View: Toggle Maximized Panel`); in the short panel the popover's switches cannot be clicked. Turn off `getByRole('switch', { name: 'Application' })`, check the header is gone and the profile's `User/settings.json` has `"application": false`, then `Reset to defaults`. Before you drag a separator, call `scrollIntoViewIfNeeded()`: the table scrolls sideways, so a drag from a stale position lands on the workbench and later clicks time out.
- **Download all and cleanup.** `Clear logs` opens a popover with the buttons `Delete my logs` and `Delete all org logs`. Click the button, then the dialog's button on `page`: `page.locator('.monaco-dialog-box').getByRole('button', { name: 'Download', exact: true })` (or `Delete`). Check the toast with `h.toasts()`, and the org with `node … sf -- log list --json` or a Tooling count. `Delete my logs` also deletes the seeded log, so run `h.seedLog()` afterwards and use its new id.
- **Replay.** Click `button[aria-label="Apex Replay"]` on a row. Without the Replay Debugger, `h.toasts()` holds `Apex Replay Debugger is unavailable. Install the Salesforce Extension Pack…`.
- **Proof.** `await h.shot('logs-<feature>', logs)` after each state change. For tall result sets, run `await h.runCommand('View: Toggle Maximized Panel')` first.

## Gotchas

- The org keeps logs from earlier sessions and CI runs, so always search a fresh marker instead of counting rows.
- The search box and the toolbar are disabled while a refresh loads. A `fill` right after `Refresh Logs` can land as the box flips and be dropped without an error (1 run in 4 at no delay), so assert `toHaveValue` and retry, as `logs-open-viewer` does.
- Search waits for the background sync to cache the bodies. Assert with `expect(...).toBeVisible({ timeout: 180_000 })`, never a fixed sleep.
- Rows are virtualized: rows outside the visible area are not in the DOM, so `[role="row"][tabindex="0"]` counts rendered rows only. The panel is short in the default window.
- With the editor-area copy open, two frames match `h.logsFrame()` and it returns the first on screen. Hide the panel (`View: Hide Panel`) to drive the editor tab; `frames-shown-control` proves it.
- The modals are VS Code dialogs. The session profile sets `window.dialogStyle: custom` so they render as `.monaco-dialog-box` on `page`; with the native default, Playwright cannot click them.
- `Clear logs` → `Delete all org logs` deletes logs created by other users of the scratch org. That is acceptable in a harness org, but never do it with `--target-org` on a real org unless the user asked.
- `logs-replay` needs `salesforce.salesforcedx-vscode-apex-replay-debugger`. The verify session does not install it, so a session-driven replay click proves only the missing-extension path. For the installed path, use `pnpm run test:e2e -- test/e2e/specs/replayDebugger.e2e.spec.ts`.
