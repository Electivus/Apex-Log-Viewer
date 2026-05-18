# Deprecate Code Unit Column Design

Date: 2026-05-18

## Goal

Remove the `Code Unit` logs-table column and its user-facing behavior while preserving backward compatibility for existing saved settings and runtime contracts.

The column is no longer useful now that local full-log text search exists, and the extension should avoid the extra background work currently used to read cached log files only to populate `codeUnitStarted`.

## Current Behavior

The `codeUnit` column is part of the shared logs-column key set and appears in the default column order, column visibility settings, webview table, toolbar filter, metadata search haystack, sort handling, package contribution schema, and webview tests.

The VS Code provider starts auth hydration after logs load and calls `LogService.loadLogHeads`. That path scans existing cached log files for `CODE_UNIT_STARTED` and posts `logHead` messages containing `codeUnitStarted`. The `logHead` message is also used for error triage fields, so the message itself cannot be removed wholesale.

The Rust triage runtime and app-server TypeScript client also expose `codeUnitStarted` on triage entries. Those fields should be treated as legacy compatibility fields for this change, not as active UI behavior.

## Chosen Approach

Use a compatible deprecation:

- Remove `Code Unit` from the default logs-table UI, column chooser, filters, sorting, metadata search, and extension configuration schema.
- Stop the extension background hydration path that reads cached log heads solely for `codeUnitStarted`.
- Keep `codeUnitStarted` accepted in message/runtime contracts for now so older or adjacent producers do not break.
- Normalize older saved column settings that still contain `codeUnit` by silently dropping that key.
- Keep log-content rendering behavior for `CODE_UNIT_*` lines in the tail/log viewer because that is syntax highlighting of the log body, not the removed table column.

This avoids a breaking protocol change while still removing the extra processing and visible feature surface.

## Alternatives Considered

### Hide Only

The extension could hide the column and filter while leaving `loadLogHeads` running. This is smaller but fails the performance goal because cached log files would still be scanned for a value that is no longer displayed.

### Full Removal

The extension could remove `codeUnitStarted` from all TypeScript and Rust contracts. This creates a cleaner model, but it is a breaking change for app-server clients, replayed messages, and any runtime consumers that still know about the field.

## Components

### Shared Logs Columns

`LogsColumnKey`, defaults, known-key normalization, and persisted config handling should no longer include `codeUnit`. The normalizer should reject `codeUnit` from old `order`, `visibility`, and `widths` inputs by treating it as an unknown key.

### Webview UI

The toolbar should no longer calculate or render Code Unit filter options. Clearing filters should no longer track `filterCodeUnit`.

The logs table should no longer render a `codeUnit` header or cell, should not use it as a flex-column candidate, and should not allow sorting by it.

The webview metadata search haystack should no longer include `codeUnitStarted`.

### Provider and Services

The provider should not call `LogService.loadLogHeads` for normal log list refresh or load-more flows. Error triage should continue posting `logHead` updates for `hasErrors`, `primaryReason`, and `reasons`.

After the provider no longer calls `LogService.loadLogHeads`, remove `LogService.loadLogHeads`, its private cached-log Code Unit reader, `extractCodeUnitStartedFromLines`, and the tests that exist only for that hydration path, provided no production callers remain after the edit.

### Contracts

`codeUnitStarted` can remain optional on `ExtensionToWebviewMessage` and runtime triage entry types during deprecation. New UI code should ignore it.

Telemetry for log filters should keep the `hasCodeUnit` property temporarily for event-schema compatibility, but newly emitted events should always set it to `false`. Code should mark the property as deprecated where the message type is defined.

### Documentation

User-facing docs that mention filtering by code unit should be updated to remove that claim.

`CHANGELOG.md` should get an Unreleased entry because this changes visible logs-table behavior.

## Data and Compatibility

Existing users may have `electivus.apexLogs.logsColumns` settings that include `codeUnit`. The new normalizer should produce a valid config without `codeUnit` and should not throw, persist invalid values, or render an empty column.

Existing webview state may contain `filterCodeUnit` or `sortBy: "codeUnit"`. Initial state loading should ignore the old filter and fall back to the default sort (`time`) for the old sort key.

Existing extension-to-webview messages may still contain `codeUnitStarted` during reload or from runtime triage. The webview may accept the field but should not display, filter, sort, or search on it.

## Testing

Update focused webview tests for:

- Column defaults and column chooser no longer include `Code Unit`.
- Old column config containing `codeUnit` normalizes to a valid config without it.
- Logs table full-log search still shows `Match` when enabled and no longer relies on `Code Unit`.
- Toolbar no longer renders the Code Unit filter and clear-filters behavior still works.
- Initial UI state with `sortBy: "codeUnit"` falls back to `time`.

Update provider/service tests for:

- Refresh/load-more no longer expects Code Unit `logHead` hydration.
- Error triage still posts error-related `logHead` fields.

Run the relevant unit-focused suites after implementation:

- `npm run test:webview`
- `npm run test:extension:node` or a narrower equivalent if the repo supports targeting the changed extension tests
- `npm run check-types`

## Risks

The main risk is accidentally removing `logHead` entirely, which would break error filtering and error reason badges. The implementation must keep error triage updates separate from deprecated Code Unit hydration.

A second risk is persisted settings containing `codeUnit`. The normalizer must discard the old key cleanly rather than preserving an unrenderable column.

## Out of Scope

This change does not remove syntax highlighting for `CODE_UNIT_*` lines inside log content.

This change does not remove `codeUnitStarted` from Rust runtime or app-server client contracts. That can happen in a later breaking-change cleanup if needed.
