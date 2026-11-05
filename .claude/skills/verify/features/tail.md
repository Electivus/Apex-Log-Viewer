# Tail

Tail streams new Apex logs from the selected org while it runs. The user picks a debug level and presses Start. Each new log appears as a header row followed by its lines and is saved into the workspace `apexlogs/` store. A selected log can be opened in the Log Viewer or in Apex Replay.

## Sub-features

- `tail-start-stop` toggles streaming with one button labelled `Start` / `Stop`. While idle the list says `Press Start to tail logs.`. Start is disabled only while the view loads.
- `tail-trace-flag`: Start moves the authenticated user's newest `DEVELOPER_LOG` trace flag to the chosen level, starting now and expiring in 30 minutes, and creates one when none exists. It never touches `USER_DEBUG` flags. It then marks the 20 newest logs as already seen and subscribes to the Streaming API topic `/systemTopic/Logging`. Tail stops itself after 30 minutes with `Tail stopped after 30 minutes.`.
- `tail-debug-level` sets that level through the `Debug level` select (`tail-debug-level`, uppercase through CSS). It opens on the level of the user's active `DEVELOPER_LOG` flag, otherwise on the first level by name, and remembers the last choice in webview state.
- `tail-org` selects the org with the `Org` select (`getByRole('combobox').first()`). Switching org stops the tail and clears the buffer.
- `tail-stream` shows each new log as `=== ApexLog <logId> | <StartTime> | <operation> | <status> | <size in bytes>`, then `Saved to <absolute path>/apexlogs/orgs/<safe org username>/logs/<YYYY-MM-DD>/<logId>.log`, then the log lines.
- `tail-search` filters the buffer line by line with `Search live logs…`: only lines that contain the text remain, and the header row hides.
- `tail-view-options` provides the `Debug Only`, `Color` and `Auto-scroll` switches. A click on a row or a scroll up pauses `Auto-scroll`.
- `tail-actions` provides `Clear`, `Open Log` (Log Viewer), `Replay Debugger` and `Debug Flags`. `Open Log` and `Replay Debugger` need a selected row.
- `tail-editor-area` uses `Open Tail in Editor Area` to open a second, independent Tail in an editor tab. Closing that tab stops its tail.

## How to get to it (user POV)

- Run `Electivus Apex Logs: Tail Logs` from the command palette. It reveals the view and copies the Logs panel's org; it does not press Start.
- Click the `Electivus Apex Logs Tail` tab in the bottom panel.
- Run `Electivus Apex Logs: Open Tail in Editor Area`.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`. Session seeding created the `ALV_E2E` debug level that the canned step picks.

- **Start and stream.** Run `node .claude/skills/verify/scripts/verify.mjs run tail-live`. It pins `session.org.alias` in the `Org` select, maximizes the panel, stops a tail left running, turns `Debug Only` off, picks `ALV_E2E` (keeping the current level when the org has no `ALV_E2E`), clears the buffer and presses Start. Five seconds after `Stop` appears it runs its own anonymous Apex, finds the marker line through `Search live logs…`, reads that log's id from the org and checks its `=== ApexLog <id>` row, and stops. It returns `ok: true` with `debugLevel`, `marker`, `logId`, the `header` row, `flagDuringTail` (the user's `DEVELOPER_LOG` flags while Tail ran; the newest is at that level and expires 30 minutes after Start, older expired ones stay as they were), `debugOnlyWasOn` and `tailShot`. On every exit after the snapshot, it stops Tail, restores those flags' level and dates, deletes a flag Start created, turns `Debug Only` back on if it was on, and puts the panel size back; a cleanup failure is reported, never swallowed. `'{"debugLevel":"<name>"}'` tests exactly that level and fails if it does not exist.
- **Saved file.** After the run, `<session.workspacePath>/apexlogs/orgs/<safe org username>/logs/<date>/<logId>.log` exists. Read it in a step, or check `workspace-files.json` after `stop`.
- **Open Log and Replay.** While tailing, click the `=== ApexLog <logId>` row in `h.tailFrame()`, then `Open Log`. `h.frameWith('text=<logId>.log')` then shows that log. `Replay Debugger` on the same row shows the `Apex Replay Debugger is unavailable…` toast, because the session does not install that extension.
- **Search and Debug Only.** Fill `getByLabel('Search live logs…')` with the marker: the `Execute Anonymous:` line and the `USER_DEBUG` line remain. With `getByRole('switch', { name: 'Debug Only' })` on, only `USER_DEBUG` lines remain.
- **Second channels.** The extension's Output log (copied to `vscode-logs/` at stop) has `Tail: TraceFlag updated or already matching for level <level>`, `Tail: primed seen set with N recent logs`, `Tail: subscribed to /systemTopic/Logging (started)` and `Tail: saved log <id> to <path>`. Read the trace flag through Tooling as in `tail-live`.
- **Proof.** Shoot the Tail frame while the panel is maximized, so the streamed rows are inside the screenshot.

## Gotchas

- Tail opened before the Logs panel can start on another org. It resolves its default from the extension host's working directory, not the workspace `.sf/config.json`, and in the harness that directory is this checkout, so a repo-local `.sf/config.json` (often the Dev Hub) wins ([#1224](https://github.com/Electivus/Apex-Log-Viewer/issues/1224)). Loading the level list on an org with no DebugLevel creates `ALV_DEVELOPER_FOCUS` there. Pin `session.org.alias` before you press anything, as `tail-live` does.
- `Stop` appears before the streaming subscription is live, and a log written in that moment is never streamed: one written 70 ms after `subscribed` never arrived ([#1225](https://github.com/Electivus/Apex-Log-Viewer/issues/1225)). Wait a few seconds after `Stop` before you write the log, and do not read a missing first row as a broken stream.
- The toolbar fills the default panel and the list is virtualized, so streamed rows are not in the DOM until the panel is taller. Maximize it, and find a log by filling `Search live logs…` with its marker; `text=<marker>` on the whole list misses rows below the fold, especially with `Auto-scroll` paused.
- Org and level reloads cover the toolbar with a loading overlay (`getByRole('status')`). Wait for it to go, and click without `force`: twice in a row, a forced click made right after `Tail Logs` revealed the panel never reached the host.
- Start moves the seeded `ALV_E2E` flag. After a Start with another level, `h.seedLog()` finds no `ALV_E2E` flag, posts a second overlapping one and fails with `FIELD_INTEGRITY_EXCEPTION`. Steps that press Start must restore the flag, as `tail-live` does, and emit logs with `h.tooling.executeAnonymousApex(auth, apex)` while Tail runs.
- The webview remembers the last debug level, so a run without an explicit choice tests whatever the previous run picked. It also remembers `Debug Only`, which hides the `=== ApexLog` header and `Saved to` rows: a step that asserts them turns the switch off first and back on afterwards, as `tail-live` does.
- Logs created before Start do not stream. Stop the tail before your step returns, because a running tail keeps its subscription and adds rows to later screenshots.
