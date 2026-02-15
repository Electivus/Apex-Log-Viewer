# Logs Panel Column Customization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users configure which columns are visible in the Electivus Apex Logs panel, including toggle visibility, reorder, and resize, persisted to VS Code **User** settings.

**Architecture:** Store a `logsColumns` config object in VS Code settings (`electivus.apexLogs.logsColumns`) and sync it to/from the Logs webview via webview messaging. The webview is responsible for rendering a dynamic CSS Grid table based on column order/visibility/widths and providing a Radix Popover UI with `dnd-kit` reorder + header drag-resizers.

**Tech Stack:** VS Code extension host (TypeScript), Webview (React + Tailwind), webview messaging, Jest (webview tests), Mocha (@vscode/test-electron) extension tests, Radix UI, dnd-kit.

---

## Column Model (reference)

**Data column keys:**

- `user`
- `application`
- `operation`
- `time`
- `duration`
- `status`
- `codeUnit`
- `size`
- `match`

**Non-configurable column:**

- `actions` (always present, always last)

**Default order:** current UI order: `user, application, operation, time, duration, status, codeUnit, size, match`

**Match gating rule:** `match` can only be shown when `fullLogSearchEnabled === true`. If disabled, the toggle is disabled but the preference is preserved.

---

### Task 1: Add shared column config types + normalization

**Files:**
- Create: `apps/vscode-extension/src/shared/logsColumns.ts`
- Test: `apps/vscode-extension/src/test/logsColumnsConfig.test.ts`

**Step 1: Write failing test for normalization**

Create `apps/vscode-extension/src/test/logsColumnsConfig.test.ts`:

```ts
import assert from 'assert/strict';
import { normalizeLogsColumnsConfig, DEFAULT_LOGS_COLUMNS_CONFIG } from '../shared/logsColumns';

suite('logsColumns config', () => {
  test('normalizes invalid values to defaults', () => {
    const cfg = normalizeLogsColumnsConfig(undefined);
    assert.deepEqual(cfg.order, DEFAULT_LOGS_COLUMNS_CONFIG.order);
  });

  test('filters unknown keys and appends missing keys', () => {
    const cfg = normalizeLogsColumnsConfig({ order: ['time', 'nope', 'user'] });
    assert.equal(cfg.order[0], 'time');
    assert.ok(cfg.order.includes('application'));
  });

  test('clamps widths and ignores invalid', () => {
    const cfg = normalizeLogsColumnsConfig({ widths: { user: -5, time: 123 } });
    assert.ok(cfg.widths.time === 123);
    assert.ok(cfg.widths.user === undefined);
  });
});
```

**Step 2: Run extension unit tests to see failure**

Run: `npm --prefix apps/vscode-extension run compile-tests`

Run: `KEEP_VSCODE_TEST_CACHE=1 bash apps/vscode-extension/scripts/run-tests.sh --scope=unit`

Expected: FAIL because `../shared/logsColumns` doesn’t exist yet.

**Step 3: Implement shared model + normalization**

Create `apps/vscode-extension/src/shared/logsColumns.ts` with:

```ts
export type LogsColumnKey =
  | 'user'
  | 'application'
  | 'operation'
  | 'time'
  | 'duration'
  | 'status'
  | 'codeUnit'
  | 'size'
  | 'match';

export type LogsColumnsConfig = {
  order?: LogsColumnKey[];
  visibility?: Partial<Record<LogsColumnKey, boolean>>;
  widths?: Partial<Record<LogsColumnKey, number>>;
};

export type NormalizedLogsColumnsConfig = {
  order: LogsColumnKey[];
  visibility: Record<LogsColumnKey, boolean>;
  widths: Partial<Record<LogsColumnKey, number>>;
};

export const DEFAULT_LOGS_COLUMN_ORDER: LogsColumnKey[] = [
  'user',
  'application',
  'operation',
  'time',
  'duration',
  'status',
  'codeUnit',
  'size',
  'match'
];

export const DEFAULT_LOGS_COLUMNS_CONFIG: NormalizedLogsColumnsConfig = {
  order: DEFAULT_LOGS_COLUMN_ORDER,
  visibility: Object.fromEntries(DEFAULT_LOGS_COLUMN_ORDER.map(k => [k, true])) as Record<LogsColumnKey, boolean>,
  widths: {}
};

const KEY_SET = new Set<LogsColumnKey>(DEFAULT_LOGS_COLUMN_ORDER);

export function normalizeLogsColumnsConfig(raw: unknown): NormalizedLogsColumnsConfig {
  const input = (raw && typeof raw === 'object' ? (raw as any) : {}) as LogsColumnsConfig;
  const orderRaw = Array.isArray(input.order) ? input.order : [];
  const orderFiltered = orderRaw.filter((k): k is LogsColumnKey => typeof k === 'string' && KEY_SET.has(k as LogsColumnKey));
  const order = [...new Set([...orderFiltered, ...DEFAULT_LOGS_COLUMN_ORDER])] as LogsColumnKey[];

  const visibilityIn = input.visibility && typeof input.visibility === 'object' ? (input.visibility as any) : {};
  const visibility = Object.fromEntries(order.map(k => [k, visibilityIn[k] === false ? false : true])) as Record<
    LogsColumnKey,
    boolean
  >;

  const widthsIn = input.widths && typeof input.widths === 'object' ? (input.widths as any) : {};
  const widths: Partial<Record<LogsColumnKey, number>> = {};
  for (const k of order) {
    const v = widthsIn[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      widths[k] = Math.floor(v);
    }
  }

  return { order, visibility, widths };
}
```

