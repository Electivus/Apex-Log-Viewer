# Custom Logs

Custom Logs lists application logs that an org keeps as records, usually Nebula Logger's `Log__c` and `LogEntry__c`, or a team's own object such as `App_Log__c`. A list row opens a transaction viewer in an editor tab. The viewer shows the transaction's entries, the long fields of one entry, JSON payload columns and a button to the Apex debug log of the same request. Nebula, unlocked or managed, needs no configuration. Any other object is mapped in `sfdx-project.json` under `plugins.electivus.customLogs`.

Custom Logs is experimental and off by default: the panel tab, the commands and the host code exist only while the workspace setting `electivus.apexLogViewer.customLogs.enabled` is `true`. Turn it on before any other recipe here.

## Sub-features

- `custom-logs-setting`: with the setting off (the default) the bottom panel has no `Electivus Custom Logs` tab and the Command Palette has no Custom Logs command. Writing `true` into the workspace settings adds both without a reload, and writing `false` removes both and closes an open Custom Logs editor tab, its transaction viewers and their long-field documents.
- `custom-logs-list`: the `Electivus Custom Logs` bottom-panel tab lists the selected org's records newest first, 50 at a time (`Load more`). The status bar counts them (`6 rows loaded`).
- `custom-logs-empty`: an org without a ready source shows `custom-logs-empty` with `No custom log source is ready in this org. Install Nebula Logger, or map your own log object in sfdx-project.json.` and one line per built-in source, such as `Nebula Logger is not installed in this org.`.
- `custom-logs-source`: one `Source` picker (`custom-logs-source`) appears only when the org has several ready sources. The selected source also shows as a `source = <id>` chip. A source switch clears the rows and loads that source's first page. The first load prefers a source the panel already showed, then the core default (the only implicit record source), then the first ready record source, and only then a ready event source. An event source subscribes only after a first-use button is clicked. The CLI never picks an event source by default.
- `custom-logs-filter`: the filter bar takes `level`, `user`, `since` and `source` conditions, which run in Salesforce (or over the event store for an event source) and reload the list. Their chips carry a cloud icon. JSON payload conditions such as `http.status >= 500` only narrow the loaded rows; their chip carries a list icon and the status bar says `Filtering N loaded rows · M match`. A source that cannot filter by level or user rejects the condition. Each added chip has a `Remove filter <condition>` button.
- `custom-logs-json-columns`: the mapping's `payload.columns` are locked columns, labelled with the JSON path and a `{}` marker. `+ Field` adds any discovered JSON path as a column, and that choice is stored in workspace state, never in `sfdx-project.json`. Rows whose payload is not JSON show `invalid JSON` or `plain text` and are skipped by JSON filters.
- `custom-logs-config-refresh`: any change to `sfdx-project.json` on disk re-resolves the sources and reloads the page within a few seconds, without a restart. The `Configure` gear and the command `Configure Custom Logs Sources` open the file at the mapping.
- `custom-logs-editor-area`: `Open in editor` and `Electivus Apex Logs: Open Custom Logs in Editor Area` open the same list in an editor tab, which has no `Open in editor` button.
- `custom-log-viewer`: double-click (or Enter on) a row. The viewer header has the level, `Transaction <id>` and `Request <id>`, the `Open Apex log` button or a hint, and `Refresh`. Level chips count the entries. Entries whose message starts with the mapping's `systemMessagePrefix` are hidden behind the `Show logger system messages (N)` switch.
- `custom-log-long-fields`: selecting an entry lists its long fields under `Long fields` with a state (`TEXT`/`JSON` with `Open`, `empty`, `hidden by your permissions`). `Open` shows the value in a read-only editor tab, named `<Field> - <Log> #<sequence>.txt` or `.json`.
- `custom-log-apex-link`: `Open Apex log` opens the real ApexLog in the Apex Log Viewer. Without a link the hint says which case it is: `No Apex debug log for this request: no trace flag was active, or Salesforce already deleted it.`, `This log has no request id, so it cannot be linked to an Apex debug log.`, or `You cannot read debug logs in this org.`.

## How to get to it (user POV)

