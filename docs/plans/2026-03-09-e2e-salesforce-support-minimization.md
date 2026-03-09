# E2E Salesforce Support Minimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Playwright E2E harness install only the Salesforce support extensions each scenario actually needs and remove notification-driven flakiness from the debug-flags flows.

**Architecture:** The shared VS Code launcher stops auto-installing the Salesforce Extension Pack. The base E2E fixture becomes minimal, replay-specific specs opt into Replay Debugger support, and a reusable notification helper dismisses visible toasts before sensitive toolbar clicks.

**Tech Stack:** TypeScript, Playwright, VS Code test-electron launcher helpers, Salesforce CLI-backed E2E utilities.

---

### Task 1: Lock the support-extension contract in the launcher

**Files:**
- Modify: `test/e2e/utils/vscode.ts`
- Test: `test/e2e/utils/vscode.test.ts`

**Step 1: Write the failing test**

Add a unit test that proves Salesforce-related support ids are not expanded to `salesforce.salesforcedx-vscode` and that extra extension ids stay scenario-scoped.

**Step 2: Run test to verify it fails**

Run: `fnm exec --using=22 npm run test:e2e:utils`

Expected: FAIL because the launcher still promotes Salesforce ids to the full extension pack.

**Step 3: Write minimal implementation**

Remove the Salesforce-pack expansion helper and keep the launcher limited to manifest references plus scenario-provided ids.

**Step 4: Run test to verify it passes**

Run: `fnm exec --using=22 npm run test:e2e:utils`

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/utils/vscode.ts test/e2e/utils/vscode.test.ts
git commit -m "test(e2e): stop installing the salesforce extension pack"
```

### Task 2: Make support extensions explicit per scenario

**Files:**
- Modify: `test/e2e/fixtures/alvE2E.ts`
- Modify: `test/e2e/specs/replayDebugger.e2e.spec.ts`
- Test: `test/e2e/specs/replayDebugger.e2e.spec.ts`

**Step 1: Write the failing test**

Adjust the replay spec to declare Replay Debugger support through fixture options or a helper API, then run it against the minimal fixture.

**Step 2: Run test to verify it fails**

Run: `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/replayDebugger.e2e.spec.ts --workers=1`

Expected: FAIL until the fixture can request Replay Debugger explicitly.

**Step 3: Write minimal implementation**

Add a fixture-level mechanism for scenario-specific `extensionIds`, default it to `[]`, and opt the replay spec into `salesforce.salesforcedx-vscode-apex-replay-debugger`.

**Step 4: Run test to verify it passes**

Run: `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/replayDebugger.e2e.spec.ts --workers=1`

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/fixtures/alvE2E.ts test/e2e/specs/replayDebugger.e2e.spec.ts
git commit -m "test(e2e): declare replay debugger support per scenario"
```

### Task 3: Harden the suite against VS Code notifications

**Files:**
- Create: `test/e2e/utils/notifications.ts`
- Modify: `test/e2e/specs/debugFlagsFilter.e2e.spec.ts`
- Modify: `test/e2e/specs/debugFlagsPanel.e2e.spec.ts`
- Modify: `test/e2e/specs/debugLevelManager.e2e.spec.ts`

**Step 1: Write the failing test**

Re-run the debug-flags specs to capture the notification-intercept failure in the minimal environment.

**Step 2: Run test to verify it fails**

Run: `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/debugFlagsFilter.e2e.spec.ts --workers=1`

Expected: FAIL with a click interception or equivalent readiness issue while notifications are visible.

**Step 3: Write minimal implementation**

Create a best-effort helper that dismisses visible notifications and call it after startup / before clicking debug-flags toolbar actions.

**Step 4: Run test to verify it passes**

Run:
- `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/debugFlagsFilter.e2e.spec.ts --workers=1`
- `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/debugFlagsPanel.e2e.spec.ts --workers=1`
- `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/debugLevelManager.e2e.spec.ts --workers=1`

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/utils/notifications.ts test/e2e/specs/debugFlagsFilter.e2e.spec.ts test/e2e/specs/debugFlagsPanel.e2e.spec.ts test/e2e/specs/debugLevelManager.e2e.spec.ts
git commit -m "test(e2e): dismiss intrusive vscode notifications"
```

### Task 4: Verify the full E2E suite

**Files:**
- Modify: none

**Step 1: Run focused support-suite verification**

Run:
- `fnm exec --using=22 npm run test:e2e:utils`
- `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/replayDebugger.e2e.spec.ts --workers=1`

Expected: PASS.

**Step 2: Run focused debug-flags verification**

Run:
- `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/debugFlagsFilter.e2e.spec.ts --workers=1`
- `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/debugFlagsPanel.e2e.spec.ts --workers=1`
- `fnm exec --using=22 node scripts/run-playwright-e2e.js test/e2e/specs/debugLevelManager.e2e.spec.ts --workers=1`

Expected: PASS.

**Step 3: Run the full suite**

Run: `fnm exec --using=22 npm run test:e2e`

Expected: PASS.

**Step 4: Review working tree**

Run: `git status --short`

Expected: only the intended E2E harness/spec/doc files are modified.
