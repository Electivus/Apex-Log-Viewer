# E2E Observability Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scratch-org E2E failures easier to diagnose by improving safe Salesforce CLI error messages and bounding the slow debug-flags panel waits.

**Architecture:** Keep all changes inside E2E-only code. `test/e2e/utils/sfCli.ts` owns safe command failure formatting; `test/e2e/specs/debugFlagsPanel.e2e.spec.ts` owns panel readiness assertions for this scenario.

**Tech Stack:** TypeScript, Jest with `jest.config.e2e-utils.cjs`, Playwright E2E, Salesforce CLI.

---

### Task 1: Add Safe Salesforce CLI Failure Tests

**Files:**
- Create: `test/e2e/utils/__tests__/sfCli.test.ts`
- Modify: none

- [ ] **Step 1: Write the failing tests**

Create `test/e2e/utils/__tests__/sfCli.test.ts` with:

```ts
const execFileMock = jest.fn();

jest.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args)
}));

function failCommand(error: NodeJS.ErrnoException, stdout = '', stderr = ''): void {
  const callback = execFileMock.mock.calls.at(-1)?.[3] as (error: unknown, stdout: string, stderr: string) => void;
  callback(error, stdout, stderr);
}

function passCommand(stdout: string, stderr = ''): void {
  const callback = execFileMock.mock.calls.at(-1)?.[3] as (error: unknown, stdout: string, stderr: string) => void;
  callback(null, stdout, stderr);
}

async function importSfCli(): Promise<typeof import('../sfCli')> {
  jest.resetModules();
  return await import('../sfCli');
}

describe('runSfJson failure diagnostics', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  test('reports missing Salesforce CLI executable with PATH guidance', async () => {
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'display', '-o', 'ConfiguredDevHub']);

    await Promise.resolve();
    const resolveError = new Error('command not found') as NodeJS.ErrnoException;
    resolveError.code = 1;
    failCommand(resolveError);

    await Promise.resolve();
    const missingError = new Error('spawn sf ENOENT') as NodeJS.ErrnoException;
    missingError.code = 'ENOENT';
    failCommand(missingError);

    await expect(promise).rejects.toThrow(
      /Salesforce CLI executable 'sf' was not found\. Check PATH or install Salesforce CLI for the Node\/test environment\./
    );
  });

  test('includes exit code when Salesforce CLI exits without JSON details', async () => {
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'display', '-o', 'ConfiguredDevHub']);

    await Promise.resolve();
    passCommand('/usr/local/bin/sf\n');

    await Promise.resolve();
    const exitError = new Error('Command failed') as NodeJS.ErrnoException;
    exitError.code = 127;
    failCommand(exitError);

    await expect(promise).rejects.toThrow(/Process failed with exit code 127\./);
  });

  test('includes signal when Salesforce CLI is terminated without JSON details', async () => {
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'display', '-o', 'ConfiguredDevHub']);

    await Promise.resolve();
    passCommand('/usr/local/bin/sf\n');

    await Promise.resolve();
    const signalError = new Error('Command terminated') as NodeJS.ErrnoException;
    signalError.signal = 'SIGTERM';
    failCommand(signalError);

    await expect(promise).rejects.toThrow(/Process failed with signal SIGTERM\./);
  });

  test('keeps parsed Salesforce CLI JSON errors readable', async () => {
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'display', '-o', 'ConfiguredDevHub']);

    await Promise.resolve();
    passCommand('/usr/local/bin/sf\n');

    await Promise.resolve();
    const exitError = new Error('Command failed') as NodeJS.ErrnoException;
    exitError.code = 1;
    failCommand(exitError, '{"name":"NamedOrgNotFoundError","message":"No authorization information found."}\n');

    await expect(promise).rejects.toThrow(/NamedOrgNotFoundError: No authorization information found\./);
  });
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24.15.0 >/dev/null && npm run test:e2e:utils -- --runTestsByPath test/e2e/utils/__tests__/sfCli.test.ts
```

Expected: the new tests fail because `sfCli.ts` does not yet include missing executable, exit code, or signal diagnostics.

- [ ] **Step 3: Commit the red test**

```bash
git add test/e2e/utils/__tests__/sfCli.test.ts
git commit -m "test(e2e): cover safe sf cli diagnostics"
```

### Task 2: Implement Safe Salesforce CLI Diagnostics

**Files:**
- Modify: `test/e2e/utils/sfCli.ts`
- Test: `test/e2e/utils/__tests__/sfCli.test.ts`

- [ ] **Step 1: Add process failure formatting**

In `test/e2e/utils/sfCli.ts`, add this helper after `formatSfErrorDetails`:

```ts
function formatProcessFailureDetails(file: string, error: unknown): string | undefined {
  const err = error as NodeJS.ErrnoException | undefined;
  const code = err?.code;
  const signal = err?.signal;

  if (code === 'ENOENT') {
    const executable = path.basename(file) || file;
    if (executable === 'sf' || executable === 'sf.cmd' || executable === 'sf.exe') {
      return `Salesforce CLI executable '${file}' was not found. Check PATH or install Salesforce CLI for the Node/test environment.`;
    }
    return `Executable '${file}' was not found. Check PATH for the test environment.`;
  }

  if (typeof code === 'number') {
    return `Process failed with exit code ${code}.`;
  }

  if (typeof signal === 'string' && signal.trim()) {
    return `Process failed with signal ${signal}.`;
  }

  if (typeof code === 'string' && code.trim()) {
    return `Process failed with error code ${code}.`;
  }

  return undefined;
}
```

