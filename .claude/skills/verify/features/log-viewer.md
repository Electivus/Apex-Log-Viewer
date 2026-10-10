# Log Viewer

The Log Viewer opens one Apex log in an editor tab. It shows the parsed entries, a search with match navigation, quick filters, a diagnostics side panel, a status bar with counts, and a raw-text view.

## Sub-features

- `viewer-open` opens a tab titled `Apex Log: <logId>.log` whose header reads `Apex Log Viewer` with the file name below it.
- `viewer-search` uses `Search entries…`, highlights matches and shows a `n/m` counter with `Previous match` / `Next match` buttons.
- `viewer-filters` toggles the `Debug Only`, `Errors`, `SOQL` and `DML` filter chips. `Showing: N entries` updates.
- `viewer-diagnostics` shows the `DIAGNOSTICS` panel with `All` / `Errors` / `Warnings` tabs, or `No diagnostics found.`.
- `viewer-status` shows the status bar with Total Lines, Debug Statements, Error Events, SOQL Queries, DML Operations, Size and Updated.
- `viewer-raw` uses `View Raw` to open the plain log text.

## How to get to it (user POV)

- In the Logs panel, click a row and press `Enter`.
- In the Tail panel, select a streamed log and click `Open Log`.
- With an Apex `.log` file active in the editor, run `Electivus Apex Logs: Open in Apex Log Viewer`, or click the `Open in Apex Log Viewer` CodeLens at the top of the file.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`. The canned step works from `session.seeded`.

- **From Logs.** Run `node .claude/skills/verify/scripts/verify.mjs run logs-open-viewer`. It returns `ok: true`, `panelShot`, `viewerShot` and `cachedLogFiles` containing `<logId>.log`. The viewer frame shows the log id and the highlighted marker.
- **Search navigation.** With `const viewer = await h.viewerFrame()`, fill `input[placeholder="Search entries…"]` with a term that occurs more than once. The counter reads `1/N`. Clicking `button[aria-label="Next match"]` moves it to `2/N`.
- **Filters.** Click `viewer.getByRole('button', { name: 'Errors' })` on a log from `h.seedErrorLog()`. `Showing:` drops to the error entries and the `DIAGNOSTICS` panel lists at least one error.
- **From a file.** Open a cached file with `h.runCommand('File: Open File...')`, or by clicking it in the Explorer under `apexlogs/orgs/…/logs/…`, then run `Electivus Apex Logs: Open in Apex Log Viewer`. A Log Viewer tab opens for that file.
- **Raw.** Click `View Raw`. A text editor tab with the raw log opens. Prove it with a full-window `shot`.
- **Proof.** Call `h.shot('viewer-…', viewer)` after each step. The header shows which log is open.

## Gotchas

- Opening a second log creates a second viewer frame, and `h.viewerFrame()` returns the first one it finds. Scope with `h.frameWith('text=<logId>.log')`.
- `Debug Only` is on by default for some logs, so the entry count depends on the filter state. Read `Showing:` before and after you toggle.
- The CodeLens and the palette command only accept documents recognized as Apex logs. A non-log file shows `The active document is not recognized as a Salesforce Apex log.`.