**Step 4: Run extension unit tests**

Run: `npm --prefix apps/vscode-extension run compile-tests`

Run: `KEEP_VSCODE_TEST_CACHE=1 bash apps/vscode-extension/scripts/run-tests.sh --scope=unit`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/vscode-extension/src/shared/logsColumns.ts apps/vscode-extension/src/test/logsColumnsConfig.test.ts
git commit -m "feat(logs): add columns config model"
```

---

### Task 2: Add the VS Code setting schema for `electivus.apexLogs.logsColumns`

**Files:**
- Modify: `apps/vscode-extension/package.json`
- Modify: `docs/SETTINGS.md`

**Step 1: Add configuration contribution**

Update `apps/vscode-extension/package.json` to include:

- Key: `electivus.apexLogs.logsColumns`
- Type: `object`
- Default: `{ order: [...], visibility: {...}, widths: {} }`
- Description: “Persisted column layout for Logs table (managed by UI).”

**Step 2: Document setting**

Update `docs/SETTINGS.md` with a new section describing:

- what it does
- that it is managed by the Logs panel UI
- where it’s stored (User settings)

**Step 3: Verify JSON validity**

Run: `node -c apps/vscode-extension/package.json`

Expected: exit code 0 (no output).

**Step 4: Commit**

```bash
git add apps/vscode-extension/package.json docs/SETTINGS.md
git commit -m "feat(logs): add logsColumns setting"
```

---

### Task 3: Wire extension ↔ webview messages for column config

**Files:**
- Modify: `apps/vscode-extension/src/shared/messages.ts`
- Modify: `apps/vscode-extension/src/provider/logsMessageHandler.ts`
- Modify: `apps/vscode-extension/src/provider/SfLogsViewProvider.ts`
- Modify: `apps/vscode-extension/src/utils/configManager.ts` (optional; if used to read config)

**Step 1: Extend shared messages**

In `apps/vscode-extension/src/shared/messages.ts`:

- Add Webview → Extension:

```ts
| { type: 'setLogsColumns'; value: import('./logsColumns').LogsColumnsConfig }
```

- Extend Extension → Webview `init` payload to include normalized config:

```ts
| { type: 'init'; locale: string; fullLogSearchEnabled?: boolean; logsColumns?: import('./logsColumns').NormalizedLogsColumnsConfig }
```

- Add a live update message (so changes apply without refresh):

```ts
| { type: 'logsColumns'; value: import('./logsColumns').NormalizedLogsColumnsConfig }
```

**Step 2: Provider sends config on init + settings changes**

In `apps/vscode-extension/src/provider/SfLogsViewProvider.ts`:

- When posting `init`, include `logsColumns: normalizeLogsColumnsConfig(getConfig(...))`
- In `onDidChangeConfiguration` handler:
  - If `affectsConfiguration(e, 'electivus.apexLogs.logsColumns')`, post `{ type: 'logsColumns', value: normalized }`

**Step 3: Provider persists webview updates**

Add a method on provider:

```ts
public async setLogsColumnsConfig(value: LogsColumnsConfig): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();
  await cfg.update('electivus.apexLogs.logsColumns', value, vscode.ConfigurationTarget.Global);
  this.post({ type: 'logsColumns', value: normalizeLogsColumnsConfig(value) });
}
```

**Step 4: Handle new message**

In `apps/vscode-extension/src/provider/logsMessageHandler.ts`:

- Add a constructor callback `setLogsColumns: (value: LogsColumnsConfig) => Promise<void>`
- Handle `message.type === 'setLogsColumns'`

**Step 5: Commit**

```bash
git add apps/vscode-extension/src/shared/messages.ts apps/vscode-extension/src/provider/logsMessageHandler.ts apps/vscode-extension/src/provider/SfLogsViewProvider.ts
git commit -m "feat(logs): sync columns config via webview messages"
```

---

### Task 4: Store columns config in Logs webview state and pass into table

**Files:**
- Modify: `apps/vscode-extension/src/webview/main.tsx`
- Modify: `apps/vscode-extension/src/webview/components/Toolbar.tsx`
- Modify: `apps/vscode-extension/src/webview/components/LogsTable.tsx`
- Modify: `apps/vscode-extension/src/webview/components/table/LogsHeader.tsx`
- Modify: `apps/vscode-extension/src/webview/components/table/LogRow.tsx`

**Step 1: Add webview state + message handling**

In `apps/vscode-extension/src/webview/main.tsx`:

- Add `const [logsColumns, setLogsColumns] = useState<NormalizedLogsColumnsConfig>(DEFAULT_LOGS_COLUMNS_CONFIG)`
- In message handler:
  - On `init`, read `msg.logsColumns` into state
  - On `logsColumns`, update state
- Add a helper `persistLogsColumns(next: NormalizedLogsColumnsConfig)` that:
  - updates state
  - posts `{ type: 'setLogsColumns', value: next }` (or the minimal config object)

**Step 2: Thread config into Toolbar + LogsTable**

- Add a new toolbar prop for opening the Columns popover (placeholder until Task 5)
- Add `logsColumns` and `onLogsColumnsChange` props into `LogsTable`

**Step 3: Commit**

```bash
git add apps/vscode-extension/src/webview/main.tsx apps/vscode-extension/src/webview/components/Toolbar.tsx apps/vscode-extension/src/webview/components/LogsTable.tsx apps/vscode-extension/src/webview/components/table/LogsHeader.tsx apps/vscode-extension/src/webview/components/table/LogRow.tsx
git commit -m "feat(logs): plumb columns config into webview"
```

---

### Task 5: Implement Columns popover UI (visibility + reorder + reset)

**Dependencies:**
- Add: `@radix-ui/react-popover`
- Add: `@dnd-kit/core`
- Add: `@dnd-kit/sortable`
- Add: `@dnd-kit/utilities`

**Files:**
- Modify: `apps/vscode-extension/package.json`
- Modify: `package-lock.json`
- Create: `apps/vscode-extension/src/webview/components/ColumnsPopover.tsx`
- Modify: `apps/vscode-extension/src/webview/components/Toolbar.tsx`
- Modify: `apps/vscode-extension/src/webview/i18n.ts`

**Step 1: Add dependencies**

Run:

```bash
npm --prefix apps/vscode-extension install @radix-ui/react-popover @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

