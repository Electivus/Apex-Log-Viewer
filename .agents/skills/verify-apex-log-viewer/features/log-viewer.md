# Log Viewer

The Log Viewer opens one Apex log in an editor tab. It shows the parsed entries, a search with match navigation, category filters, a diagnostics side panel, a status bar with counts, and a raw-text view.

## Sub-features

- `viewer-open` opens a tab titled `Apex Log: <logId>.log` whose header titles the log with its entry point (`execute_anonymous_apex` for anonymous Apex) and lists the user, duration, start time and file name beside it as muted text. Without an entry point the file name is the title. The webview root carries `data-testid="log-viewer"`, which `h.viewerFrame()` waits for. Opening the same file again reveals the existing tab.
- `viewer-failure` shows a banner under the header (`role="alert"`, `data-testid="log-viewer-failure"`) for an error entry. It prefers the first `FATAL_ERROR`, then `EXCEPTION_THROWN`, then another error-category entry. The banner shows the message and a line number when available. `Go to error` (`data-testid="log-viewer-go-to-error"`) scrolls to that entry and selects it (`.log-selected`), even when a filter had hidden it. A caught exception can produce the banner in a successful transaction. A log with no error entry has no banner.
- `viewer-search` uses `Search entries…`, highlights matches and shows an `n/m` counter of matching entries with `Previous match` / `Next match` buttons (Enter and Shift+Enter in the box do the same). Navigation wraps: `Next` on `m/m` goes to `1/m`. A new query starts at `1/m`; a filter chip keeps the place of the same query when it can.
- `viewer-filters` toggles the `Debug Only`, `Errors`, `SOQL` and `DML` chips, which show their counts (`Errors 2`, name `Errors 2`), carry `aria-pressed`, and are disabled at 0 unless active. No chip is active when a viewer opens. `Showing:` sits next to `<n> entries` (`1 entry` for one). `No entries match the current filters.` shows only when the active chip has no entry left, for example after a reload lowers its count: a chip at 0 is disabled and search hides no entry, so a click cannot reach it. Clicking the active chip again returns to all entries.
- `viewer-diagnostics` shows the `Diagnostics` side panel (uppercase through CSS) with `<n> total`, the `All` / `Errors` / `Warnings` tabs, and one item per triage reason: a severity icon (`role="img"`, named `error` or `warning`), the code, the line and the message of the mapped entry, for example `fatal exception` (shown as `FATAL EXCEPTION` through CSS), `Line 1` and `System.MathException: Divide by 0`; the triage summary stands in when the entry is not the reported event. Clicking an item scrolls to its entry and marks it (`.log-selected`). Without reasons it says `No diagnostics found.`.
- `viewer-status` shows the status bar with Total Lines (parsed entries), Size, Updated and Ready; the per-category counts live on the filter chips. It says `Loading…` instead of Ready while the log content loads, and `Not loaded` when it failed.
- `viewer-language` shows the Log Viewer's labels and `aria-label`s in VS Code's display language: English, or Portuguese for any `pt` locale (`Buscar entradas…`, `Próxima ocorrência`, `Somente debug`, `Diagnósticos`, `Total de linhas: <n>`). The tab title, `SOQL` and `DML` stay as they are. The failure banner is `getByRole('alert', { name: 'Falha' })`, where `Falha` is its `aria-label`; it shows the message, `Linha <n>` and `Ir para o erro`. Diagnostic summaries come from the triage in English.
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
- **Search navigation.** `logs-open-viewer` leaves the seeded marker in the search box with the counter at `1/2`. The seeded log has 8 entries, and the marker, `EXECUTION` and `CODE_UNIT` each match exactly two. With `const viewer = await h.frameWith('text=<logId>.log')`, fill `input[placeholder="Search entries…"]` with `EXECUTION`. The counter `viewer.getByText(/^\d+\/\d+$/)` reads `1/2`. `button[aria-label="Next match"]` moves it to `2/2` and the outlined row (`.log-row-active-match`) to `EXECUTION_FINISHED`; another click wraps to `1/2`. A query with no match reads `0/0` and disables both buttons.
- **Filters.** On the seeded log the badge reads `8 entries` and `Debug Only` gives `1 entry`. `SOQL 0` and `DML 0` are disabled; assert `toBeDisabled()` instead of clicking them. An unmatched search gives `0/0` and disables match navigation without hiding the entries. The chip's name includes its count (`Errors 2`), so `viewer.getByRole('button', { name: 'Errors', exact: true })` is the sidebar tab only. On a log from `h.seedErrorLog()` the chip reads `Errors 1` and gives `1 entry`, and the sidebar lists a `fatal exception` item at `Line 4`. Its text is lower case and only CSS shows it upper case, so `getByText('FATAL EXCEPTION')` finds nothing: match `/fatal exception/i`.
- **Long-log jumps.** Generate a real log with many multiline debug messages followed by a caught exception. With `Debug Only` active and a nonmatching search, click `Go to error` once. Require the selected `EXCEPTION_THROWN` row to remain within its scroll container after row heights settle. DOM presence alone does not prove the entry is in view. Check diagnostic and search-navigation jumps with the same viewport assertion.
- **Raw and the palette command.** Click `View Raw`: a `<logId>.log` text tab opens with language mode `Log`. With that tab active, `Electivus Apex Logs: Open in Apex Log Viewer` reveals the viewer for the file. With a webview focused, the same command shows `Electivus Apex Logs: No Apex log is active.`.
- **CodeLens.** With the raw tab active, `.codelens-decoration` reads `Open in Apex Log Viewer`, and `.editor-actions [aria-label*="Open in Apex Log Viewer"]` is the title button. Clicking either reveals the viewer tab.
- **Proof.** Call `h.shot('viewer-…', viewer)` after each step. The header shows which log is open. Use a full-window `node … shot` for the raw tab and the CodeLens.

## Gotchas

- The search counter renders only while the box has a query.
- Viewer search hits in a message are `mark.log-find-mark`. `mark.match-highlight` exists only in the Logs panel, so counting it in the viewer returns 0. A match in the row's type column counts but has no `<mark>`: `CODE_UNIT` reads `1/2` with none, so assert the counter.
- Opening a second log creates a second viewer frame, and the frame helpers return only the one on screen. Click the tab (`.tabs-container .tab` with `Apex Log: <logId>.log`) first, then scope with `h.frameWith('text=<logId>.log')`.
- `Search entries…` is also the Custom Log Viewer's placeholder, so always search inside the frame you scoped.
- The palette command accepts only documents recognized as Apex logs. A non-log file shows `Electivus Apex Logs: The active document is not recognized as a Salesforce Apex log.`.
- Under `--locale`, the viewer's text selectors and `aria-label`s change. `input[type="search"]` and `.log-row-active-match` work in any display language, so `logs-open-viewer` runs under `pt-br`.
