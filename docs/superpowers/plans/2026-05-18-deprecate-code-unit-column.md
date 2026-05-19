# Deprecate Code Unit Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the user-facing Code Unit logs-table column and stop the extension's extra Code Unit hydration work while keeping deprecated protocol fields compatible.

**Architecture:** Treat `codeUnit` as an unknown persisted column key and drop it during normalization. Remove all webview behavior that displays, filters, sorts, or searches by Code Unit. Keep `logHead` and optional `codeUnitStarted` protocol fields for compatibility, but use `logHead` only for error triage state in current UI.

**Tech Stack:** TypeScript, React, VS Code extension APIs, Jest, VS Code node tests, npm scripts.

---

## File Map

- `apps/vscode-extension/src/shared/logsColumns.ts`: remove `codeUnit` from column type, defaults, and normalization output.
- `apps/vscode-extension/src/shared/messages.ts`: mark `hasCodeUnit` and `codeUnitStarted` as deprecated compatibility fields; keep parser compatibility.
- `apps/vscode-extension/package.json`: remove `codeUnit` from contributed `electivus.apexLogs.logsColumns` default/schema.
- `packages/webview/src/utils/logsColumns.ts`: remove Code Unit widths, tracks, and label branch.
- `packages/webview/src/i18n.ts`: remove unused Code Unit column label strings.
- `packages/webview/src/components/Toolbar.tsx`: remove Code Unit filter props and select.
- `packages/webview/src/components/LogsTable.tsx`: remove Code Unit table behavior and flex preference.
- `packages/webview/src/components/table/LogRow.tsx`: remove Code Unit cell rendering.
- `packages/webview/src/main.tsx`: remove Code Unit UI state, filtering, sorting, metadata search, and emitted active filter count; keep deprecated telemetry property as `false`.
- `apps/vscode-extension/src/provider/SfLogsViewProvider.ts`: stop calling Code Unit log-head hydration; keep auth warning hydration and error triage.
- `src/services/logService.ts`: remove Code Unit-only log-head loader and cached-log reader when no production caller remains.
- `src/salesforce/http.ts`: remove extension-only Code Unit extractor when no production caller remains.
- Tests under `packages/webview/src/__tests__/` and `apps/vscode-extension/src/test/`: update expectations and add compatibility coverage.
- `apps/vscode-extension/README.md` and `apps/vscode-extension/CHANGELOG.md`: update user-facing docs.
- Generated webview bundles under `apps/vscode-extension/media/`: regenerate through the existing build script after source changes.

---

## Task 1: Shared Column Contract and Persisted Config Compatibility

**Files:**
- Modify: `apps/vscode-extension/src/shared/logsColumns.ts`
- Modify: `apps/vscode-extension/src/shared/messages.ts`
- Modify: `apps/vscode-extension/src/test/logsColumnsConfig.test.ts`
- Modify: `apps/vscode-extension/package.json`

- [ ] **Step 1: Write the failing persisted-config compatibility test**

Add this test to `apps/vscode-extension/src/test/logsColumnsConfig.test.ts` after `filters unknown keys and appends missing keys`:

```ts
  test('drops deprecated codeUnit settings from persisted configs', () => {
    const cfg = normalizeLogsColumnsConfig({
      order: ['codeUnit', 'time', 'user', 'codeUnit'],
      visibility: {
        codeUnit: false,
        user: false
      },
      widths: {
        codeUnit: 999,
        time: 123.9
      }
    } as any);

    assert.deepEqual(cfg.order, ['time', 'user', 'application', 'operation', 'duration', 'status', 'size', 'match']);
    assert.equal((cfg.visibility as any).codeUnit, undefined);
    assert.equal(cfg.visibility.user, false);
    assert.equal((cfg.widths as any).codeUnit, undefined);
    assert.equal(cfg.widths.time, 123);
  });
```

- [ ] **Step 2: Run the column config test and verify it fails**

Run:

```bash
npm run pretest
node scripts/run-tests-cli.js --scope=unit
```

