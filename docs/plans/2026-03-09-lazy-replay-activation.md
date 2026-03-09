# Lazy Replay Activation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the Apex Replay Debugger as a hard startup dependency while preserving replay support through lazy runtime activation.

**Architecture:** The manifest stops declaring Replay Debugger as an `extensionDependencies` requirement. Replay actions continue to flow through `ensureReplayDebuggerAvailable()`, which remains responsible for runtime detection, on-demand activation, and user guidance when Replay Debugger is unavailable.

**Tech Stack:** VS Code extension manifest, TypeScript, Mocha integration/unit tests, repository docs.

---

### Task 1: Lock the startup contract with a failing manifest test

**Files:**
- Create: `src/test/packageManifest.test.ts`
- Modify: `package.json`

**Step 1: Write the failing test**

```ts
test('does not require Apex Replay Debugger as an extension dependency', async () => {
  const raw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
  const json = JSON.parse(raw) as { extensionDependencies?: string[] };
  assert.ok(!json.extensionDependencies?.includes('salesforce.salesforcedx-vscode-apex-replay-debugger'));
});
```

**Step 2: Run test to verify it fails**

Run: `fnm exec --using=22 npm run pretest && fnm exec --using=22 npx mocha --ui tdd out/test/packageManifest.test.js`

Expected: FAIL because `package.json#extensionDependencies` still includes the Replay Debugger id.

**Step 3: Write minimal implementation**

Remove `salesforce.salesforcedx-vscode-apex-replay-debugger` from `package.json#extensionDependencies`.

**Step 4: Run test to verify it passes**

Run: `fnm exec --using=22 npm run pretest && fnm exec --using=22 npx mocha --ui tdd out/test/packageManifest.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/test/packageManifest.test.ts package.json
git commit -m "fix(activation): remove replay debugger startup dependency"
```

### Task 2: Update test expectations around optional replay support

**Files:**
- Modify: `src/test/integration.dependencies.test.ts`
- Modify: `test/e2e/utils/vscode.ts`

**Step 1: Write the failing test**

Adjust the integration dependency test to assert that the extension is discoverable and activatable without requiring Replay Debugger to be installed. Keep replay-specific environments free to install Salesforce extensions explicitly.

**Step 2: Run test to verify it fails**

Run: `fnm exec --using=22 npm run pretest && fnm exec --using=22 bash scripts/run-tests.sh --scope=integration`

Expected: Existing dependency assertion fails or the old wording no longer matches the desired optional dependency contract.

**Step 3: Write minimal implementation**

- Replace the hard dependency assertion in `src/test/integration.dependencies.test.ts` with an activation-oriented check.
- Update the E2E helper comment or dependency resolution wording in `test/e2e/utils/vscode.ts` so it no longer claims activation depends on manifest `extensionDependencies`.

**Step 4: Run test to verify it passes**

Run: `fnm exec --using=22 npm run pretest && fnm exec --using=22 bash scripts/run-tests.sh --scope=integration`

Expected: PASS for the updated integration contract.

**Step 5: Commit**

```bash
git add src/test/integration.dependencies.test.ts test/e2e/utils/vscode.ts
git commit -m "test(activation): treat replay debugger as optional at startup"
```

### Task 3: Refresh repository docs

**Files:**
- Modify: `docs/TESTING.md`

**Step 1: Write the failing test**

There is no automated doc test. Use the approved design as the contract: documentation must describe Replay Debugger as optional for extension activation and still relevant for replay-specific test runs.

**Step 2: Run test to verify it fails**

Review `docs/TESTING.md` and confirm it still states the runner installs Replay Debugger to satisfy a narrowed runtime dependency for startup.

Expected: Doc is outdated.

**Step 3: Write minimal implementation**

Update the testing guide to explain:

- integration runs still install Salesforce extensions by default to mirror a typical environment,
- replay-specific scenarios may still require Replay Debugger,
- base extension activation no longer depends on Replay Debugger being a manifest dependency.

**Step 4: Run test to verify it passes**

Review the doc for consistency with `package.json` and the integration tests.

Expected: Wording matches the implemented contract.

**Step 5: Commit**

```bash
git add docs/TESTING.md
git commit -m "docs(testing): clarify lazy replay debugger activation"
```

### Task 4: Verify the change end-to-end

**Files:**
- Modify: none

**Step 1: Run focused verification**

Run: `fnm exec --using=22 npm run pretest`

Expected: build and compiled tests succeed.

**Step 2: Run manifest test**

Run: `fnm exec --using=22 npx mocha --ui tdd out/test/packageManifest.test.js`

Expected: PASS.

**Step 3: Run relevant VS Code-hosted verification**

Run: `fnm exec --using=22 bash scripts/run-tests.sh --scope=integration`

Expected: PASS for the updated integration suite.

**Step 4: Run compile validation**

Run: `fnm exec --using=22 npm run compile`

Expected: exit code `0`.

**Step 5: Commit**

```bash
git status --short
```

Expected: only the intended files remain modified and ready for review.
