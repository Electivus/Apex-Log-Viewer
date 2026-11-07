# Log Viewer

The Log Viewer opens one Apex log in an editor tab. It shows the parsed entries, a search with match navigation, category filters, a diagnostics side panel, a status bar with counts, and a raw-text view.

## Sub-features

- `viewer-open` opens a tab titled `Apex Log: <logId>.log` whose header reads `Apex Log Viewer` with the file name below it. Opening the same file again reveals the existing tab.
- `viewer-search` uses `Search entries…`, highlights matches and shows an `n/m` counter of matching entries with `Previous match` / `Next match` buttons (Enter and Shift+Enter in the box do the same). Navigation wraps: `Next` on `m/m` goes to `1/m`. A new query starts at `1/m`; a filter chip keeps the place of the same query when it can.
- `viewer-filters` toggles the `Debug Only`, `Errors`, `SOQL` and `DML` chips. No chip is active when a viewer opens. `Showing:` sits next to a `<n> entries` badge (`1 entry` for one), and a filter with no match shows `No entries match the current filters.`. Clicking the active chip again returns to all entries.
- `viewer-diagnostics` shows the `Diagnostics` side panel (uppercase through CSS) with `<n> total`, the `All` / `Errors` / `Warnings` tabs, and one item per triage reason, for example `Fatal exception` with `Line 4`. Clicking an item scrolls to its entry and outlines it (`.ring-2`). Without reasons it says `No diagnostics found.`.
- `viewer-status` shows the status bar with Total Lines (parsed entries), Debug Statements, Error Events, SOQL Queries, DML Operations, Size, Updated and Ready. It says `Loading…` instead of Ready while the log content loads, and `Not loaded` when it failed.
- `viewer-language` shows the Log Viewer's labels and `aria-label`s in VS Code's display language: English, or Portuguese for `pt-br` (`Buscar entradas…`, `Próxima ocorrência`, `Somente debug`, `Diagnósticos`, `Total de linhas: <n>`). The `Apex Log Viewer` header, the tab title, `SOQL` and `DML` stay as they are, and diagnostic summaries come from the triage in English.
- `viewer-raw` uses `View Raw` to open the `.log` file in a text editor tab named `<logId>.log`.

## How to get to it (user POV)

- In the Logs panel, click a row, press Enter on a focused row, or click the row's `Open` button.
- In the Tail panel, select a streamed log and click `Open Log`.
- In a Custom Log Viewer, click `Open Apex log`.
- With an Apex `.log` file active in a text editor, run `Electivus Apex Logs: Open in Apex Log Viewer`.
- With a `.log` Apex log open as text, use its `Open in Apex Log Viewer` CodeLens or editor-title button. VS Code opens real logs in language mode `Log`, and both appear there without a language change.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`. The canned step works from `session.seeded`.

- **From Logs.** Run `node .agents/skills/verify-apex-log-viewer/scripts/verify.mjs run logs-open-viewer`. It returns `ok: true`, `panelShot`, `viewerShot` and `cachedLogFiles` containing `<logId>.log`. The viewer frame shows the log id and the highlighted marker. `'{"query":"<text>","logId":"<07L…>"}'` opens another log, for example one from `h.seedErrorLog()`.
- **Search navigation.** `logs-open-viewer` leaves the seeded marker in the search box with the counter at `1/2`. The seeded log has 8 entries, and the marker, `EXECUTION` and `CODE_UNIT` each match exactly two. With `const viewer = await h.frameWith('text=<logId>.log')`, fill `input[placeholder="Search entries…"]` with `EXECUTION`. The counter `viewer.getByText(/^\d+\/\d+$/)` reads `1/2`. `button[aria-label="Next match"]` moves it to `2/2` and the outlined row (`.ring-1.ring-amber-400`) to `EXECUTION_FINISHED`; another click wraps to `1/2`. A query with no match reads `0/0` and disables both buttons.
- **Filters.** On the seeded log the badge reads `8 entries`, `Debug Only` gives `1 entry`, and `SOQL` gives `0 entries` with `No entries match the current filters.`. Two buttons are named `Errors`: `viewer.getByRole('button', { name: 'Errors', exact: true }).first()` is the chip, `.last()` the sidebar tab. On a log from `h.seedErrorLog()` the chip gives `1 entry`, the status bar has `Error Events: 1`, and the sidebar lists `Fatal exception` at `Line 4`.
- **Raw and the palette command.** Click `View Raw`: a `<logId>.log` text tab opens with language mode `Log`. With that tab active, `Electivus Apex Logs: Open in Apex Log Viewer` reveals the viewer for the file. With a webview focused, the same command shows `Electivus Apex Logs: No Apex log is active.`.
- **CodeLens.** With the raw tab active, `.codelens-decoration` reads `Open in Apex Log Viewer`, and `.editor-actions [aria-label*="Open in Apex Log Viewer"]` is the title button. Clicking either reveals the viewer tab.
- **Proof.** Call `h.shot('viewer-…', viewer)` after each step. The header shows which log is open. Use a full-window `node … shot` for the raw tab and the CodeLens.

## Gotchas

- The search counter renders only while the box has a query.
- Viewer search hits in a message are plain `<mark>` elements. `mark.match-highlight` exists only in the Logs panel, so counting it in the viewer returns 0. A match in the row's type column counts but has no `<mark>`: `CODE_UNIT` reads `1/2` with none, so assert the counter.
- Opening a second log creates a second viewer frame, and the frame helpers return only the one on screen. Click the tab (`.tabs-container .tab` with `Apex Log: <logId>.log`) first, then scope with `h.frameWith('text=<logId>.log')`.
- `Search entries…` is also the Custom Log Viewer's placeholder, so always search inside the frame you scoped.
- The palette command accepts only documents recognized as Apex logs. A non-log file shows `Electivus Apex Logs: The active document is not recognized as a Salesforce Apex log.`.
- Under `--locale`, the viewer's text selectors and `aria-label`s change. `input[type="search"]` and `.ring-1.ring-amber-400` work in any display language, so `logs-open-viewer` runs under `pt-br`.
