# Logs status reason truncation design

## Context

The Electivus Apex Logs webview table can show a long detected-error reason inside the `Status` column. In the current layout, very long reasons can visually run across adjacent columns, making `Code Unit`, `Size`, and other cells harder to read.

The requested behavior is to keep the status cell compact by showing a summarized/truncated reason with a tooltip for the complete text.

## Goals

- Keep `Status` column content visually contained within its grid cell.
- Keep the base Salesforce log status, such as `Success`, visible.
- Keep the detected error badge visible when triage reports an error.
- Render the primary error reason as a single-line truncated label with an ellipsis.
- Preserve the full error reason in a tooltip/title for inspection.
- Avoid changing log triage, sorting, filtering, storage, or Salesforce API behavior.

## Non-goals

- Do not redesign the entire logs table.
- Do not add a new details drawer or popover for this first improvement.
- Do not require a wider default `Status` column as the primary fix.
- Do not change the canonical log cache layout or org sync behavior.

## Design

Update the `Status` cell rendering in the webview logs table so that the long primary reason is a constrained, truncating inline label.

The cell should continue to render:

1. the raw log status text;
2. the `Error` badge when the log has detected errors;
3. the primary reason, if available.

The primary reason label should be allowed to shrink inside the status cell and should use single-line ellipsis behavior. The complete reason remains available through the existing `title` tooltip on the reason label.

The important layout properties are:

- the status cell and/or reason label must have `min-width: 0` so CSS grid/flex shrinking works;
- the reason label must use `overflow: hidden`;
- the reason label must use `text-overflow: ellipsis`;
- the reason label must use `white-space: nowrap`;
- the error badge should not shrink away before the reason truncates.

This keeps the row compact and prevents long Apex/Salesforce exception text from overlaying neighboring columns.

## Components affected

- `packages/webview/src/components/table/LogRow.tsx`
  - status-cell rendering and reason-badge classes.
- `packages/webview/src/__tests__/LogRow.test.tsx`
  - focused tests for reason truncation classes and tooltip preservation.

No backend/runtime changes are expected.

## Data flow

Existing log triage still populates `logHead[logId].primaryReason`. `LogRow` receives that value through the existing `logHead` prop. Rendering changes only affect presentation of that string in the status cell.

## Accessibility and UX

- The visible reason may be truncated, but the full value remains available through the `title` attribute.
- The existing visible `Error` badge remains, so users can still identify error rows without reading the full reason.
- Keyboard row actions and button actions remain unchanged.

## Testing and validation

Automated tests should cover:

- when `primaryReason` is present, the reason label preserves the complete text in `title`;
- the reason label uses truncation-friendly classes/properties;
- the status cell keeps wrapping/truncation layout support without hiding the error badge.

Expected verification:

- Run a focused webview test for `LogRow`.
- Run `npm run test:webview`.
- If practical after implementation, manually validate the extension panel with org `ElectivusDevHub` and logs that contain long exception reasons.

## Risks

- JSDOM tests cannot measure actual pixel overflow, so automated coverage should assert the intended truncation classes and tooltip contract.
- Users who prefer seeing the full reason inline will need to hover for the full text; this is accepted for the first improvement because the user explicitly chose summarized/truncated display.
