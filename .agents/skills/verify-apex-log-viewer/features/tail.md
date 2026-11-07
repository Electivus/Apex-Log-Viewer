# Tail

Tail streams new Apex logs from the selected org while it runs. The user picks a debug level and presses Start. Each new log appears as a header row followed by its lines and is saved into the workspace `apexlogs/` store. A selected log can be opened in the Log Viewer or in Apex Replay.

## Sub-features

- `tail-start-stop` toggles streaming with one button labelled `Start` / `Stop`. `Stop` appears once Salesforce acknowledges the subscription, and a log written since Start is listed and shown then. While idle an empty list says `Press Start to tail logs.`, and while running `Waiting for logs…`. Start is disabled only while the view loads.
- `tail-trace-flag`: Start moves the authenticated user's newest `DEVELOPER_LOG` trace flag to the chosen level, starting now and expiring in 30 minutes, and creates one when none exists. It never touches `USER_DEBUG` flags. Before that it marks the 20 newest logs as already seen, and after it subscribes to the Streaming API topic `/systemTopic/Logging`. Tail stops itself after 30 minutes with `Tail stopped after 30 minutes.`.
- `tail-debug-level` sets that level through the `Debug level` select (`tail-debug-level`, uppercase through CSS). It opens on the level of the user's active `DEVELOPER_LOG` flag, otherwise on the first level by name. Webview state remembers one level per org username, set by a pick or by Start. A remembered level that the org no longer has falls back the same way, and a pick on one org does not change the level on another.
- `tail-org` selects the org with the `Org` picker (`getByRole('combobox').first()`, then the option, as in [logs-panel.md](logs-panel.md)). Switching org stops the tail and clears the buffer.
- `tail-stream` shows each new log as `=== ApexLog <logId> | <StartTime> | <operation> | <status> | <size in bytes>`, then `Saved to <absolute path>/apexlogs/orgs/<safe org username>/logs/<YYYY-MM-DD>/<logId>.log`, then the log lines.
- `tail-search` filters the buffer line by line with `Search live logs…`: only lines that contain the text remain, so the header row hides unless the text is in it, such as the log id.
- `tail-view-options` provides the `Debug Only`, `Color` and `Auto-scroll` switches. A click on a row or a scroll up pauses `Auto-scroll`, and a scroll back to the end resumes a scroll's pause.
- `tail-actions` provides `Clear`, `Open Log` (Log Viewer), `Replay Debugger` and `Debug Flags`. `Open Log` and `Replay Debugger` need a selected row.
- `tail-editor-area` uses `Open Tail in Editor Area` to open a second, independent Tail in an editor tab. Closing that tab stops its tail (`Tail webview detached; stopped tail (hostDisposed).` in the Output log). Running the command again reveals the tab and resets it to the panel's org.

## How to get to it (user POV)

- Run `Electivus Apex Logs: Tail Logs` from the command palette. It reveals the view and copies the Logs panel's org; it does not press Start.
- Click the `Apex Tail` tab in the bottom panel.
- Run `Electivus Apex Logs: Open Tail in Editor Area`.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`. Session seeding created the `ALV_E2E` debug level that the canned step picks.

- **Start and stream.** Run `node .agents/skills/verify-apex-log-viewer/scripts/verify.mjs run tail-live`. It requires the `Org` select to show `session.org.alias`, maximizes the panel, stops a tail left running, turns `Debug Only` off, picks `ALV_E2E` (keeping the current level when the org has no `ALV_E2E`), clears the buffer and presses Start. As soon as `Stop` appears it runs its own anonymous Apex, finds the marker line through `Search live logs…`, reads that log's id from the org and checks its `=== ApexLog <id>` row, and stops. It returns `ok: true` with `debugLevel`, `marker`, `logId`, the `header` row, `flagDuringTail` (the user's `DEVELOPER_LOG` flags while Tail ran; the newest is at that level and expires 30 minutes after Start, older expired ones stay as they were), `debugOnlyWasOn` and `tailShot`. On every exit after the snapshot, it stops Tail, restores those flags' level and dates, deletes a flag Start created, turns `Debug Only` back on if it was on, and puts the panel size back; a cleanup failure is reported, never swallowed. `'{"debugLevel":"<name>"}'` tests exactly that level and fails if it does not exist.
- **Saved file.** After the run, `<session.workspacePath>/apexlogs/orgs/<safe org username>/logs/<date>/<logId>.log` exists. Read it in a step, or check `workspace-files.json` after `stop`.
- **Open Log and Replay.** While tailing, click the `=== ApexLog <logId>` row in `h.tailFrame()`, then `Open Log`. `h.frameWith('text=<logId>.log')` then shows that log. `Replay Debugger` on the same row shows the `Apex Replay Debugger is unavailable…` toast, because the session does not install that extension.
- **Search and Debug Only.** Fill `getByLabel('Search live logs…')` with the marker: the `Execute Anonymous:` line and the `USER_DEBUG` line remain. With `getByRole('switch', { name: 'Debug Only' })` on, only `USER_DEBUG` lines remain.
- **Scroll.** Use `page.mouse.wheel` over a row on screen, such as the last one. The list is virtualized, so its first DOM row can be off screen, and a wheel there scrolls nothing.
- **Second channels.** The extension's Output log (copied to `vscode-logs/` at stop) has `Tail: TraceFlag updated or already matching for level <level>` (or `Tail: ensure TraceFlag failed (continuing) -> <reason>` when the flag could not be written; Tail still subscribes), `Tail: primed seen set with N of M recent logs`, `Tail: subscribed to /systemTopic/Logging`, `Tail: backfilling log <id>` and `Tail: saved log <id> to <path>`. Read the trace flag through Tooling as in `tail-live`.
- **Proof.** Shoot the Tail frame while the panel is maximized, so the streamed rows are inside the screenshot.

## Gotchas

- A streamed row can take about 12 s to appear after its Apex returns. On the harness scratch the delay was either about 1 s or about 12 s, so do not read a missing row as a broken stream before that.
- The toolbar fills the default panel and the list is virtualized, so streamed rows are not in the DOM until the panel is taller. Maximize it, and find a log by filling `Search live logs…` with its marker; `text=<marker>` on the whole list misses rows below the fold, especially with `Auto-scroll` paused.
- Org and level reloads cover the toolbar with a loading overlay (`getByRole('status')`). Wait for it to go, and click without `force`: twice in a row, a forced click made right after `Tail Logs` revealed the panel never reached the host.
- Start moves the seeded `ALV_E2E` flag. After a Start with another level, `h.seedLog()` finds no `ALV_E2E` flag, posts a second overlapping one and fails with `FIELD_INTEGRITY_EXCEPTION`. Steps that press Start must restore the flag, as `tail-live` does, and emit logs with `h.tooling.executeAnonymousApex(auth, apex)` while Tail runs.
- The webview remembers the debug level per org, so a run without an explicit choice tests whatever the previous run picked on that org. It also remembers `Debug Only`, which hides the `=== ApexLog` header and `Saved to` rows: a step that asserts them turns the switch off first and back on afterwards, as `tail-live` does.
- Logs created before Start do not stream. Stop the tail before your step returns, because a running tail keeps its subscription and adds rows to later screenshots.