Expected: package-lock updates.

**Step 2: Create `ColumnsPopover`**

Implement a popover with:

- Trigger button text: `t.columnsMenu?.button ?? 'Columns'`
- List items in current `logsColumns.order`
- Per item:
  - drag handle (lucide `GripVertical` or similar)
  - label
  - `Switch` for visibility
- Reset button: restores `DEFAULT_LOGS_COLUMNS_CONFIG`
- Disable Match toggle if `fullLogSearchEnabled === false`

**Step 3: Hook into `Toolbar`**

Add the Columns button next to “Clear filters”.

**Step 4: Add i18n keys**

In `apps/vscode-extension/src/webview/i18n.ts`, add:

```ts
columnsMenu?: {
  button: string;
  title: string;
  reset: string;
};
```

**Step 5: Webview tests (minimal)**

Add/extend `apps/vscode-extension/src/webview/__tests__/Toolbar.test.tsx` to verify:

- The Columns button renders
- Clicking opens popover content

**Step 6: Commit**

```bash
git add apps/vscode-extension/package.json package-lock.json apps/vscode-extension/src/webview/components/ColumnsPopover.tsx apps/vscode-extension/src/webview/components/Toolbar.tsx apps/vscode-extension/src/webview/i18n.ts apps/vscode-extension/src/webview/__tests__/Toolbar.test.tsx
git commit -m "feat(logs): add columns popover UI"
```

---

### Task 6: Refactor Logs table rendering to use dynamic ordered/visible columns

