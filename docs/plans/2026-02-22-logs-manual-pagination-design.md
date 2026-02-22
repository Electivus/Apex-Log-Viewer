# Logs manual pagination (remove infinite scroll) — design

Date: 2026-02-22

## Context

The Logs webview currently supports auto-pagination ("infinite scroll") when no filters are active. When filters are active, auto-pagination is disabled and a manual **Load more** button is shown.

The desired UX is to remove infinite scroll entirely and always use an explicit **Load more** button below the table.

## Goals

- Remove infinite scroll behavior from the Logs list.
- Show a **Load more** button below the table whenever additional pages are available.
- Keep existing sorting, filtering, column sizing, and virtualized rendering behavior.
- Keep i18n strings (English + Portuguese) consistent with existing copy.

## Non-goals

- Change how paging works in the extension host (message protocol stays `{ type: 'loadMore' }`).
- Redesign the table UI or add new settings/toggles.
- Modify Tail view behavior.

## Proposed UX

- When `hasMore === true`, render a **Load more** button below the Logs table.
  - If filters/search are active, use the existing “Load more results” copy (`t.loadMoreFiltered`).
  - Otherwise use the existing “Load more logs” copy (`t.loadMore`).
- The button is always visible (not gated by scroll position) and is disabled while `loading === true`.
- The table never triggers paging automatically based on scroll position or rendered row range.

## Implementation outline

### Webview app (`LogsApp`)

- Always render the manual pagination button when `hasMore` is true.
- Remove any reliance on `autoLoadEnabled` in the table.

### Table component (`LogsTable`)

- Remove the auto-pagination logic:
  - Eliminate `handleRowsRendered` load triggers.
  - Remove the “bottom proximity” scroll fallback trigger that calls `onLoadMore`.
  - Remove the `autoLoadEnabled` prop and related refs.
- Keep the scroll listener only for:
  - Adaptive overscan adjustments.
  - Header horizontal scroll synchronization.

### Tests

- Update `LogsTable` unit tests to no longer expect automatic calls to `onLoadMore`.
- Add/adjust `LogsApp` tests to assert that:
  - Without filters and with `hasMore: true`, the “Load more logs” button is shown and posts `{ type: 'loadMore' }` on click.
  - With filters and `hasMore: true`, the “Load more results” button behavior remains.

## Changelog

Add an Unreleased entry noting that Logs pagination is now manual via a Load more button (no infinite scroll).

## Rollback plan

If manual pagination causes regressions, revert by reintroducing the removed `LogsTable` auto-pagination logic and restoring the conditional button rendering behavior in `LogsApp`.