- Turn the setting on: `node $V run custom-logs-setting` (it writes `electivus.apexLogViewer.customLogs.enabled` into the session workspace's `.vscode/settings.json`, which is what a user edits). `'{"enabled":false}'` turns it off and `'{"enabled":null}'` removes the key.
- Run `Electivus Apex Logs: Refresh Custom Logs`, run `Electivus Custom Logs: Focus on Electivus Custom Logs View`, or click the `Electivus Custom Logs` tab in the bottom panel.
- Run `Electivus Apex Logs: Open Custom Logs in Editor Area`.
- Run `Electivus Apex Logs: Configure Custom Logs Sources`.

## Driving it with verify steps

Preconditions:

- The setting is on (see above). `h.customLogsFrame()` fails at once while it is not.
- A harness scratch has no Nebula Logger, so map a standard object it has. Write the mapping into `<session.workspacePath>/sfdx-project.json` from a step, never into the repo's file. Seeding still runs, so the Apex link works. Nebula itself needs `start --target-org <alias>` on an org that has it (no seeding, read-only).

A mapping that reaches every record sub-feature on the harness scratch uses `Account`. Create the records with `h.tooling.executeAnonymousApex(auth, apex)`, and delete them at the end with `delete [SELECT Id FROM Account WHERE Name LIKE 'ALV-%' AND CreatedDate = TODAY];`:

```json
{
  "id": "alv-accounts",
  "label": "ALV accounts",
  "entry": {
    "object": "Account",
    "fields": {
      "time": "CreatedDate",
      "message": "Name",
      "level": "Rating",
      "user": "CreatedBy.Username",
      "transactionId": "AccountNumber",
      "requestId": "Site",
      "order": "NumberOfEmployees"
    },
    "details": ["BillingStreet"],
    "payload": { "field": "Description", "columns": ["http.status"] },
    "systemMessagePrefix": "ALV-SYS"
  },
  "levels": { "Hot": "ERROR", "Warm": "WARN", "Cold": "INFO" }
}
```

Set `Site = Request.getCurrent().getRequestId()` on records inserted by the same anonymous Apex: that value equals the run's `ApexLog.RequestIdentifier`, so `Open Apex log` links. Give two or three records the same `AccountNumber` to make a multi-entry transaction, start one `Name` with `ALV-SYS` for the system-message switch, and set `Description` to JSON (`{"http":{"status":503},"orderId":"A-2"}`), plain text and broken JSON across the rows. A second source on `Case` (`time: CreatedDate`, `message: Subject`) makes the `Source` picker appear.

- **Canned step.** `node $V run custom-logs-open-viewer '{"title":"<log name>","openApexLog":true}'` opens the list, one record and optionally its Apex log. Pass `"source":"<label>"` to switch source first.
- **List.** `h.customLogsFrame()` returns the list webview. Rows are `[data-row-id="<recordId>"]`. The panel is short, so the grid renders only the first rows: run `h.runCommand('View: Toggle Maximized Panel')` before the shot, or narrow the list with a server filter such as `level >= ERROR` instead of scrolling.
- **Filter.** Fill `getByRole('combobox', { name: 'Filter logs' })`, press Enter, then Escape so the suggestion list is not in the shot. A condition chip is `[data-testid="filter-chip"]`. Remove what you added with `getByRole('button', { name: /^Remove filter (?!source)/ })`; the chip's first button is a disabled `Edit filter`.
- **Source and columns.** `getByTestId('custom-logs-source').click()` then `getByRole('option', { name })`. `getByTitle('Add a JSON field as a column')` opens the picker; click the path's text in it (`getByText('orderId', { exact: true }).last()`).
- **Mapping edit.** Write `plugins.electivus.customLogs` into the workspace `sfdx-project.json`. The `Source` picker appears within a few seconds and the list keeps the source on screen.
- **Viewer.** Un-maximize the panel and click the `Custom log: <title>` editor tab before you drive a viewer, because a maximized panel and a background tab hide its controls. `h.customLogViewerFrame(timeoutMs, title)` scopes by the title the header shows when several viewers are open. Entries are `[data-entry-id="<id>"]`, the selected entry's panel is `custom-log-entry-detail`, and each long field is `entry-field-<key>` with an `Open` button.
- **Long field.** The fields load after the entry is selected (`Loading fields…`), so wait for `entry-field-*` to appear. After `Open`, the editor tab named after the field is active and not dirty (`.tabs-container .tab.dirty` count 0). Read its text from `.monaco-editor .view-lines`.
- **Apex link.** With a linked log, `Open Apex log` opens `Apex Log: <07L id>.log`. `custom-log-apex-hint` holds the explanation otherwise.
- **CLI cross-check.** `node $V sf -- custom-log sources --json` lists every source with its `state` and `capabilities.apexLogLink`. With two ready sources, `custom-log list` needs `--source <id>` and fails without it (`Several log sources are ready (…). Pass one with --source.`). `custom-log list --source <id> --min-level ERROR --json`, `custom-log get --source <id> --log-id <row id> --json` (its `apexLog.state` is `linked`, `notFound` or `noRequestId`, matching the viewer) and `custom-log entry --source <id> --entry-id <id> --json` return the same rows, links and long fields as the UI.

## Gotchas

- The LoggerEndUser permission set cannot query `ApexLog`, so its viewer says `You cannot read debug logs in this org.` instead of the trace-flag hint. An admin whose request has no ApexLog sees the trace-flag hint. Both are correct, so check which user the session runs as before reading the hint.
- Describe omits the fields an end user cannot read, so the entry's fields show `hidden by your permissions` while the `Has*` chips (`StackTrace 3`) still count them.
- The list orders by `CreatedDate`, but the Time column shows the mapped start time, so two logs a few seconds apart can look out of order.
- Rows are virtualized: a row below the fold is not in the DOM, so `locator.count()` is not the number of loaded rows. The status bar (`50 rows loaded`) is.
- Turning the setting off closes the Custom Logs editor tab, the transaction viewers and their long-field tabs, and the panel falls back to another tab (the Terminal opens when no other Electivus tab was active). Turning it on again starts from a fresh provider, so the selected org and source come from the defaults.
- The first column of a list is `Time`, then `Level`, `Title`. A mapped payload column is labelled with its JSON path and a `{}` marker.
- A harness scratch keeps a few template records (an `Account` named `Sample Account for Entitlements`, two `Case` records), so a mapping on a standard object lists them too.
- Entries of a transaction page in 200s, and the header payload and entry long text are never sent to a webview, so do not look for them in the DOM. Check the editor tab instead.

## Platform event sources

A source mapped under `event` instead of `entry` shows platform events that no record keeps (Nebula's `LogEntryEvent__e` when it does not persist, or a team's own `App_Log__e`). Core subscribes while the panel shows the source, stores each event whole under `apexlogs/orgs/<org>/events/<object>/`, and the table reads that store, newest first. A strip above the table shows the capture state.

The event object must be a custom platform event (`__e`). A standard event such as `BatchApexErrorEvent` is rejected with `invalidValue`, and a harness scratch has no custom event, so these recipes need the dedicated `alv-events` org: start the session with `node $V start --target-org alv-events` (no lease, no seeding). Never publish into a harness org: publishing `LogEntryEvent__e` into Nebula persists into `Log__c`. `docs/TESTING.md#platform-events-org-custom-logs-capture` describes the org and its three events.

To see an event source that reads each item of a JSON array field as its own row, publish with `node scripts/events-org.mjs publish --count N --transaction-id T --payload-entries M`: `Payload__c` becomes an array of M entries plus a metric item and `Stack_Trace__c` an array of one entry of another transaction. The `events-entries` step maps and checks it.

- **First use.** An org this workspace never captured shows `No events from this org are stored yet.`, the note `Salesforce keeps up to 72 hours; each event counts against the org's daily delivery allocation (about R of M left); this run stops after about B deliveries and resumes on the next Start.`, and two buttons, `Load retained events` and `Only new events`. B is half of what remains (R). When Salesforce does not report the allowance, the `(about R of M left)` clause is empty and B is 5,000, so `events-capture` fails its first-use assertion. Nothing subscribes before a button is clicked. A project whose only ready source is an event source opens on it by itself, because the Source picker appears only with two ready sources.
- **Live.** The strip is `[data-testid="custom-logs-capture"]` and `data-state` is its state: `stopped`, `connecting`, `catchingUp`, `live`, `reconnecting`, `failed`, `standby`. `Live` carries the tooltip `Inferred: no event for 10 s. Salesforce sends no end-of-backlog marker.` as its `title`. Rows are `[data-row-id]`.
- **Stopped and standby.** A run that spent its budget stops with `Paused: this run spent its delivery budget (about B deliveries of the org's daily allocation). Start to resume from the stored position.` A Start while another process holds the lease goes to `standby`: `Another <surface> (pid <pid> on <host>) is capturing; new events appear here.`, with a note on deleting a stale `capture.lease`. The table then shows the rows that process stores, polled every 2 s. Seen live with `custom-log capture --follow` holding the lease: two published events appeared, Stop during standby showed `Stopped`, and after Ctrl-C on the CLI the panel took the lease and reached `Live` within about 18 s (one run). The panel always follows, so it never shows `Another VS Code window or sf command is capturing these events.` ([#1236](https://github.com/Electivus/Apex-Log-Viewer/issues/1236)). That outcome, `capturedElsewhere`, belongs to a drain: `custom-log capture` without `--follow` returns it at once, with `delivered: 0` and exit code 0. A failure reads `Capture failed: <message>`.
- **Gap.** The list named `Possible gaps in the stored events` holds lines such as `Events after <time> may be missing (<reason>)`, or the `between`, `before` and bare `Some events may be missing` forms. Move `checkpoint.json`'s `cursor` past the bus (`cometd:<id + 1000000>`) while no capture runs, then press `Start`: Salesforce rejects the position and the gap appears. A `-2` replay follows and delivers every event the object retains, so use `ALV_Test_Replay__e`. That cost is not bounded by 72 hours: on 2026-11-05 the replay delivered events 123 hours old, which Salesforce documents as possible ([#1238](https://github.com/Electivus/Apex-Log-Viewer/issues/1238)). Core gives a new rejection the gap that is already open, so a second rejection adds no line until a stored event newer than the gap's `after` closes it. The strip shows a gap opened mid-run only once a later flush stores an event ([#1235](https://github.com/Electivus/Apex-Log-Viewer/issues/1235)): after a replay of events the store already holds, `gaps.*.ndjson` has the open gap and the strip has no line.
- **Steps.** `events-capture` and `events-gap` do the above and screenshot each state. They refuse to run unless the session org is `alv-events`. `events-capture` needs a workspace that never stored a position for the object, so it runs once per `start`. `events-gap` needs a stored position, so run `events-capture` first. While #1235 is open it also needs a recovery replay that stores something new, which only its first run after a default `events-capture` has. They share `steps/lib/events.mjs`, which the host imports once per session: after editing it, `stop` and `start` again. `events-gap-control` proves that `events-gap` fails when Salesforce rejects nothing.
- **CLI.** `sf electivus custom-log capture --source <id> --json` drains the same store and stops when the stream goes quiet, when the run has spent about half of the remaining allocation (5,000 deliveries when Salesforce reports none), or at `--max-time` (default 120 s, at most 3600). `--follow` keeps capturing and prints each stored row until Ctrl-C. The `--json` result carries `allowance` (`remaining`, `max`, `budget`) for every run that connected. A drain that finds the lease held stops at once with `capturedElsewhere`, no `allowance`, and `holder` (`surface`, `pid`, `host`, `since`) naming the capturer, for example a VS Code window whose hidden panel still shows the event source. It spends the allocation, has no preview, and refuses a source that is not ready with `CUSTOM_LOG_SOURCE_UNAVAILABLE` (seen live: `Log source "nebula-events" is not available: not installed.`).

Gotchas:

- Stop answers at once, but the run still writes its last position. A step that edits `checkpoint.json` waits for `capture.lease` to disappear first (`waitForRunToEnd`), or the run overwrites the edit.
- The bottom panel hides rows from a screenshot. `events-*` maximize it; re-running them does not toggle it back because they check the panel height first.
- The `Time` column shows the mapped `Logged_At__c` in the machine's time zone, and `stored since` too.
- `apexlogs/` in the session workspace holds every field of every delivered event, `rg --no-ignore -g '*.ndjson' <text> <eventsRoot>` searches it.
