# Custom Logs

Custom Logs lists application logs that an org keeps as records, usually Nebula Logger's `Log__c` and `LogEntry__c`, or a team's own object such as `App_Log__c`. A list row opens a transaction viewer in an editor tab. The viewer shows the transaction's entries, the long fields of one entry, JSON payload columns and a button to the Apex debug log of the same request. Nebula, unlocked or managed, needs no configuration. Any other object is mapped in `sfdx-project.json` under `plugins.electivus.customLogs`.

Custom Logs is experimental and off by default: the panel tab, the commands and the host code exist only while the workspace setting `electivus.apexLogViewer.customLogs.enabled` is `true`. Turn it on before any other recipe here.

## Sub-features

- `custom-logs-setting`: with the setting off (the default) the bottom panel has no `Electivus Custom Logs` tab and the Command Palette has no Custom Logs command. Writing `true` into the workspace settings adds both without a reload, and writing `false` removes both and closes an open Custom Logs editor tab and its transaction viewers.
- `custom-logs-list`: the `Electivus Custom Logs` bottom-panel tab lists the selected org's records newest first, 50 at a time (`Load more`).
- `custom-logs-source`: one `Source` picker (`custom-logs-source`) appears only when the org has several ready sources. A source switch clears the rows and loads that source's first page.
- `custom-logs-filter`: the filter bar takes `level`, `user`, `since` and `source` conditions, which run in Salesforce and reload the list (chips with a cloud icon), and JSON payload conditions such as `http.status >= 500`, which only narrow the loaded rows (the status bar says `Filtering N loaded rows`). A source that cannot filter by level or user rejects the condition.
- `custom-logs-json-columns`: the mapping's `payload.columns` are locked columns. `+ Field` adds any discovered JSON path as a column, and that choice is stored in workspace state, never in `sfdx-project.json`. Rows whose payload is not JSON show `invalid JSON` or `plain text` and are skipped by JSON filters.
- `custom-logs-config-refresh`: saving `sfdx-project.json` re-detects the sources and reloads the page without a restart. The `Configure` gear and the command `Configure Custom Logs Sources` open the file at the mapping.
- `custom-logs-editor-area`: `Open in editor` and `Electivus Apex Logs: Open Custom Logs in Editor Area` open the same list in an editor tab, which has no `Open in editor` button.
- `custom-log-viewer`: double-click (or Enter on) a row. The viewer header has counts, ids, the `Open Apex log` button or a hint, and `Refresh`. System messages from the logger are hidden behind a switch.
- `custom-log-long-fields`: selecting an entry lists its long fields with a state (`TEXT`/`JSON` with `Open`, `empty`, `hidden by your permissions`). `Open` shows the value in a read-only editor tab, named `<Field> - <Log> #<sequence>.txt` or `.json`.
- `custom-log-apex-link`: `Open Apex log` opens the real ApexLog in the Apex Log Viewer. Without a link the hint says which case it is: no trace flag or already deleted, no request id, or `You cannot read debug logs in this org.`.

## How to get to it (user POV)

- Turn the setting on: `node $V run custom-logs-setting` (it writes `electivus.apexLogViewer.customLogs.enabled` into the session workspace's `.vscode/settings.json`, which is what a user edits). `'{"enabled":false}'` turns it off and `'{"enabled":null}'` removes the key.
- Run `Electivus Apex Logs: Refresh Custom Logs`, or click the `Electivus Custom Logs` tab in the bottom panel.
- Run `Electivus Apex Logs: Open Custom Logs in Editor Area`.
- Run `Electivus Apex Logs: Configure Custom Logs Sources`.

## Driving it with verify steps

Preconditions:

- The setting is on (see above). `h.customLogsFrame()` fails at once while it is not.
- Baseline from `README.md`, except that a pool scratch org has no Nebula Logger. Start the session on an org that has it, with `start --target-org <alias>` (no seeding, read-only). An org without a ready source shows the empty state `No custom log source is ready in this org.`.
- A mapped source needs an object the user can read. Write the mapping into `<session.workspacePath>/sfdx-project.json` from a step, never into the repo's file.

- **Canned step.** `node $V run custom-logs-open-viewer '{"title":"<log name>","openApexLog":true}'` opens the list, one record and optionally its Apex log. Pass `"source":"<label>"` to switch source first.
- **List.** `h.customLogsFrame()` returns the list webview. Rows are `[data-row-id="<recordId>"]`. The panel is short, so the grid renders only the first rows: run `h.runCommand('View: Toggle Maximized Panel')` before the shot, or narrow the list with a server filter such as `level >= ERROR` instead of scrolling.
- **Filter.** Fill `getByRole('combobox', { name: 'Filter logs' })`, press Enter, then Escape so the suggestion list is not in the shot. A condition chip is `[data-testid="filter-chip"]`.
- **Source and columns.** `getByTestId('custom-logs-source').click()` then `getByRole('option', { name })`. `getByTitle('Add a JSON field as a column')` opens the picker; search for the path and click it in the `group`.
- **Mapping edit.** Write `plugins.electivus.customLogs` into the workspace `sfdx-project.json`. The `Source` picker appears within a few seconds and the list keeps the source on screen.
- **Viewer.** `h.customLogViewerFrame(timeoutMs, title)` scopes by the title the header shows when several viewers are open. Entries are `[data-entry-id="<id>"]`, the selected entry's panel is `custom-log-entry-detail`, and each long field is `entry-field-<key>` with an `Open` button.
- **Long field.** After `Open`, the editor tab named after the field exists and is not dirty (`.tabs-container .tab.dirty` count 0). Read its text from `.monaco-editor .view-lines`.
- **Apex link.** With a linked log, `Open Apex log` opens `Apex Log: <07L id>.log`. `custom-log-apex-hint` holds the explanation otherwise.
- **CLI cross-check.** `node $V sf -- custom-log list --json --limit 5` and `custom-log get --log-id <id> --json` return the same rows and the same `apexLog` state as the UI.

## Gotchas

- The LoggerEndUser permission set cannot query `ApexLog`, so its viewer says `You cannot read debug logs in this org.` instead of the trace-flag hint. An admin whose request has no ApexLog sees the trace-flag hint. Both are correct, so check which user the session runs as before reading the hint.
- Describe omits the fields an end user cannot read, so the entry's fields show `hidden by your permissions` while the `Has*` chips (`StackTrace 3`) still count them.
- The list orders by `CreatedDate`, but the Time column shows the mapped start time, so two logs a few seconds apart can look out of order.
- Rows are virtualized: a row below the fold is not in the DOM, so `locator.count()` is not the number of loaded rows. The status bar (`50 rows loaded`) is.
- Turning the setting off closes the Custom Logs editor tab and the transaction viewers, and the panel falls back to another tab (the Terminal opens when no other Electivus tab was active). Turning it on again starts from a fresh provider, so the selected org and source come from the defaults.
- The first column of a Nebula list is `Time`, then `Level`, `Title`. A mapped payload column is labelled with its JSON path and a `{}` marker.
- A source the project file defines first is selected on the first load. A later mapping edit does not move the list off the source on screen.
- Entries of a transaction page in 200s, and the header payload and entry long text are never sent to a webview, so do not look for them in the DOM. Check the editor tab instead.
