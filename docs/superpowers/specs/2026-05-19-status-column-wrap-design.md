# Status column text wrapping design

## Context

The logs table renders the Salesforce `ApexLog.Status` value directly in the `Status` column. For failed Apex logs, Salesforce can return a long exception message in that field instead of a short value such as `Success`.

The current status text is rendered as a non-shrinking inline item inside a flex cell. When the status value is long, it can overflow across adjacent columns, making the row hard to read.

## Goals

- Preserve the raw `ApexLog.Status` value returned by Salesforce.
- Keep the status text visually contained inside the `Status` column.
- Let long status text wrap automatically instead of crossing into other columns.
- Keep the existing `Error` and triage reason badges visible.
- Avoid changing Salesforce API queries, triage logic, sorting, filtering, or log storage.

## Non-goals

- Do not normalize long Salesforce status values into `Failed`, `Error`, or another derived label.
- Do not remove the existing error badge.
- Do not remove the existing triage reason badge.
- Do not redesign the full logs table or change the default column order.

## Design

Update only the webview rendering for the logs table `Status` cell. The cell should still display:

1. the raw Salesforce status string;
2. the `Error` badge when log triage reports an error;
3. the primary triage reason badge when available.

The raw status string should be rendered in an element that can shrink within the CSS grid/flex layout and wrap long text. The important layout constraints are:

- the status text element must not use `shrink-0`;
- the status text element should allow wrapping and breaking long words;
- the status cell should keep `min-width: 0` behavior inherited from the shared cell class;
- badges may remain non-shrinking so they stay readable.

This preserves Salesforce data while preventing long exception text from overlaying neighboring columns.

## Components affected

- `packages/webview/src/components/table/LogRow.tsx`
  - status text classes inside the `status` column case.
- `packages/webview/src/__tests__/LogRow.test.tsx`
  - focused regression coverage that long status text is rendered with wrapping-friendly classes instead of `shrink-0`.

No runtime, CLI, extension host, or Rust changes are expected.

## Data flow

No data flow changes are required. `ApexLog.Status` continues to come from the existing log list response and arrives in `LogRow` as `r.Status`.

Only presentation changes. Filtering and sorting by status continue to use the original `r.Status` string.

## Testing and validation

Automated coverage should assert that:

- a long status value is rendered in the status column;
- the status text uses wrapping-friendly classes;
- the status text no longer uses the non-shrinking class that causes overflow risk;
- existing error and reason badges still render when triage data is present.

Expected verification:

- Run the focused webview test for `LogRow`.
- Run `npm run test:webview` if the focused test passes.

## Risks

- JSDOM cannot prove actual pixel-level table overflow, so the regression test should focus on the class contract that controls layout.
- Very long Salesforce status messages will make affected rows taller. The logs table already measures variable row height with `ResizeObserver`, so this is an expected outcome.
