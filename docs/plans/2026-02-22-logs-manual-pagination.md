# Logs manual pagination Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove Logs infinite scroll (auto-pagination) and always use a manual **Load more** button below the table.

**Architecture:** Keep the virtualized `LogsTable` focused on rendering + scroll/overscan behavior only. Move pagination to `LogsApp` by always rendering a `Load more` button when `hasMore` is true. Remove all auto-load triggers (`onRowsRendered` and bottom-proximity scroll fallback).

**Tech Stack:** React 19, `react-window` (List v2 wrapper), Jest + Testing Library, Tailwind, VS Code webview message passing.

---

## Prereqs

- Worktree location (recommended): `.worktrees/logs-manual-pagination`
- Install deps: `npm ci`
- Baseline webview tests: `npm run test:webview`

## Task 1: Update `LogsTable` tests to assert no auto-pagination (RED)

**Files:**
- Modify: `src/webview/__tests__/LogsTable.test.tsx`

**Step 1: Write a failing test that ensures scrolling near the bottom does NOT call `onLoadMore`**

- Replace the current pagination-trigger tests with a new behavior test:
  - Render `LogsTable` with `hasMore: true` and `loading: false`
  - Simulate a scroll position near the bottom (`scrollTop` set so remaining <= ~2 rows)
  - Expect `onLoadMore` NOT to be called

**Step 2: Run the test to verify it fails**

Run: `npm run test:webview -- src/webview/__tests__/LogsTable.test.tsx`

Expected: FAIL because the current component triggers `onLoadMore` via the “bottom proximity” scroll fallback.

**Step 3: Commit the failing test**

```bash
git add src/webview/__tests__/LogsTable.test.tsx
git commit -m "test(logs): assert no auto-pagination in LogsTable"
```

## Task 2: Remove auto-pagination logic from `LogsTable` (GREEN)

**Files:**
- Modify: `src/webview/components/LogsTable.tsx`
- Modify: `src/webview/main.tsx`
- Modify: `src/webview/__tests__/LogsTable.test.tsx`

**Step 1: Remove `LogsTable` props and refs used for auto-pagination**

- In `LogsTable` props:
  - Remove: `hasMore`, `onLoadMore`, `autoLoadEnabled`
- Remove related refs/effects:
  - `hasMoreRef`, `loadingRef`, `autoLoadRef`, `onLoadMoreRef`, `lastLoadTsRef`
  - `handleRowsRendered`
- Remove the `onRowsRendered` prop passed down to the virtual list component.

**Step 2: Keep scroll listener for overscan + header sync only**

- The `useEffect` scroll handler should:
  - Update overscan based on scroll velocity
  - Synchronize `headerRef.scrollLeft` with the list element
- It must not call `onLoadMore` anymore.

**Step 3: Update call site**

- Update `LogsApp` usage in `src/webview/main.tsx`:
  - Stop passing removed props to `LogsTable`

**Step 4: Run the test to verify it now passes**

Run: `npm run test:webview -- src/webview/__tests__/LogsTable.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/webview/components/LogsTable.tsx src/webview/main.tsx src/webview/__tests__/LogsTable.test.tsx
git commit -m "refactor(logs): remove infinite scroll from LogsTable"
```

## Task 3: Always show the manual Load more button in `LogsApp`

**Files:**
- Modify: `src/webview/main.tsx`
- Modify: `src/webview/__tests__/logsApp.test.tsx`

**Step 1: Change button rendering**

- Replace the conditional `{hasFilters && hasMore && (...)}` with `{hasMore && (...)}`.
- Button label:
  - When `hasFilters` is true: `t.loadMoreFiltered ?? t.loadMore ?? 'Load more results'`
  - When `hasFilters` is false: `t.loadMore ?? 'Load more logs'`
- Keep `disabled={loading}`.

**Step 2: Add a failing test for “no filters still shows button”**

- In `logsApp.test.tsx`, add a new test:
  - Render app
  - Send `{ type: 'logs', hasMore: true }` and `{ type: 'loading', value: false }`
  - Assert a button exists with name `Load more logs`
  - Click it and assert `{ type: 'loadMore' }` was posted

Run: `npm run test:webview -- src/webview/__tests__/logsApp.test.tsx`

Expected: FAIL before the UI change, PASS after.

**Step 3: Commit**

```bash
git add src/webview/main.tsx src/webview/__tests__/logsApp.test.tsx
git commit -m "feat(logs): always show manual load more button"
```

## Task 4: Update changelog

**Files:**
- Modify: `CHANGELOG.md`

**Step 1: Add an Unreleased note**

- Under `## Unreleased` → `### Features`, add:
  - `- Logs: replace infinite scroll with a manual Load more button below the listing.`

**Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note manual logs pagination"
```

## Task 5: Verification

**Step 1: Run webview tests**

Run: `npm run test:webview`

Expected: PASS (all webview suites).

**Step 2: Run full test suite (optional but recommended)**

Run: `npm test`

Expected: PASS (unit + coverage merge).

