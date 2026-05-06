# E2E Azure OIDC Token Lifetime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the real-org Playwright telemetry validation job from failing when Azure's OIDC federated assertion expires before the Log Analytics query.

**Architecture:** Move Azure login later in the GitHub Actions job and pre-resolve the Log Analytics workspace before the long Playwright child run starts. The telemetry runner will pass the prepared workspace context into the existing validation loop so query targeting remains unchanged while token acquisition happens while the assertion is fresh.

**Tech Stack:** GitHub Actions YAML, Node.js CommonJS scripts, `node:test`, Azure CLI helper functions.

---

## File structure

- Modify `scripts/cli-e2e-workflow.test.js`
  - Owns static workflow guard tests for `.github/workflows/e2e-playwright.yml`.
  - Add order assertions that place `Azure login for dedicated App Insights validation` after CLI E2E artifacts and before extension Playwright E2E.
- Modify `.github/workflows/e2e-playwright.yml`
  - Move the existing Azure login step without changing its `if`, `uses`, or `with` fields.
- Modify `scripts/run-playwright-e2e-telemetry.test.js`
  - Owns unit tests for the telemetry wrapper.
  - Add a regression test for pre-warming workspace metadata before spawning Playwright.
- Modify `scripts/run-playwright-e2e-telemetry.js`
  - Add `prepareTelemetryValidationContext`.
  - Add an injectable `runTelemetryE2e` orchestration helper for order testing.
  - Update `waitForTelemetry` to accept a prepared validation context.

---

### Task 1: Add failing workflow ordering guard

**Files:**
- Modify: `scripts/cli-e2e-workflow.test.js`
- Test: `scripts/cli-e2e-workflow.test.js`

- [ ] **Step 1: Update the Azure login workflow test**

Replace the existing test named `real-org Playwright workflow uses the org-allowlisted Azure login pin` with:

```js
test('real-org Playwright workflow logs into Azure immediately before telemetry-capable extension E2E', () => {
  const workflow = readWorkflow();
  const azureLoginStep = getWorkflowStep(workflow, 'Azure login for dedicated App Insights validation');
  const cliStep = getWorkflowStep(workflow, 'Run CLI real-org E2E');
  const uploadArtifactsStep = getWorkflowStep(workflow, 'Upload CLI E2E artifacts');
  const extensionStep = getWorkflowStep(workflow, 'Run Playwright E2E');

  assert.equal(
    azureLoginStep.step.uses,
    'azure/login@93381592711f247e165c389ebb30b596c84cdc48',
    'expected azure/login to stay pinned to the SHA currently allowed by the Electivus org action policy'
  );
  assert.ok(
    cliStep.index < azureLoginStep.index,
    'expected Azure login to run after the CLI real-org step so the OIDC assertion is fresher for telemetry validation'
  );
  assert.ok(
    uploadArtifactsStep.index < azureLoginStep.index,
    'expected Azure login to run after CLI artifact upload and immediately before the extension Playwright step'
  );
  assert.ok(
    azureLoginStep.index < extensionStep.index,
    'expected Azure login to run before the telemetry-capable extension Playwright step'
  );
});
```

- [ ] **Step 2: Run the workflow guard and verify it fails**

Run:

```bash
node --test scripts/cli-e2e-workflow.test.js
```

Expected: FAIL with the message `expected Azure login to run after the CLI real-org step so the OIDC assertion is fresher for telemetry validation`, because the current workflow logs into Azure before the CLI step.

- [ ] **Step 3: Commit the failing workflow test**

```bash
git add scripts/cli-e2e-workflow.test.js
git commit -m "test(e2e): guard Azure login ordering"
```

---

### Task 2: Add failing telemetry pre-warm regression test

**Files:**
- Modify: `scripts/run-playwright-e2e-telemetry.test.js`
- Test: `scripts/run-playwright-e2e-telemetry.test.js`

- [ ] **Step 1: Update telemetry test imports**

Change the import block in `scripts/run-playwright-e2e-telemetry.test.js` to include `runTelemetryE2e`:

```js
const {
  buildRunValidationQuery,
  resolveConfig,
  resolvePlaywrightChildInvocation,
  runTelemetryE2e,
  spawnAsync,
  summarizeTelemetry
} = require('./run-playwright-e2e-telemetry');
```

- [ ] **Step 2: Add the orchestration order test**

