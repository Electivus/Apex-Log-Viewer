# Open Log View Triage Sidebar Design

## Goal

Expand the `Open Log View` experience so developers can find parser-detected log errors faster by combining:

- a dedicated diagnostics sidebar for parser-backed triage results
- inline highlighting on affected log rows
- click-to-navigate behavior from the sidebar into the virtualized log list

The view must still open at the top of the log. Navigation to the first issue only happens after the user explicitly clicks a sidebar item.

## Context

The repository already uses `tree-sitter-sfapex` / `sflog-triage` on the extension side to classify saved logs and produce `LogTriageSummary` data such as `hasErrors`, `primaryReason`, and `reasons[]`. That parser-backed triage currently improves the main logs list, but the `Open Log View` webview still loads only the raw log text and local file metadata. Inside the webview, `parseLogLines()` creates `ParsedLogEntry[]` from the file content for rendering, filtering, and search.

This means the developer can identify that a log is suspicious before opening it, but once the detailed log viewer opens, the parser-backed diagnostics are lost. The current experience forces manual scrolling or searching through long logs even when structured diagnostics already exist.

## Approved UX Decisions

- Use a dedicated diagnostics sidebar in the `Open Log View`.
- Also highlight affected rows inline in the main log list.
- The view opens at the top of the log, not at the first diagnostic.
- Clicking a sidebar item scrolls the list to the related row and marks that diagnostic as active.
- Existing line-category filters in the view remain available and are not replaced by the diagnostics sidebar.

## Architecture

The detailed log viewer keeps its current split responsibilities:

- The extension host remains responsible for parser-backed triage.
- The webview remains responsible for loading the raw file and parsing rows for presentation.

The new data flow is:

1. `LogViewerPanel` opens a saved log as it does today.
2. Before posting `logViewerInit`, the panel also resolves the `LogTriageSummary` for that file.
3. The `logViewerInit` message sends:
   - `logUri`
   - existing file metadata
   - parser-backed triage payload for the file
4. The webview fetches the raw log text as it does today and parses it into `ParsedLogEntry[]`.
5. A lightweight adapter maps `LogTriageSummary.reasons[]` to rendered rows using `diagnostic.line` as the primary key.
6. The diagnostics sidebar renders from the triage payload.
7. The log list renders inline markers from the same mapped diagnostics data.

The webview does not run `tree-sitter-sfapex` itself. Parser-backed diagnostics stay on the extension side and are treated as input data for the UI.

## Data Contract Changes

`LogViewerToWebviewMessage` should grow a triage payload on `logViewerInit`. The payload should include:

- `hasErrors`
- `primaryReason`
- `reasons[]`

Each diagnostic entry should preserve the existing normalized fields:

- `code`
- `severity`
- `summary`
- `line`
- `eventType`

`severity` is constrained to the existing normalized enum used by shared triage types: `error | warning`. Unknown severities should already be filtered out by extension-side normalization and must not reach the webview contract.

The webview should treat the payload as optional. If triage data is missing or empty, the `Open Log View` must still load and behave like the current implementation.

## UI Layout

Below the existing header and filters row, the page should become a two-pane layout:

- Left pane: diagnostics sidebar
- Right pane: virtualized log entries list

The diagnostics sidebar should include:

- A compact title such as `Diagnostics`
- Counts for `Errors` and `Warnings`
- Local sidebar filter chips or tabs for `All`, `Errors`, and `Warnings`
- A vertically scrollable list of diagnostics ordered by line number when available

Each sidebar item should show:

- `summary`
- `line` when known
- `eventType` when useful
- severity styling

Sidebar counts and filters are based on the two normalized severity buckets only:

- `Errors` = diagnostics with `severity: "error"`
- `Warnings` = diagnostics with `severity: "warning"`

The active sidebar item should have a stronger selected state than the non-active items.

The main log list should keep the current row layout and add:

- a row-level visual highlight for rows referenced by diagnostics
- a stronger active-state highlight for the row selected through the sidebar
- a compact diagnostic badge or summary fragment on the row when one or more diagnostics map to it

If multiple diagnostics map to the same row, the row should present the most severe reason first and still preserve the rest in the row metadata for tooltip or secondary rendering.

Row-level collapse order must be deterministic:

- sort mapped diagnostics for the row by severity, with `error` before `warning`
- preserve original `reasons[]` order for ties within the same severity
- show the first sorted diagnostic as the primary row badge or summary
- keep the remaining diagnostics available as secondary row metadata for tooltip or expanded rendering

## Interaction Model