Expected: FAIL for `drops deprecated codeUnit settings from persisted configs` because the current normalizer still treats `codeUnit` as a valid key.

- [ ] **Step 3: Remove `codeUnit` from the shared column model**

In `apps/vscode-extension/src/shared/logsColumns.ts`, replace the column type and default order with:

```ts
export type LogsColumnKey =
  | 'user'
  | 'application'
  | 'operation'
  | 'time'
  | 'duration'
  | 'status'
  | 'size'
  | 'match';

export const DEFAULT_LOGS_COLUMN_ORDER: LogsColumnKey[] = [
  'user',
  'application',
  'operation',
  'time',
  'duration',
  'status',
  'size',
  'match'
];
```

Do not add a special-case migration branch for `codeUnit`. With `KNOWN_KEYS` derived from `DEFAULT_LOGS_COLUMN_ORDER`, existing persisted `codeUnit` entries are filtered out as unknown values.

- [ ] **Step 4: Keep deprecated message fields compatible**

In `apps/vscode-extension/src/shared/messages.ts`, keep the existing fields but annotate them:

```ts
      /**
       * @deprecated Code Unit filtering was removed. Kept temporarily so older webview messages
       * and telemetry parsers remain compatible during deprecation.
       */
      hasCodeUnit: boolean;
```

and:

```ts
      /**
       * @deprecated Code Unit table hydration was removed. Kept for compatibility with older
       * runtime/app-server producers during deprecation.
       */
      codeUnitStarted?: string;
```

Do not change `parseWebviewToExtensionMessage` in this task; current parser compatibility is intentional.

- [ ] **Step 5: Remove `codeUnit` from extension contribution schema**

In `apps/vscode-extension/package.json`, update `contributes.configuration.properties["electivus.apexLogs.logsColumns"]` so the default and schema use this column set only:

```json
"default": {
  "order": [
    "user",
    "application",
    "operation",
    "time",
    "duration",
    "status",
    "size",
    "match"
  ],
  "visibility": {
    "user": true,
    "application": true,
    "operation": true,
    "time": true,
    "duration": true,
    "status": true,
    "size": true,
    "match": true
  },
  "widths": {}
}
```

Also remove `"codeUnit"` from the `order.items.enum`, `visibility.properties`, and `widths.properties` lists.

- [ ] **Step 6: Run the column config test and verify it passes**

Run:

```bash
npm run pretest
node scripts/run-tests-cli.js --scope=unit
```

Expected: PASS for all `logsColumns config` tests.

- [ ] **Step 7: Commit Task 1**

```bash
git add apps/vscode-extension/src/shared/logsColumns.ts apps/vscode-extension/src/shared/messages.ts apps/vscode-extension/src/test/logsColumnsConfig.test.ts apps/vscode-extension/package.json
git commit -m "fix(logs): deprecate code unit column config"
```

---

## Task 2: Webview UI Removal

**Files:**
- Modify: `packages/webview/src/utils/logsColumns.ts`
- Modify: `packages/webview/src/i18n.ts`
- Modify: `packages/webview/src/components/Toolbar.tsx`
- Modify: `packages/webview/src/components/LogsTable.tsx`
- Modify: `packages/webview/src/components/table/LogRow.tsx`
- Modify: `packages/webview/src/main.tsx`
- Modify: `packages/webview/src/__tests__/Toolbar.test.tsx`
- Modify: `packages/webview/src/__tests__/ColumnsPopover.test.tsx`
- Modify: `packages/webview/src/__tests__/LogsTable.test.tsx`
- Modify: `packages/webview/src/__tests__/LogRow.test.tsx`
- Modify: `packages/webview/src/__tests__/LogsHeader.test.tsx`
- Modify: `packages/webview/src/__tests__/logsColumns.test.ts`
- Modify: `packages/webview/src/__tests__/logsApp.test.tsx`

- [ ] **Step 1: Write/update failing webview tests for the removed column**

