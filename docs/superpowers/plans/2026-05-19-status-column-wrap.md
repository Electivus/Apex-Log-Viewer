# Status Column Wrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep long Salesforce `ApexLog.Status` messages inside the logs table `Status` column by allowing the text to wrap.

**Architecture:** This is a presentation-only webview change. `LogRow` will keep rendering the raw `r.Status` string, but the status text span will be shrinkable and wrapping-friendly inside the existing grid/flex cell. Existing error and triage reason badges remain unchanged.

**Tech Stack:** TypeScript, React, Tailwind utility classes, Jest, React Testing Library.

---

## File Map

- `packages/webview/src/components/table/LogRow.tsx`: change the status text span classes and add a stable test id.
- `packages/webview/src/__tests__/LogRow.test.tsx`: add a focused regression test for long status text wrapping classes.

---

## Task 1: Wrap Raw Salesforce Status Text In The Logs Table

**Files:**
- Modify: `packages/webview/src/__tests__/LogRow.test.tsx`
- Modify: `packages/webview/src/components/table/LogRow.tsx`

- [ ] **Step 1: Write the failing regression test**

Add this test to `packages/webview/src/__tests__/LogRow.test.tsx` after `shows error badge on status column when error is detected`:

```tsx
  it('lets long Salesforce status text wrap inside the status column', () => {
    const row: ApexLogRow = {
      Id: 'long-status-1',
      StartTime: new Date().toISOString(),
      Operation: 'Op',
      Application: 'App',
      DurationMilliseconds: 1,
      Status:
        "Insert failed. First exception on row 0; first error: INVALID_INPUT, The selected language isn't currently supported. Apex error: List has no rows for assignment to SObject",
      Request: '',
      LogLength: 2048,
      LogUser: { Name: 'User' }
    };

    render(
      <LogRow
        r={row}
        logHead={{ 'long-status-1': { hasErrors: true, primaryReason: 'Validation failure' } as any }}
        locale="en-US"
        t={{ open: 'Open', replay: 'Replay', filters: { errorDetectedBadge: 'Error' } }}
        columns={['status']}
        loading={false}
        onOpen={() => {}}
        onReplay={() => {}}
        gridTemplate="220px 96px"
        style={{}}
        index={0}
        setRowHeight={() => {}}
      />
    );

    const statusText = screen.getByTestId('logs-status-text');
    expect(statusText).toHaveTextContent('List has no rows for assignment to SObject');
    expect(statusText.className).toContain('min-w-0');
    expect(statusText.className).toContain('max-w-full');
    expect(statusText.className).toContain('whitespace-normal');
    expect(statusText.className).toContain('break-words');
    expect(statusText.className).not.toContain('shrink-0');
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Validation failure')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:webview -- --runTestsByPath packages/webview/src/__tests__/LogRow.test.tsx --runInBand
```

Expected: FAIL because `logs-status-text` does not exist yet and the current status span uses `shrink-0`.

- [ ] **Step 3: Implement the minimal rendering change**

In `packages/webview/src/components/table/LogRow.tsx`, replace the status text span in the `status` case:

```tsx
                  <span className="shrink-0">{r.Status}</span>
```

with:

```tsx
                  <span data-testid="logs-status-text" className="min-w-0 max-w-full whitespace-normal break-words">
                    {r.Status}
                  </span>
```

Leave the `Error` badge and the `primaryReason` badge unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm run test:webview -- --runTestsByPath packages/webview/src/__tests__/LogRow.test.tsx --runInBand
```

Expected: PASS for `LogRow.test.tsx`.

- [ ] **Step 5: Run the full webview suite**

Run:

```bash
npm run test:webview -- --runInBand
```

Expected: PASS for the webview Jest suite.

- [ ] **Step 6: Review the diff**

Run:

```bash
git diff -- packages/webview/src/components/table/LogRow.tsx packages/webview/src/__tests__/LogRow.test.tsx
```

Expected: The only implementation behavior change is the status text wrapping classes and test id; the test only covers this regression and existing badges.

- [ ] **Step 7: Commit the implementation**

Run:

```bash
git add packages/webview/src/components/table/LogRow.tsx packages/webview/src/__tests__/LogRow.test.tsx
git commit -m "fix(logs): wrap long status text"
```
