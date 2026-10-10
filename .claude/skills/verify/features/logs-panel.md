# Logs panel

The Logs panel lists the Apex logs in the selected org. A user can refresh it, filter it, search inside log bodies (which downloads them into the workspace's `apexlogs/` store), narrow it to logs with errors, delete logs from the org, and jump from a row to the Log Viewer, Apex Replay or Debug Flags.

## Sub-features

- `logs-list` loads rows (user, application, operation, time, duration, status, size) for the session org.
- `logs-org` switches orgs with the `ORG` picker.
- `logs-search` searches log bodies and highlights matches (`mark.match-highlight`). As a side effect it caches each searched log at `apexlogs/orgs/<user>/logs/<date>/<logId>.log` and writes `apexlogs/.alv/sync-state.json`.
- `logs-filters` narrows rows with the `USER`, `OPERATION` and `STATUS` selects. `Clear filters` resets them.
- `logs-errors-only` limits rows to logs with failures. Matching rows show `logs-error-badge` and a `logs-reason-badge` such as `Fatal exception`.
- `logs-columns` shows, hides, reorders and resizes columns through `Columns`. The layout persists to the `electivus.apexLogViewer.logs.columns` setting.
- `logs-download-all` uses `Download all logs` to fetch every listed log into `apexlogs/`.
- `logs-cleanup` uses `Clear logs` to choose `Delete my logs` or `Delete all org logs`, confirms in a modal, and reports progress in a notification.
- `logs-open` opens a row in the Log Viewer by clicking it and pressing `Enter`.
- `logs-replay` starts Apex Replay from the row button `Apex Replay`. This needs the Replay Debugger extension.
- `logs-editor-area` uses `Open Logs in Editor Area` to host the same UI in an editor tab.

## How to get to it (user POV)

- Run `Electivus Apex Logs: Refresh Logs` from the command palette. This activates the extension and reveals the `Electivus Apex Logs` panel tab.
- Click the `Electivus Apex Logs` tab in the bottom panel.
- Run `Electivus Apex Logs: Open Logs in Editor Area`, or use the panel's title-bar action.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`.
- To test `logs-errors-only`, an error log exists (`await h.seedErrorLog()`).

- **Open the panel.** In a step, call `await h.runCommandWhenAvailable('Electivus Apex Logs: Refresh Logs'); await h.closeQuickInput(); const logs = await h.logsFrame(180_000);`. The frame contains `[data-testid="logs-open-debug-flags"]` and an `input[type="search"]`.
- **Search a body.** `await logs.locator('input[type="search"]').first().fill(session.seeded.marker)`. `[data-log-id="<logId>"]` becomes visible and contains `mark.match-highlight` with the marker. Afterwards `readdir(path.join(session.workspacePath, 'apexlogs'), { recursive: true })` lists `<logId>.log`. The canned step `logs-open-viewer` asserts all of this.
- **Errors only.** Seed with `const e = await h.seedErrorLog()`, then search `e.marker` and click `[data-testid="logs-errors-only-switch"]` until `data-state="checked"`. `[data-testid="logs-reason-badge"]` reads `Fatal exception`. Searching the plain seeded marker with the switch on leaves zero `[role="row"][tabindex="0"]` rows.
- **Filters.** Open the `USER`, `OPERATION` or `STATUS` select and pick an option. The row count drops. `Clear filters` restores it.
- **Cleanup (destructive).** Click `Clear logs`, choose `Delete my logs`, then confirm `Delete` in the VS Code modal on `page`. Check that `h.toasts()` reports `Deleted N Apex log(s).`, and that `h.tooling` or `node … sf -- log list --json` shows the logs are gone. Seed again afterwards for later steps.
- **Proof.** `await h.shot('logs-<feature>', logs)` after each state change. For tall result sets, run `await h.runCommand('View: Toggle Maximized Panel')` first.

## Gotchas

- The org keeps logs from earlier sessions and CI runs, so always search a fresh marker instead of counting rows.
- Search waits for log bodies to download. Assert with `expect(...).toBeVisible({ timeout: 180_000 })`, never a fixed sleep.
- The panel is short in the default window. Rows can exist below the fold even though screenshots do not show them.
- `Clear logs` → `Delete all org logs` deletes logs created by other users of the scratch org. That is acceptable in a pool org, but never do it with `--target-org` on a real org unless the user asked.
- `logs-replay` needs `salesforce.salesforcedx-vscode-apex-replay-debugger`. The verify session does not install it, so a session-driven replay click proves only the missing-extension path. For the installed path, use `pnpm run test:e2e -- test/e2e/specs/replayDebugger.e2e.spec.ts`.