In `packages/webview/src/__tests__/LogsTable.test.tsx`, replace `defaultColumnsConfig` with:

```ts
const defaultColumnsConfig = {
  order: ['user', 'application', 'operation', 'time', 'duration', 'status', 'size', 'match'],
  visibility: {
    user: true,
    application: true,
    operation: true,
    time: true,
    duration: true,
    status: true,
    size: true,
    match: true
  },
  widths: {}
} as const;
```

Replace the two Code Unit assertions at the end with:

```ts
  it('shows match column when full log search is enabled without showing code unit', () => {
    const captured: CapturedList = {};
    renderTable({ captured, fullLogSearchEnabled: true });
    expect(screen.queryByText('Code Unit')).toBeNull();
    expect(screen.getByText('Match')).toBeInTheDocument();
  });

  it('hides both deprecated code unit and match when full log search is disabled', () => {
    const captured: CapturedList = {};
    renderTable({ captured, fullLogSearchEnabled: false });
    expect(screen.queryByText('Code Unit')).toBeNull();
    expect(screen.queryByText('Match')).toBeNull();
  });
```

In `packages/webview/src/__tests__/Toolbar.test.tsx`, replace `defaultColumnsConfig` with the same 8-column object above. Remove `filterCodeUnit`, `codeUnits`, and `onFilterCodeUnitChange` from `renderToolbar`. Add this assertion inside `disables clear action when no filters and captures query updates` after `renderToolbar()`:

```ts
    expect(screen.queryByLabelText('Code Unit')).toBeNull();
```

In `packages/webview/src/__tests__/ColumnsPopover.test.tsx`, replace `initialColumnsConfig` with the same 8-column object above and add this assertion after opening the popover in `toggles visibility, reorders, and resets to defaults`:

```ts
    expect(screen.queryByText('Code Unit')).toBeNull();
```

In `packages/webview/src/__tests__/logsApp.test.tsx`, add this test before `restores and persists logs UI state through the VS Code webview api`:

```ts
  it('ignores deprecated code unit state and does not expose the code unit filter', async () => {
    const { vscode, getSavedState } = createVsCodeMock({
      query: '',
      filterCodeUnit: 'LegacyUnit',
      sortBy: 'codeUnit',
      sortDir: 'asc'
    });
    const bus = new EventTarget();
    render(<LogsApp vscode={vscode} messageBus={bus} />);

    expect(screen.queryByLabelText('Code Unit')).toBeNull();

    await waitFor(() => {
      expect((getSavedState() as any)?.filterCodeUnit).toBeUndefined();
      expect((getSavedState() as any)?.sortBy).toBe('time');
      expect((getSavedState() as any)?.sortDir).toBe('asc');
    });
  });
```

- [ ] **Step 2: Run webview tests and verify failure**

Run:

```bash
npm run test:webview -- --runTestsByPath packages/webview/src/__tests__/LogsTable.test.tsx packages/webview/src/__tests__/Toolbar.test.tsx packages/webview/src/__tests__/ColumnsPopover.test.tsx packages/webview/src/__tests__/logsApp.test.tsx
```

Expected: FAIL because `Code Unit` is still rendered and `filterCodeUnit` is still persisted.

- [ ] **Step 3: Remove Code Unit column utilities and labels**

In `packages/webview/src/utils/logsColumns.ts`, remove `codeUnit` from `LOGS_COLUMN_MIN_WIDTH_PX`, `LOGS_COLUMN_DEFAULT_TRACK`, and `getLogsColumnLabel`.

The final `getLogsColumnLabel` switch should be:

```ts
export function getLogsColumnLabel(key: LogsColumnKey, t: any): string {
  switch (key) {
    case 'user':
      return t?.columns?.user ?? 'User';
    case 'application':
      return t?.columns?.application ?? 'Application';
    case 'operation':
      return t?.columns?.operation ?? 'Operation';
    case 'time':
      return t?.columns?.time ?? 'Time';
    case 'duration':
      return t?.columns?.duration ?? 'Duration';
    case 'status':
      return t?.columns?.status ?? 'Status';
    case 'size':
      return t?.columns?.size ?? 'Size';
    case 'match':
      return t?.columns?.match ?? 'Match';
  }
}
```

