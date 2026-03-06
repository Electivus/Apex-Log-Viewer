# DebugLevel Manager Implementation Plan

> **For Codex CLI:** REQUIRED SUB-SKILL: Use `$executing-plans` to implement this plan task-by-task.

**Goal:** Add full `DebugLevel` CRUD with presets and field-by-field editing to the existing Debug Flags panel, while preserving the current TraceFlag workflow.

**Architecture:** Extend the existing debug-level/trace-flag service layer in `src/salesforce/traceflags.ts`, expand the shared message/types contract, and add a second manager section to the existing webview. The webview will maintain a local draft model that can start empty or from a preset, then save/delete through the extension host and refresh the shared debug-level list.

**Tech Stack:** TypeScript, VS Code extension host, React webview, Tooling API, Mocha/Jest tests

---

### Task 1: Add shared DebugLevel manager types

**Files:**
- Modify: `src/shared/debugFlagsTypes.ts`
- Modify: `src/shared/debugFlagsMessages.ts`
- Test: `src/webview/__tests__/debugFlagsApp.test.tsx`

**Step 1: Write the failing test**

Update the webview test expectations so the Debug Flags app can receive richer debug-level payloads and manager bootstrap data.

**Step 2: Run test to verify it fails**

Run: `npm run test:webview -- --runTestsByPath src/webview/__tests__/debugFlagsApp.test.tsx`

Expected: FAIL because the message/types contract does not support the new manager payloads yet.

**Step 3: Write minimal implementation**

Add:

- typed `DebugLevelRecord`
- typed `DebugLevelPreset`
- allowed field-level union
- new manager-related inbound/outbound message variants

**Step 4: Run test to verify it passes**

Run: `npm run test:webview -- --runTestsByPath src/webview/__tests__/debugFlagsApp.test.tsx`

Expected: PASS or advance to the next missing contract error.

### Task 2: Add failing backend tests for DebugLevel CRUD

**Files:**
- Modify: `src/test/traceflags.userFlags.test.ts`
- Modify: `src/test/listDebugLevels.test.ts`
- Modify: `src/salesforce/traceflags.ts`

**Step 1: Write the failing test**

Add focused Mocha tests for:

- listing detailed `DebugLevel` records,
- creating a `DebugLevel`,
- updating a `DebugLevel`,
- deleting a `DebugLevel`,
- cache invalidation after mutations.

**Step 2: Run test to verify it fails**

Run: `npm run pretest && bash scripts/run-tests.sh --scope=unit --grep "traceflags user management|listDebugLevels"`

Expected: FAIL because the new functions do not exist or do not produce the required requests yet.

**Step 3: Write minimal implementation**

In `src/salesforce/traceflags.ts`, implement:

- `listDebugLevelDetails(...)`
- `createDebugLevel(...)`
- `updateDebugLevel(...)`
- `deleteDebugLevel(...)`
- mapping/payload helpers
- debug-level cache invalidation helper

**Step 4: Run test to verify it passes**

Run: `npm run pretest && bash scripts/run-tests.sh --scope=unit --grep "traceflags user management|listDebugLevels"`

Expected: PASS.

### Task 3: Add presets and default draft helpers

**Files:**
- Modify: `src/shared/debugFlagsTypes.ts`
- Create or modify: `src/shared/debugLevelPresets.ts`
- Test: `src/test/traceflags.userFlags.test.ts`

**Step 1: Write the failing test**

Add tests that assert preset definitions and empty-draft defaults cover all supported editable fields.

**Step 2: Run test to verify it fails**

Run: `npm run pretest && bash scripts/run-tests.sh --scope=unit --grep "debug level preset|debug level draft"`

Expected: FAIL because presets/default helpers do not exist yet.

**Step 3: Write minimal implementation**

Add:

- typed preset definitions,
- empty draft helper,
- reusable field order/constants for the UI.

**Step 4: Run test to verify it passes**

Run: `npm run pretest && bash scripts/run-tests.sh --scope=unit --grep "debug level preset|debug level draft"`

Expected: PASS.