- [ ] **Step 2: Include safe metadata in command failures**

Replace the failing branch in `execProcessFileAsync` with:

```ts
if (error) {
  const details = [formatSfErrorDetails(String(stdout || ''), String(stderr || '')), formatProcessFailureDetails(file, error)]
    .filter(Boolean)
    .join('\n');
  // Avoid echoing stdout/stderr directly to prevent leaking auth tokens.
  const msg = details
    ? `Command failed: ${file} ${args.join(' ')}\n${details}`.trim()
    : `Command failed: ${file} ${args.join(' ')}`.trim();
  const err = new Error(msg) as Error & { code?: unknown };
  (err as any).code = (error as any).code;
  reject(err);
  return;
}
```

- [ ] **Step 3: Run the targeted test to verify it passes**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24.15.0 >/dev/null && npm run test:e2e:utils -- --runTestsByPath test/e2e/utils/__tests__/sfCli.test.ts
```

Expected: all tests in `sfCli.test.ts` pass.

- [ ] **Step 4: Run the full E2E utility suite**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24.15.0 >/dev/null && npm run test:e2e:utils
```

Expected: the full Jest E2E utility suite passes.

- [ ] **Step 5: Commit the implementation**

```bash
git add test/e2e/utils/sfCli.ts
git commit -m "test(e2e): improve sf cli failure diagnostics"
```

### Task 3: Bound Debug Flags Panel Action Waits

**Files:**
- Modify: `test/e2e/specs/debugFlagsPanel.e2e.spec.ts`

- [ ] **Step 1: Replace unbounded Playwright action waits**

Modify `test/e2e/specs/debugFlagsPanel.e2e.spec.ts` so the core interactions use named locators and bounded waits:

```ts
    const userRow = debugFlagsFrame.locator(`[data-testid="debug-flags-user-row-${userId}"]`);
    await userRow.waitFor({ state: 'visible', timeout: 60_000 });
    await userRow.click({ timeout: 30_000 });

    const ttlInput = debugFlagsFrame.locator('[data-testid="debug-flags-ttl"]');
    await ttlInput.fill('45');

    const applyButton = debugFlagsFrame.locator('[data-testid="debug-flags-apply"]');
    await expect(applyButton).toBeEnabled({ timeout: 120_000 });
    await applyButton.click({ timeout: 30_000 });
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });
```

Then update the remove and tail assertions:

```ts
    const removeButton = debugFlagsFrame.locator('[data-testid="debug-flags-remove"]');
    await expect(removeButton).toBeEnabled({ timeout: 120_000 });
    await removeButton.click({ timeout: 30_000 });
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });
```

```ts
    const debugFlagsFrameFromTail = await openDebugFlagsFromTail(vscodePage);
    await expect(debugFlagsFrameFromTail.locator('text=Apex Debug Flags').first()).toBeVisible({ timeout: 60_000 });
```

- [ ] **Step 2: Run TypeScript/Jest coverage that catches syntax issues**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24.15.0 >/dev/null && npm run test:e2e:utils
```

Expected: E2E utility tests still pass. This does not execute Playwright specs, but catches imported utility regressions before the slow E2E run.

- [ ] **Step 3: Commit the E2E spec maintenance change**

```bash
git add test/e2e/specs/debugFlagsPanel.e2e.spec.ts
git commit -m "test(e2e): bound debug flags panel waits"
```

### Task 4: Verify Local And Remote E2E Behavior

**Files:**
- Modify: none

- [ ] **Step 1: Validate Salesforce CLI visibility under Node 24**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24.15.0 >/dev/null && export PATH="/home/k2/.nvm/versions/node/v24.15.0/bin:/home/k2/.nvm/versions/node/v26.1.0/bin:$PATH" && node -v && command -v sf && sf --version
```

Expected: Node prints `v24.15.0`, `command -v sf` prints an absolute path, and `sf --version` succeeds.

- [ ] **Step 2: Run local Playwright E2E with the corrected PATH**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24.15.0 >/dev/null && export PATH="/home/k2/.nvm/versions/node/v24.15.0/bin:/home/k2/.nvm/versions/node/v26.1.0/bin:$PATH" && env -u SF_DEVHUB_AUTH_URL SF_DEVHUB_ALIAS=ConfiguredDevHub timeout --signal=TERM --kill-after=60s 75m npm run test:e2e
```

Expected: the run reaches real Playwright test bodies. If it fails due to local Dev Hub or scratch-org state, capture the exact safe error and do not confuse it with the remote `debugFlagsPanel` timeout.

- [ ] **Step 3: Check the remote PR E2E job**

Run:

```bash
gh pr checks 826
gh run view 26047382437 --job 76575023431 --log
```

Expected: either the remote job has completed and the log identifies the failing operation, or GitHub still reports that logs are unavailable while the job is in progress.

- [ ] **Step 4: Push commits and let PR checks rerun**

Run:

```bash
git push
```

Expected: PR #826 updates with the new commits and starts a fresh Playwright E2E run.

- [ ] **Step 5: Summarize evidence**

Report:

```text
- Which Jest utility commands passed or failed.
- Whether local `npm run test:e2e` reached the Playwright bodies.
- The current PR #826 check state.
- Any remaining blocker, with the exact safe error location.
```

## Self-Review

- Spec coverage: Task 1 and Task 2 cover safe Salesforce CLI diagnostics; Task 3 covers bounded debug flags waits; Task 4 covers local and remote verification.
- Placeholder scan: no placeholders are intentionally left in the plan.
- Type consistency: all planned paths and function names match the current repository structure.