In `packages/webview/src/i18n.ts`, remove `codeUnitStarted: string;` from `Messages["columns"]` and remove the `codeUnitStarted: 'Code Unit'` entries from the English and Portuguese message objects.

- [ ] **Step 4: Remove the toolbar Code Unit filter**

In `packages/webview/src/components/Toolbar.tsx`, remove these props from `ToolbarProps` and the component destructuring:

```ts
  codeUnits: string[];
  filterCodeUnit: string;
  onFilterCodeUnitChange: (v: string) => void;
```

Change the active-filter calculation to:

```ts
  const hasFilters = Boolean(filterUser || filterOperation || filterStatus || errorsOnly);
```

Delete the `FilterSelect` block whose label is `t.columns?.codeUnitStarted ?? 'Code Unit'`.

- [ ] **Step 5: Remove table Code Unit rendering**

In `packages/webview/src/components/LogsTable.tsx`, change `LogHeadEntry` to:

```ts
export type LogHeadEntry = {
  hasErrors?: boolean;
  primaryReason?: string;
  reasons?: LogDiagnostic[];
};
```

Remove `'codeUnit'` from the `preferred` flex column list so it is:

```ts
    const preferred: LogsColumnKey[] = [
      'operation',
      'match',
      'application',
      'user',
      'time',
      'status',
      'duration',
      'size'
    ];
```

In `packages/webview/src/components/table/LogRow.tsx`, remove `logHead[r.Id]?.codeUnitStarted` from the `useLayoutEffect` dependency list and delete the `case 'codeUnit'` branch.

- [ ] **Step 6: Remove Code Unit state, sorting, filtering, and metadata search**

In `packages/webview/src/main.tsx`, change `LogsUiState` to:

```ts
interface LogsUiState {
  query: string;
  filterUser: string;
  filterOperation: string;
  filterStatus: string;
  errorsOnly: boolean;
  sortBy: SortKey;
  sortDir: 'asc' | 'desc';
}
```

In `readInitialUiState`, remove `filterCodeUnit` and remove `sortBy === 'codeUnit'` from the allowed sort keys.

In the `logHead` message case, stop storing `codeUnitStarted`:

```ts
        case 'logHead':
          setLogHead(prev => ({
            ...prev,
            [msg.logId]: {
              ...prev[msg.logId],
              ...(msg.hasErrors !== undefined ? { hasErrors: msg.hasErrors } : {}),
              ...(msg.primaryReason !== undefined ? { primaryReason: msg.primaryReason } : {}),
              ...(msg.reasons !== undefined ? { reasons: msg.reasons } : {})
            }
          }));
          break;
```

Remove `filterCodeUnit` state and setter. Save webview state without `filterCodeUnit`:

```ts
    vscode.setState({
      query,
      filterUser,
      filterOperation,
      filterStatus,
      errorsOnly,
      sortBy,
      sortDir
    } satisfies LogsUiState);
```

Emit filter telemetry with deprecated `hasCodeUnit: false`:

```ts
    const activeCount = [hasUser, hasOperation, hasStatus, errorsOnly].filter(Boolean).length;

    vscode.postMessage({
      type: 'trackLogsFilter',
      outcome: activeCount === 0 ? 'cleared' : 'changed',
      hasUser,
      hasOperation,
      hasStatus,
      hasCodeUnit: false,
      errorsOnly,
      activeCount
    });
```

Remove `codeUnits`, Code Unit filter checks, Code Unit metadata haystack entry, and `case 'codeUnit'` from sorting. Remove `codeUnits`, `filterCodeUnit`, and `onFilterCodeUnitChange` props passed to `Toolbar`.

- [ ] **Step 7: Run focused webview tests and verify they pass**

Run:

```bash
npm run test:webview -- --runTestsByPath packages/webview/src/__tests__/LogsTable.test.tsx packages/webview/src/__tests__/Toolbar.test.tsx packages/webview/src/__tests__/ColumnsPopover.test.tsx packages/webview/src/__tests__/LogRow.test.tsx packages/webview/src/__tests__/LogsHeader.test.tsx packages/webview/src/__tests__/logsColumns.test.ts packages/webview/src/__tests__/logsApp.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/webview/src/utils/logsColumns.ts packages/webview/src/i18n.ts packages/webview/src/components/Toolbar.tsx packages/webview/src/components/LogsTable.tsx packages/webview/src/components/table/LogRow.tsx packages/webview/src/main.tsx packages/webview/src/__tests__/Toolbar.test.tsx packages/webview/src/__tests__/ColumnsPopover.test.tsx packages/webview/src/__tests__/LogsTable.test.tsx packages/webview/src/__tests__/LogRow.test.tsx packages/webview/src/__tests__/LogsHeader.test.tsx packages/webview/src/__tests__/logsColumns.test.ts packages/webview/src/__tests__/logsApp.test.tsx
git commit -m "fix(logs): remove code unit webview controls"
```

---

## Task 3: Provider and Service Hydration Removal

**Files:**
- Modify: `apps/vscode-extension/src/provider/SfLogsViewProvider.ts`
- Modify: `src/services/logService.ts`
- Modify: `src/salesforce/http.ts`
- Modify: `apps/vscode-extension/src/test/provider.logs.behavior.test.ts`
- Modify: `apps/vscode-extension/src/test/logService.test.ts`
- Delete: `apps/vscode-extension/src/test/extractCodeUnit.test.ts`

- [ ] **Step 1: Write/update failing provider tests**

In `apps/vscode-extension/src/test/provider.logs.behavior.test.ts`, replace the test named `refresh posts logs and logHead with code unit` with:

```ts
  test('refresh posts logs without code unit logHead hydration', async () => {
    const { SfLogsViewProvider, cli } = createProviderHarness();
    cli.getOrgAuth = async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' });
    cli.logsList = async () => [
      { Id: '07L000000000001AA', LogLength: 10 },
      { Id: '07L000000000002AA', LogLength: 20 }
    ];

    const context = makeContext();
    const posted: any[] = [];
    const provider = new SfLogsViewProvider(context);
    let loadLogHeadsCalled = false;
    (provider as any).logService.loadLogHeads = () => {
      loadLogHeadsCalled = true;
      throw new Error('loadLogHeads should not be called');
    };
    (provider as any).view = {
      webview: {
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        }
      }
    } as any;

    await provider.refresh();
    await new Promise(resolve => setTimeout(resolve, 0));

    const init = posted.find(m => m?.type === 'init');
    const logs = posted.find(m => m?.type === 'logs');
    assert.ok(init, 'should post init');
    assert.ok(logs, 'should post logs');
    assert.equal((logs?.data || []).length, 2, 'should include two logs');
    assert.equal(loadLogHeadsCalled, false, 'should not run code unit hydration');
    assert.equal(posted.some(m => typeof m?.codeUnitStarted === 'string'), false);
  });
```

In the `loadMore appends logs` test, change the `loadLogHeads` override to:

```ts
    let loadLogHeadsCalled = false;
    (provider as any).logService.loadLogHeads = () => {
      loadLogHeadsCalled = true;
      throw new Error('loadLogHeads should not be called');
    };
```

and add this assertion after `assert.equal(append.data[0]?.Id, '2');`:

```ts
    assert.equal(loadLogHeadsCalled, false, 'loadMore should not run code unit hydration');
```

- [ ] **Step 2: Run provider tests and verify failure**

Run:

```bash
npm run pretest
node scripts/run-tests-cli.js --scope=unit
```

Expected: FAIL because `startAuthHydration` still calls `loadLogHeads`.

- [ ] **Step 3: Stop provider Code Unit hydration while keeping auth warnings**