Add this test after `spawnAsync rejects when the child process cannot be started`:

```js
test('runTelemetryE2e prepares Log Analytics context before spawning Playwright', async () => {
  const calls = [];
  const validationContext = {
    componentResourceId: '/subscriptions/sub/resourceGroups/rg/providers/microsoft.insights/components/appi-e2e',
    workspaceCustomerId: 'workspace-customer-id'
  };

  const result = await runTelemetryE2e({
    env: {
      ALV_E2E_TELEMETRY_APP: 'appi-e2e',
      ALV_E2E_TELEMETRY_BASE_APP: 'appi-base',
      ALV_E2E_TELEMETRY_RESOURCE_GROUP: 'rg-telemetry',
      AZURE_SUBSCRIPTION_ID: 'sub-123'
    },
    extraArgs: ['--grep', 'logs'],
    repoRoot: path.join('/repo', 'apex-log-viewer'),
    logger: { log() {} },
    randomUUIDImpl: () => 'run-123',
    ensureTelemetryComponentImpl: async config => {
      calls.push(['ensure', config.appName]);
      return {
        component: {
          connectionString: 'InstrumentationKey=00000000-0000-0000-0000-000000000000',
          id: validationContext.componentResourceId,
          name: 'appi-e2e',
          resourceGroup: 'rg-telemetry',
          workspaceResourceId: '/subscriptions/sub/resourceGroups/rg/providers/microsoft.operationalinsights/workspaces/law-e2e'
        },
        created: false
      };
    },
    prepareTelemetryValidationContextImpl: async (config, component) => {
      calls.push(['prepare', component.id]);
      assert.equal(config.appName, 'appi-e2e');
      return validationContext;
    },
    resolvePlaywrightChildInvocationImpl: extraArgs => {
      calls.push(['resolve-child', extraArgs.join(' ')]);
      return { command: 'node', args: ['child.js'] };
    },
    spawnAsyncImpl: async (command, args) => {
      calls.push(['spawn', command, args.join(' ')]);
      return { code: 0, signal: null };
    },
    waitForTelemetryImpl: async (_config, _component, runId, options) => {
      calls.push(['wait', runId, options.validationContext.workspaceCustomerId]);
      return {
        attempt: 1,
        rows: [{ name: 'electivus.apex-log-viewer/extension.activate', events: 5 }],
        summary: { distinctNames: 3, hasActivation: true, totalEvents: 5 }
      };
    }
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    ['ensure', 'appi-e2e'],
    ['prepare', validationContext.componentResourceId],
    ['resolve-child', '--grep logs'],
    ['spawn', 'node', 'child.js'],
    ['wait', 'run-123', 'workspace-customer-id']
  ]);
});
```

- [ ] **Step 3: Run the telemetry test and verify it fails**

Run:

```bash
node --test scripts/run-playwright-e2e-telemetry.test.js
```

Expected: FAIL with `runTelemetryE2e is not a function`, because the orchestration helper does not exist yet.

- [ ] **Step 4: Commit the failing telemetry test**

```bash
git add scripts/run-playwright-e2e-telemetry.test.js
git commit -m "test(e2e): require telemetry context prewarm"
```

---

### Task 3: Implement telemetry context pre-warm

**Files:**
- Modify: `scripts/run-playwright-e2e-telemetry.js`
- Test: `scripts/run-playwright-e2e-telemetry.test.js`

- [ ] **Step 1: Add the prepared validation context helper**

In `scripts/run-playwright-e2e-telemetry.js`, add this helper after `async function queryTelemetryForRun(...)`:

```js
async function prepareTelemetryValidationContext(
  config,
  component,
  resolveWorkspaceInfoImpl = resolveWorkspaceInfo
) {
  const workspace = await resolveWorkspaceInfoImpl({
    ...config,
    workspaceResourceId: component.workspaceResourceId || config.workspaceResourceId
  });

  return {
    componentResourceId: component.id,
    workspaceCustomerId: workspace.workspaceCustomerId
  };
}
```

- [ ] **Step 2: Update `waitForTelemetry` to accept prepared context**

Replace the current `waitForTelemetry` function with:

