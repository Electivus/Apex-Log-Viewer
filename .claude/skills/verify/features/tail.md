# Tail

Tail streams new Apex logs from the selected org while it runs. The user picks a debug level for the trace flag and presses Start. Each new log appears as a header row followed by its lines and is saved into the workspace `apexlogs/` store. A selected log can be opened in the Log Viewer or in Apex Replay.

## Sub-features

- `tail-start-stop` toggles streaming with one button labelled `Start` / `Stop`. While idle the list says `Press Start to tail logs.`.
- `tail-debug-level` sets the trace flag level through the `DEBUG LEVEL` select (`tail-debug-level`).
- `tail-stream` shows each new log as `=== ApexLog <logId> | <time> | <operation> | <status> | <size>` followed by `Saved to …/apexlogs/orgs/<user>/logs/<date>/<logId>.log` and the log lines.
- `tail-search` filters the live buffer with `Search live logs…`.
- `tail-view-options` provides the `Debug Only`, `Color` and `Auto-scroll` switches.
- `tail-actions` provides `Clear`, `Open Log` (Log Viewer), `Replay Debugger` and `Debug Flags`.
- `tail-editor-area` uses `Open Tail in Editor Area`.

## How to get to it (user POV)

- Run `Electivus Apex Logs: Tail Logs` from the command palette.
- Click the `Electivus Apex Logs Tail` tab in the bottom panel.
- Run `Electivus Apex Logs: Open Tail in Editor Area`.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`. Session seeding created the `ALV_E2E` debug level that the canned step prefers.

- **Start and stream.** Run `node .claude/skills/verify/scripts/verify.mjs run tail-live`. It returns `ok: true` with `debugLevel`, the emitted `marker` / `logId` and `tailShot`. While it runs, the button reads `Stop` and the marker row appears within 180 s.
- **Saved file.** After the run, `<session.workspacePath>/apexlogs/orgs/<user>/logs/<date>/<logId>.log` exists. Read it in a step, or check `workspace-files.json` after `stop`.
- **Open Log.** While tailing, click a header row in `h.tailFrame()`, then click `Open Log`. `h.viewerFrame()` then shows that `logId`.
- **Search live.** Fill `Search live logs…` with the marker. Only that log's lines remain.
- **Proof.** Before the shot, run `h.runCommand('View: Toggle Maximized Panel')` so the streamed rows are inside the screenshot.

## Gotchas

- Start stays disabled until a debug level is selected, and a fresh org may show `Select`. The canned step picks `ALV_E2E` or the first option.
- Tail polls the org, so new logs take several seconds to appear. Assert visibility with a long timeout and do not sleep.
- Logs created before Start do not stream. Emit a new one (`h.seedLog()`) after Start.
- Stop the tail before your step returns, because a running tail keeps polling the org and adds rows to later screenshots.