**Files:**
- Create: `apps/vscode-extension/src/webview/utils/logsColumns.ts`
- Modify: `apps/vscode-extension/src/webview/components/LogsTable.tsx`
- Modify: `apps/vscode-extension/src/webview/components/table/LogsHeader.tsx`
- Modify: `apps/vscode-extension/src/webview/components/table/LogRow.tsx`
- Test: `apps/vscode-extension/src/webview/__tests__/LogsTable.test.tsx`

**Step 1: Add column definitions**

In `apps/vscode-extension/src/webview/utils/logsColumns.ts`, define:

- `COLUMN_DEFS` map `LogsColumnKey -> { minPx, defaultTrack, labelKey, sortableKey? }`
- helper `getEffectiveVisibleOrder(config, fullLogSearchEnabled)`:
  - filter to keys where `config.visibility[key] !== false`
  - if key is `match` and `fullLogSearchEnabled === false`, exclude

**Step 2: Build `gridTemplateColumns` dynamically**

In `LogsTable.tsx`, replace the hard-coded columns list with:

- `visibleOrder = getEffectiveVisibleOrder(logsColumns, fullLogSearchEnabled)`
- For each key:
  - if `logsColumns.widths[key]` exists -> `minmax(${minPx}px, ${width}px)`
  - else -> `defaultTrack`
- Append actions track: `'96px'`

**Step 3: Render header + row cells from the same list**

- Update `LogsHeader` props to accept `visibleOrder` and render cells via mapping.
- Update `LogRow` to accept `visibleOrder` and render the same sequence of cells.

**Step 4: Update webview tests**

Extend `LogsTable.test.tsx`:

- “hides columns when visibility false”
- “does not show match when full log search disabled even if enabled in config”
- “respects order when provided”

**Step 5: Commit**

```bash
git add apps/vscode-extension/src/webview/utils/logsColumns.ts apps/vscode-extension/src/webview/components/LogsTable.tsx apps/vscode-extension/src/webview/components/table/LogsHeader.tsx apps/vscode-extension/src/webview/components/table/LogRow.tsx apps/vscode-extension/src/webview/__tests__/LogsTable.test.tsx
git commit -m "feat(logs): render logs table from configurable columns"
```

---

### Task 7: Add drag-to-resize handles in the sticky header and persist widths

**Files:**
- Modify: `apps/vscode-extension/src/webview/components/table/LogsHeader.tsx`
- Modify: `apps/vscode-extension/src/webview/main.tsx`
- Test: `apps/vscode-extension/src/webview/__tests__/LogsHeader.test.tsx`

**Step 1: Add resizer handle UI per column**

In `LogsHeader.tsx`:

- Render a small `div` at right edge of each header cell:
  - class: `absolute right-0 top-0 h-full w-2 cursor-col-resize`
  - onPointerDown starts resize for that column key

**Step 2: Resize state + handlers in `LogsApp`**

In `main.tsx`:

- Implement `onResizeColumn(key, nextWidthPx)` to update `logsColumns.widths[key]`
- Persist to extension on pointer-up:
  - easiest: handler returns a “commit” callback called at pointer-up

**Step 3: Add test for resize callback**

In `LogsHeader.test.tsx`, simulate:

- render header with one visible column
- pointerDown on resizer
- pointerMove
- pointerUp
- assert `onColumnWidthChange` called with expected key + width

**Step 4: Commit**

```bash
git add apps/vscode-extension/src/webview/components/table/LogsHeader.tsx apps/vscode-extension/src/webview/main.tsx apps/vscode-extension/src/webview/__tests__/LogsHeader.test.tsx
git commit -m "feat(logs): add column resize handles"
```

---

### Task 8: Final verification and packaging sanity

**Step 1: Webview tests**

Run: `npm --prefix apps/vscode-extension run test:webview`

Expected: PASS.

**Step 2: Extension unit tests**

Run: `npm --prefix apps/vscode-extension run compile-tests`

Run: `KEEP_VSCODE_TEST_CACHE=1 bash apps/vscode-extension/scripts/run-tests.sh --scope=unit`

Expected: PASS (exit code 0).

**Step 3: Build**

Run: `npm run ext:build`

Expected: builds `apps/vscode-extension/dist/extension.js` and `media/*.js` without errors.

**Step 4: Manual smoke (optional)**

- `F5` → open Extension Development Host
- Open “Electivus Apex Logs”
- Use Columns popover: toggle + reorder + resize
- Reload window; confirm settings persisted

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(logs): configurable columns in logs panel"
```