```js
async function waitForTelemetry(config, component, runId, options = {}) {
  const attempts = Math.max(1, Number(process.env.ALV_E2E_TELEMETRY_QUERY_ATTEMPTS || 18) || 18);
  const delayMs = Math.max(1000, Number(process.env.ALV_E2E_TELEMETRY_QUERY_DELAY_MS || 10000) || 10000);
  const lookback = String(process.env.ALV_E2E_TELEMETRY_LOOKBACK || '2h').trim() || '2h';
  const validationContext =
    options.validationContext ||
    (await prepareTelemetryValidationContext(config, component, options.resolveWorkspaceInfoImpl));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await queryTelemetryForRun(
      validationContext.workspaceCustomerId,
      validationContext.componentResourceId,
      runId,
      lookback
    );
    const rows = toRows(result);
    const summary = summarizeTelemetry(rows);
    if (summary.hasActivation && summary.totalEvents >= 5 && summary.distinctNames >= 3) {
      return { rows, summary, attempt };
    }
    if (attempt < attempts) {
      console.log(
        `[e2e] Waiting for Log Analytics ingestion (${attempt}/${attempts}) -> ${summary.totalEvents} events, ${summary.distinctNames} names`
      );
      await sleep(delayMs);
    }
  }

  const finalResult = await queryTelemetryForRun(
    validationContext.workspaceCustomerId,
    validationContext.componentResourceId,
    runId,
    lookback
  );
  const finalRows = toRows(finalResult);
  const finalSummary = summarizeTelemetry(finalRows);
  throw new Error(
    `Telemetry validation failed for run ${runId}. Expected at least one activation event, 5 total events, and 3 distinct names, but observed ${finalSummary.totalEvents} events across ${finalSummary.distinctNames} names.`
  );
}
```

- [ ] **Step 3: Add the injectable orchestration helper**

Replace the current `async function main()` with these two functions:

```js
async function runTelemetryE2e(options = {}) {
  const env = options.env || process.env;
  const extraArgs = options.extraArgs || process.argv.slice(2);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const logger = options.logger || console;
  const randomUUIDImpl = options.randomUUIDImpl || randomUUID;
  const ensureTelemetryComponentImpl = options.ensureTelemetryComponentImpl || ensureTelemetryComponent;
  const prepareTelemetryValidationContextImpl =
    options.prepareTelemetryValidationContextImpl || prepareTelemetryValidationContext;
  const resolvePlaywrightChildInvocationImpl =
    options.resolvePlaywrightChildInvocationImpl || resolvePlaywrightChildInvocation;
  const spawnAsyncImpl = options.spawnAsyncImpl || spawnAsync;
  const waitForTelemetryImpl = options.waitForTelemetryImpl || waitForTelemetry;

  const config = resolveConfig(env);

  const { component, created } = await ensureTelemetryComponentImpl(config);
  const runId = randomUUIDImpl();

  logger.log(
    `[e2e] ${created ? 'Created' : 'Using'} dedicated Application Insights resource: ${component.name} (${component.resourceGroup})`
  );
  logger.log(`[e2e] Test telemetry run id: ${runId}`);

  const validationContext = await prepareTelemetryValidationContextImpl(config, component);

  const childEnv = {
    ...env,
    ALV_ENABLE_TEST_TELEMETRY: '1',
    ALV_TEST_TELEMETRY_CONNECTION_STRING: component.connectionString,
    ALV_TEST_TELEMETRY_RUN_ID: runId
  };

  const childInvocation = resolvePlaywrightChildInvocationImpl(extraArgs, childEnv, repoRoot);
  const child = await spawnAsyncImpl(childInvocation.command, childInvocation.args, {
    cwd: repoRoot,
    env: childEnv,
    stdio: 'inherit'
  });

  if (typeof child.code === 'number' && child.code !== 0) {
    return { exitCode: child.code };
  }
  if (child.signal) {
    throw new Error(`Playwright E2E process exited via signal ${child.signal}.`);
  }

  logger.log('[e2e] Playwright suite passed. Validating telemetry arrival in the linked Log Analytics workspace...');
  const validation = await waitForTelemetryImpl(config, component, runId, { validationContext });
  logger.log(
    `[e2e] Telemetry validated after ${validation.attempt} query attempt(s): ${validation.summary.totalEvents} events across ${validation.summary.distinctNames} event names.`
  );
  for (const row of validation.rows) {
    logger.log(`[e2e] ${row.name}: ${row.events}`);
  }

  return { exitCode: 0, validation };
}

async function main() {
  const result = await runTelemetryE2e();
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}
```

- [ ] **Step 4: Export the new helper**

Replace the `module.exports` block with:

