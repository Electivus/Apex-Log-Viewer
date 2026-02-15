# Logs Panel Column Customization (Design)

Date: 2026-02-15

## Summary

Add user-configurable columns for the **Electivus Apex Logs** panel (the `sfLogViewer` webview):

- Toggle which columns are visible
- Reorder columns via drag-and-drop
- Resize columns via drag handles in the sticky table header
- Persist choices in **VS Code user settings** (global scope)

This is implemented as a **webview popover** opened from the existing toolbar, with changes applied immediately.

## Goals

- Let users control which columns they see in the logs table.
- Let users reorder columns without leaving the panel.
- Let users resize columns using familiar “grab the divider” interaction.
- Persist configuration to user settings so it survives reloads and can sync across machines.
- Keep default behavior consistent with the current table layout when no customization is set.

## Non-goals

- Customizing the Tail panel (`sfLogTail`) in this iteration.
- Adding new data columns beyond what the table already renders.
- Per-org/per-workspace column profiles.
- Arbitrary per-row formatting customization.

## Current State

The logs table columns are hard-coded in the webview:

- Header rendering: `apps/vscode-extension/src/webview/components/table/LogsHeader.tsx`
- Row rendering: `apps/vscode-extension/src/webview/components/table/LogRow.tsx`
- Column widths/layout: computed as a fixed CSS Grid template string in `apps/vscode-extension/src/webview/components/LogsTable.tsx`

The “Match” column is currently shown only when full log search is enabled.

## Proposed UX

### Toolbar button

Add a **Columns** button to the existing logs `Toolbar` row.

- Clicking opens a popover anchored to the button.
- Popover closes on `Escape`, outside click, or re-clicking the trigger.

### Columns popover

Inside the popover:

- A vertical list of the available data columns.
- Each row has:
  - Drag handle (reorder)
  - Column label
  - Switch to toggle visibility
- A **Reset to defaults** action:
  - Restores default order
  - Restores all columns to visible
  - Clears custom widths (returns to responsive defaults)

Column rules:

- **All data columns are toggleable.**
- The **Actions** column (Open / Replay buttons) is always present and is not configurable.
- The **Match** column is still dependent on full log search:
  - If full log search is disabled, the Match toggle is disabled (configuration remains stored).
  - If full log search is enabled, Match visibility is controlled by the toggle.

### Resize handles in header (sticky)

Each visible header cell (except Actions) gets a resize handle on its right edge.

- Dragging adjusts the column width live.
- Width is clamped to a per-column minimum (based on existing min widths).
- Optional quality-of-life: double-click the handle resets that column width to default (clears the custom width entry).

## Data Model

### Column keys

Log table columns are represented by stable keys:

- `user`
- `application`
- `operation`
- `time`
- `duration`
- `status`
- `codeUnit`
- `size`
- `match`

`actions` is not part of the configuration (always present).

### Settings shape (persisted)

Add a new setting under the existing extension namespace:

`electivus.apexLogs.logsColumns`

Stored value (object):

- `order`: array of column keys (includes keys for hidden columns so order is stable)
- `visibility`: record of `key -> boolean` (absent means default `true`)
- `widths`: record of `key -> number` (pixels; absent means “default responsive width”)

Defaults:

- `order`: current UI order
- `visibility`: all `true`
- `widths`: empty (all columns use existing responsive `minmax()` grid tracks)

Validation rules:

- Unknown keys are ignored.
- Missing/invalid objects fall back to defaults.
- Widths are clamped to min/max.

## Extension ↔ Webview Data Flow

Webview cannot directly read/write VS Code settings, so the extension host is the source of truth.

### Extension → Webview

- On webview init, send current config to webview (alongside locale / feature flags).
- On settings change (`onDidChangeConfiguration`), send updated config if `electivus.apexLogs.logsColumns` changes.

### Webview → Extension

- When user changes visibility/order/widths, send an update message with the new config.
- For resize:
  - Update local state continuously for live feedback.
  - Persist to settings on pointer-up (or debounce) to avoid excessive settings writes.

## Implementation Outline

### Webview (React)

- Add a reusable `ColumnsPopover` component used by `Toolbar`.
  - Uses Radix Popover for accessibility + focus management.
  - Uses `dnd-kit` sortable list for reorder.
- Refactor table rendering to be driven by an ordered list of “active columns”:
  - `LogsHeader` renders headers from column list + resizers
  - `LogRow` renders cells from the same column list
  - `LogsTable` builds `gridTemplateColumns` from order + visibility + widths
- Keep `react-window` virtual list intact; only the row component changes.

### Extension host

- Add config read/write support for `electivus.apexLogs.logsColumns`.
- Update the logs view provider to include column config in the init payload.
- Add a new message handler case to persist updates from the webview.

## Dependencies

Add webview UI dependencies (extension package):

- `@radix-ui/react-popover` for popovers
- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` for reorder

No CLI changes.

## Testing Plan

Webview Jest tests:

- Toggling a column hides it from the rendered header/rows.
- Reordering updates render order.
- Resizing updates the computed `gridTemplateColumns` style (unit-level).
- “Match” column respects both:
  - `fullLogSearchEnabled`
  - user visibility toggle

Extension tests (if present/appropriate):

- Config validation + defaults applied when setting missing/invalid.
- Settings update is called with `ConfigurationTarget.Global`.

## Rollout / Compatibility

- New setting is additive; existing users see no behavior change unless they use the Columns UI.
- Default column layout remains the current layout.