### Task 4: Add panel tests for manager message flow

**Files:**
- Modify: `src/test/provider.webview.test.ts` or add a focused panel test file if needed
- Modify: `src/panel/DebugFlagsPanel.ts`

**Step 1: Write the failing test**

Add tests that prove:

- bootstrap sends manager records and presets,
- save refreshes the list,
- delete refreshes the list,
- applying panel actions posts the right notices/errors.

**Step 2: Run test to verify it fails**

Run: `npm run pretest && bash scripts/run-tests.sh --scope=unit --grep "DebugFlagsPanel"`

Expected: FAIL because the panel does not handle manager messages yet.

**Step 3: Write minimal implementation**

Extend `DebugFlagsPanel` message handling and bootstrap logic to support the manager flow.

**Step 4: Run test to verify it passes**

Run: `npm run pretest && bash scripts/run-tests.sh --scope=unit --grep "DebugFlagsPanel"`

Expected: PASS.

### Task 5: Add failing webview tests for draft editing and presets

**Files:**
- Modify: `src/webview/__tests__/debugFlagsApp.test.tsx`
- Modify: `src/webview/debugFlags.tsx`
- Modify: `src/webview/i18n.ts`

**Step 1: Write the failing test**

Add webview tests for:

- loading a detailed manager item,
- switching to `New`,
- applying a preset to the draft,
- editing individual fields,
- saving and deleting through posted messages,
- reset behavior.

**Step 2: Run test to verify it fails**

Run: `npm run test:webview -- --runTestsByPath src/webview/__tests__/debugFlagsApp.test.tsx`

Expected: FAIL because the current UI lacks manager controls and draft state.

**Step 3: Write minimal implementation**

Update the Debug Flags webview to render the manager section and wire the draft interactions.

**Step 4: Run test to verify it passes**

Run: `npm run test:webview -- --runTestsByPath src/webview/__tests__/debugFlagsApp.test.tsx`

Expected: PASS.

### Task 6: Update i18n and polish user-facing copy

**Files:**
- Modify: `src/webview/i18n.ts`
- Modify: `src/panel/DebugFlagsPanel.ts`
- Test: `src/test/i18n.test.ts`

**Step 1: Write the failing test**

Add or update tests to cover the new strings needed by the manager section.

**Step 2: Run test to verify it fails**

Run: `npm run pretest && bash scripts/run-tests.sh --scope=unit --grep "i18n"`

Expected: FAIL because the new keys are missing.

**Step 3: Write minimal implementation**

Add concise `en` and `pt-BR` copy for labels, notices, confirmations, and errors.

**Step 4: Run test to verify it passes**

Run: `npm run pretest && bash scripts/run-tests.sh --scope=unit --grep "i18n"`

Expected: PASS.

### Task 7: Run focused verification

**Files:**
- Modify: any touched source/test files from previous tasks

**Step 1: Run focused tests**

Run:

- `npm run test:webview -- --runTestsByPath src/webview/__tests__/debugFlagsApp.test.tsx`
- `npm run pretest && bash scripts/run-tests.sh --scope=unit --grep "traceflags user management|DebugFlagsPanel|listDebugLevels|i18n"`

Expected: PASS.

**Step 2: Fix any regressions**

Apply the smallest changes needed until the focused suite is green.

**Step 3: Run broader confidence checks**

Run:

- `npm run lint`
- `npm run build`

Expected: PASS.

### Task 8: Summarize outcomes

**Files:**
- Review touched files only

**Step 1: Inspect final diff**

Run: `git diff -- src/salesforce/traceflags.ts src/panel/DebugFlagsPanel.ts src/shared/debugFlagsTypes.ts src/shared/debugFlagsMessages.ts src/shared/debugLevelPresets.ts src/webview/debugFlags.tsx src/webview/i18n.ts src/test/traceflags.userFlags.test.ts src/webview/__tests__/debugFlagsApp.test.tsx`

Expected: Diff matches the approved design and keeps the existing TraceFlag flow intact.

**Step 2: Report verification evidence**

Include the exact commands run and any remaining gaps, if any.