```js
module.exports = {
  buildRunValidationQuery,
  prepareTelemetryValidationContext,
  resolveConfig,
  resolvePlaywrightChildInvocation,
  runTelemetryE2e,
  spawnAsync,
  summarizeTelemetry
};
```

- [ ] **Step 5: Run the focused telemetry test and verify it passes**

Run:

```bash
node --test scripts/run-playwright-e2e-telemetry.test.js
```

Expected: PASS with all telemetry wrapper tests passing.

- [ ] **Step 6: Commit the telemetry pre-warm implementation**

```bash
git add scripts/run-playwright-e2e-telemetry.js scripts/run-playwright-e2e-telemetry.test.js
git commit -m "fix(e2e): prewarm telemetry workspace context"
```

---

### Task 4: Move Azure login immediately before extension E2E

**Files:**
- Modify: `.github/workflows/e2e-playwright.yml`
- Test: `scripts/cli-e2e-workflow.test.js`

- [ ] **Step 1: Move the Azure login step**

In `.github/workflows/e2e-playwright.yml`, remove this step from its current position before `Run CLI real-org E2E`:

```yaml
      - name: Azure login for dedicated App Insights validation
        if: ${{ env.AZURE_CLIENT_ID != '' && env.AZURE_TENANT_ID != '' && env.AZURE_SUBSCRIPTION_ID != '' && env.HAS_AZURE_E2E_TELEMETRY_CONFIG == '1' }}
        uses: azure/login@93381592711f247e165c389ebb30b596c84cdc48
        with:
          client-id: ${{ env.AZURE_CLIENT_ID }}
          tenant-id: ${{ env.AZURE_TENANT_ID }}
          subscription-id: ${{ env.AZURE_SUBSCRIPTION_ID }}
```

Paste the same step immediately after the `Upload CLI E2E artifacts` step and immediately before `Run Playwright E2E`.

- [ ] **Step 2: Run the focused workflow guard and verify it passes**

Run:

```bash
node --test scripts/cli-e2e-workflow.test.js
```

Expected: PASS with all workflow guard tests passing.

- [ ] **Step 3: Run both focused regression tests**

Run:

```bash
node --test scripts/run-playwright-e2e-telemetry.test.js scripts/cli-e2e-workflow.test.js
```

Expected: PASS with both focused regression files passing.

- [ ] **Step 4: Commit the workflow reorder**

```bash
git add .github/workflows/e2e-playwright.yml scripts/cli-e2e-workflow.test.js
git commit -m "fix(e2e): refresh Azure login before telemetry run"
```

---

### Task 5: Final verification, push, and resume PR babysitting

**Files:**
- Verify all files changed in Tasks 1-4.

- [ ] **Step 1: Run the script regression suite**

Run:

```bash
npm run test:scripts
```

Expected: PASS with `# fail 0`.

- [ ] **Step 2: Confirm the worktree is clean except committed branch history**

Run:

```bash
git status --short --branch
```

Expected: no modified or untracked files.

- [ ] **Step 3: Push the branch**

Run:

```bash
git push origin HEAD:chore/cargo-target-dir-no-direnv
```

Expected: push succeeds and updates PR #783.

- [ ] **Step 4: Resume PR babysitting**

Run from the babysit skill directory:

```bash
python3 scripts/gh_pr_watch.py --pr https://github.com/Electivus/Apex-Log-Viewer/pull/783 --watch
```

Expected: The watcher remains attached through passive states and exits only for an actionable or terminal PR state.

- [ ] **Step 5: Handle the watcher result**

If the watcher exits with `diagnose_ci_failure`, inspect `ci_diagnostics` first and continue the debugging workflow. If it exits with `stop_ready_for_human_approval`, report that PR #783 is green, mergeable, and waiting only for required human review approval. If it exits with `stop_ready_to_merge`, report that the PR is ready to merge.

---

## Self-review checklist

- Spec coverage:
  - Azure login moved later: Task 4.
  - Telemetry context pre-warm before Playwright child process: Tasks 2 and 3.
  - Regression coverage: Tasks 1 and 2.
  - Verification and babysit loop: Task 5.
- Placeholder scan: no placeholder steps remain; every code and command step includes exact content.
- Type consistency:
  - `runTelemetryE2e`, `prepareTelemetryValidationContext`, `validationContext`, and injected implementation names are used consistently between test and implementation steps.