In `apps/vscode-extension/src/provider/SfLogsViewProvider.ts`, replace `startAuthHydration` with:

```ts
  private startAuthWarningHydration(
    authPromise: Promise<OrgAuth>,
    refreshToken: number,
    signal?: AbortSignal
  ): void {
    void authPromise
      .then(auth => {
        if (signal?.aborted || refreshToken !== this.refreshToken || this.disposed) {
          return;
        }
        const warning = getApiVersionFallbackWarning(auth);
        if (warning) {
          this.post({ type: 'warning', message: warning });
        }
      })
      .catch(e => {
        if (!signal?.aborted && refreshToken === this.refreshToken && !this.disposed) {
          logWarn('Logs: auth hydration failed ->', getErrorMessage(e));
        }
      });
  }
```

Also change `LogHeadSnapshot` to:

```ts
interface LogHeadSnapshot {
  hasErrors?: boolean;
  primaryReason?: string;
  reasons?: LogDiagnostic[];
}
```

Update the refresh call site from:

```ts
          this.startAuthHydration(logs, authPromise, token, selectedOrg, controller.signal);
```

to:

```ts
          this.startAuthWarningHydration(authPromise, token, controller.signal);
```

Update the load-more call site from:

```ts
      this.startAuthHydration(logs, authPromise, token, selectedOrg);
```

to:

```ts
      this.startAuthWarningHydration(authPromise, token);
```

In error triage posting and replay caching, remove `codeUnitStarted` from provider-owned `logHead` snapshots:

```ts
              this.post({
                type: 'logHead',
                logId: entry.logId,
                hasErrors: summary.hasErrors,
                primaryReason: summary.primaryReason,
                reasons: summary.reasons
              });
```

and:

```ts
          {
            type: 'logHead',
            logId,
            ...(snapshot.hasErrors !== undefined ? { hasErrors: snapshot.hasErrors } : {}),
            ...(snapshot.primaryReason !== undefined ? { primaryReason: snapshot.primaryReason } : {}),
            ...(snapshot.reasons !== undefined ? { reasons: snapshot.reasons } : {})
          },
```

and:

```ts
        this.logHeadByLogId.set(msg.logId, {
          ...previous,
          ...(msg.hasErrors !== undefined ? { hasErrors: msg.hasErrors } : {}),
          ...(msg.primaryReason !== undefined ? { primaryReason: msg.primaryReason } : {}),
          ...(msg.reasons !== undefined ? { reasons: msg.reasons } : {})
        });
```

Keep `codeUnitStarted` in the shared message type for external compatibility; the provider no longer produces or stores it.

- [ ] **Step 4: Remove Code Unit-only service helpers**

In `src/services/logService.ts`, change the import:

```ts
import { fetchApexLogBody } from '../salesforce/http';
```

Remove the `headLimiter` property and initializer:

```ts
  private headConcurrency: number;
```

and remove these lines:

```ts
  private headLimiter: Limiter;
```

```ts
    this.headLimiter = createLimiter(this.headConcurrency);
```

```ts
      this.headLimiter = createLimiter(this.headConcurrency);
```

Delete the full `loadLogHeads` method and the private `loadCodeUnitFromSavedLog` method.

In `src/salesforce/http.ts`, delete `extractCodeUnitStartedFromLines`.

In `apps/vscode-extension/src/test/logService.test.ts`, remove the three tests:

- `loadLogHeads skips uncached logs instead of downloading full bodies`
- `loadLogHeads reads code units from existing log files`
- `loadLogHeads scopes saved-log lookup by auth username`

Delete `apps/vscode-extension/src/test/extractCodeUnit.test.ts`.

- [ ] **Step 5: Run provider/service tests and verify they pass**

Run:

```bash
npm run pretest
node scripts/run-tests-cli.js --scope=unit
```

Expected: PASS.

- [ ] **Step 6: Check there are no active extension Code Unit hydration references**

Run:

```bash
rg -n "loadLogHeads|loadCodeUnitFromSavedLog|extractCodeUnitStartedFromLines|filterCodeUnit|case 'codeUnit'|case \"codeUnit\"|Code Unit" src apps/vscode-extension/src packages/webview/src --glob '!node_modules'
```

Expected: no matches for removed extension/webview behavior. Matches in `apps/vscode-extension/src/shared/messages.ts` for deprecated `codeUnitStarted` or `hasCodeUnit` are acceptable. Matches for `CODE_UNIT_*` log-content highlighting are acceptable.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/vscode-extension/src/provider/SfLogsViewProvider.ts src/services/logService.ts src/salesforce/http.ts apps/vscode-extension/src/test/provider.logs.behavior.test.ts apps/vscode-extension/src/test/logService.test.ts apps/vscode-extension/src/test/extractCodeUnit.test.ts
git commit -m "fix(logs): stop code unit hydration"
```

---

## Task 4: Docs, Generated Bundles, and Verification

**Files:**
- Modify: `apps/vscode-extension/README.md`
- Modify: `apps/vscode-extension/CHANGELOG.md`
- Modify generated files under `apps/vscode-extension/media/` as produced by the build.

- [ ] **Step 1: Update user-facing docs**

In `apps/vscode-extension/README.md`, change:

```md
- Combine search with filters by user, operation, status, code unit, and **Errors only**.
```

to:

```md
- Combine search with filters by user, operation, status, and **Errors only**.
```

In `apps/vscode-extension/CHANGELOG.md`, add this under `## Unreleased` > `### Bug Fixes`:

```md
- Logs: deprecate the Code Unit table column and filter, relying on local full-log search instead and avoiding the extra cached-log scan used to populate that column.
```

- [ ] **Step 2: Regenerate webview bundles**

Run:

```bash
npm run build:webview
```

Expected: PASS and generated updates under `apps/vscode-extension/media/` if those bundles are tracked.

- [ ] **Step 3: Run type checks**

Run:

```bash
npm run check-types
```

Expected: PASS.

- [ ] **Step 4: Run webview suite**

Run:

```bash
npm run test:webview
```

Expected: PASS.

- [ ] **Step 5: Run extension unit suites**

Run:

```bash
npm run test:extension:node
npm run pretest
node scripts/run-tests-cli.js --scope=unit
```

Expected: PASS.

- [ ] **Step 6: Inspect final Code Unit references**

Run:

```bash
rg -n "Code Unit|codeUnit|codeUnitStarted|CODE_UNIT" src apps/vscode-extension/src apps/vscode-extension/README.md packages/webview/src crates/alv-core/src packages/app-server-client-ts/src --glob '!node_modules'
```

Expected: remaining matches are limited to deprecated protocol/runtime compatibility (`codeUnitStarted` in shared/runtime contracts), log-body syntax highlighting or parsing for `CODE_UNIT_*`, and older docs/spec/changelog history outside the edited user-facing README path. There should be no `codeUnit` column key, webview Code Unit filter, Code Unit column renderer, or provider Code Unit hydration call.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/vscode-extension/README.md apps/vscode-extension/CHANGELOG.md apps/vscode-extension/media
git commit -m "docs(logs): document code unit deprecation"
```

---

## Final Verification

- [ ] **Step 1: Run full local verification required for this change**

Run:

```bash
npm run check-types
npm run test:webview
npm run test:extension:node
npm run pretest
node scripts/run-tests-cli.js --scope=unit
```

Expected: all commands PASS.

- [ ] **Step 2: Review git diff**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: working tree clean after the task commits, with commits for config, webview UI, hydration removal, and docs/generated bundles.

- [ ] **Step 3: Completion handoff**

Summarize:

- Code Unit column/filter/sort/search removed from the logs table UI.
- Persisted configs containing `codeUnit` are tolerated and normalized away.
- Provider no longer runs Code Unit cached-log hydration.
- Error triage `logHead` updates still work.
- Deprecated `codeUnitStarted` runtime/protocol fields remain for compatibility.
- Verification command results.