Initial load:

- The log view opens at the top.
- No diagnostic is auto-selected.
- The sidebar shows available diagnostics immediately after the init payload arrives.
- Inline row highlighting appears once rows are parsed and line mappings are resolved.

Sidebar interaction:

- Clicking a sidebar item makes it active.
- If the item is mapped, the list scrolls to the mapped row with centered alignment.
- If the item is unmapped, the sidebar item still becomes active but the list does not scroll and no toast is shown.
- The matching row receives the active diagnostic highlight only for mapped items.

Filtering:

- Existing `Debug Only`, `Errors`, `SOQL`, and `DML` filters keep their current semantics based on parsed row categories.
- Sidebar filters apply only to diagnostics shown in the sidebar.
- Sidebar filtering must not mutate the underlying log rows or replace the main filters.

Search:

- Existing text search remains unchanged.
- Search highlighting and diagnostic highlighting can coexist on the same row.
- The active diagnostic state must remain visible even when search matches are present.

## Mapping Rules

The adapter between `LogTriageSummary.reasons[]` and `ParsedLogEntry[]` should be deterministic and conservative.

Primary mapping:

- Treat `diagnostic.line` as a 1-based log line number.
- Use `diagnostic.line` to map a diagnostic to the parsed row whose `lineNumber` matches that same 1-based value exactly.
- Do not translate `diagnostic.line` to a zero-based row index.

Fallback behavior:

- If a diagnostic has no `line`, keep it in the sidebar with a `No exact line` style and do not force a row highlight.
- If a diagnostic has a line but no parsed row matches it, keep the sidebar item available and treat it as unmapped instead of guessing aggressively.

The first implementation should not attempt fuzzy full-text matching or parser re-analysis inside the browser. Planning can add a narrow fallback later if implementation reveals a recurring mismatch pattern, but the approved design assumes exact line matching only.

## Failure and Degradation Behavior

The diagnostics experience is additive. It must never block the log viewer.

- If parser-backed triage is unavailable, the log opens normally and the sidebar shows a simple unavailable state.
- If diagnostics exist but some rows cannot be mapped, mapped rows still highlight correctly and unmapped diagnostics remain visible in the sidebar.
- If the file refreshes and previous mappings become stale, the UI should clear invalid active-row state rather than crashing or pointing to the wrong row.
- The raw log content always remains readable even when diagnostics data is incomplete.

## Testing Strategy

Implementation planning should cover at least these test areas.

Extension-side messaging:

- `LogViewerPanel` sends triage data together with `logUri` and metadata.
- Missing triage data still produces a valid `logViewerInit` payload.

Webview app state:

- The diagnostics sidebar renders from init payload data.
- Sidebar severity filters switch between `All`, `Errors`, and `Warnings`.
- Clicking a sidebar diagnostic activates it and requests scroll to the mapped row.
- The app remains stable when diagnostics are absent.

Mapping logic:

- A diagnostic with a valid line maps to the expected parsed row.
- Diagnostics without `line` remain sidebar-only.
- Clicking an unmapped sidebar item activates it without attempting row scroll.
- Multiple diagnostics on one row collapse to one row decoration while preserving individual sidebar entries.
- Row-level collapse order is deterministic: `error` before `warning`, then original diagnostic order for ties.

Row rendering:

- Diagnostic badges render on affected rows.
- Active diagnostic styling is stronger than passive highlighted styling.
- Search highlighting remains visible without masking active diagnostic state.

## Scope Boundaries

In scope:

- passing parser-backed diagnostics into `Open Log View`
- dedicated diagnostics sidebar
- inline row highlighting and active selection state
- click-to-scroll navigation from sidebar to list
- tests for message flow, mapping, and UI rendering

Out of scope for this design:

- automatically opening the log at the first error
- running `tree-sitter-sfapex` inside the webview
- replacing existing row-category filters with diagnostics-only controls
- adding fuzzy diagnosis-to-row matching heuristics
- redesigning the entire log viewer layout beyond what is needed for the sidebar

## Risks

- Some diagnostics may not include a line that matches the row parser output exactly.
- A two-pane layout may reduce readable width for long messages if the sidebar is too wide.
- Active diagnostic styling can conflict visually with search highlighting if not layered carefully.

## Mitigations

- Treat unmapped diagnostics as valid sidebar items instead of forcing unreliable row guesses.
- Keep the sidebar compact and fixed-width so the log list remains the primary reading surface.
- Use separate visual treatments for passive diagnostic rows, active diagnostic rows, and search matches.
