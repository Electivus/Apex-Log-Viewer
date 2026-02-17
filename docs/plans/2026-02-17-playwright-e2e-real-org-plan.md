# Playwright VS Code E2E (Real Scratch Org) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Playwright-driven VS Code (Electron) E2E tests that provision a scratch org from DevHub, seed a deterministic Apex log, open the Electivus Apex Logs panel, open a log in the Log Viewer, and assert the webview renders content.

**Architecture:** Minimal in-repo Playwright harness under `apps/vscode-extension/test/playwright/` with:
- Scratch org utilities (`sf` CLI + Tooling API for TraceFlag)
- Temporary workspace generator (`sfdx-project.json` + `.sf/config.json`)
- Electron launcher (download VS Code via `@vscode/test-electron`, launch via Playwright `_electron`)
- Page helpers (command palette, webview iframe discovery)

**Tech Stack:** TypeScript, `@playwright/test`, `@vscode/test-electron`, Salesforce CLI (`sf`)

---

## Conventions and environment variables

### Local defaults

- `SF_DEVHUB_ALIAS=InsuranceOrgTrialCreme6DevHub`
- `SF_SCRATCH_ALIAS=ALV_E2E_Scratch`
- `SF_SCRATCH_DURATION=1`

### CI defaults

- `SF_DEVHUB_AUTH_URL` (GitHub secret) must be present
- `SF_DEVHUB_ALIAS=DevHub`
- `SF_SCRATCH_ALIAS=ALV_E2E_${{ github.run_id }}`

### Optional toggles

- `SF_TEST_KEEP_ORG=1` keeps the scratch org after the run
- `DEBUG_MODE=1` pauses Playwright on failure (`page.pause()`)

---

## Task 1: Add Playwright test runner plumbing

**Files:**
- Modify: `apps/vscode-extension/package.json`
- Modify: `apps/vscode-extension/package-lock.json`
- Create: `apps/vscode-extension/playwright.config.ts`
- Modify: `package.json` (root scripts)
- Modify: `.gitignore` (ignore `output/playwright/`)
- Create: `apps/vscode-extension/test/playwright/specs/openLogViewer.e2e.spec.ts` (initial RED)

**Step 1: Write the initial failing E2E spec**

Create `apps/vscode-extension/test/playwright/specs/openLogViewer.e2e.spec.ts` with a trivial placeholder test:

```ts
import { test, expect } from '@playwright/test';

test('placeholder', async () => {
  expect(1).toBe(2);
});
```

**Step 2: Run E2E to verify it fails**

Run:
- `npm --prefix apps/vscode-extension run test:e2e`

Expected:
- FAIL because `test:e2e` script doesn’t exist yet (or Playwright not installed)

**Step 3: Add `@playwright/test` + scripts + config**

- Add dev dependency: `@playwright/test`
- Add scripts to `apps/vscode-extension/package.json`:
  - `test:e2e`: `playwright test -c playwright.config.ts`
  - `test:e2e:ui`: `playwright test -c playwright.config.ts --ui`
- Add root script to `package.json`:
  - `ext:test:e2e`: `npm --prefix apps/vscode-extension run test:e2e`
- Add `apps/vscode-extension/playwright.config.ts`:
  - `testDir: 'test/playwright/specs'`
  - `outputDir: 'output/playwright/test-results'`
  - `reporter: [['list'], ['html', { outputFolder: 'output/playwright/report', open: 'never' }]]`
  - `use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' }`
  - `timeout` + `retries` (set retries to `process.env.CI ? 2 : 0`)

**Step 4: Install deps + re-run to verify RED**

Run:
- `npm --prefix apps/vscode-extension install`
- `npm --prefix apps/vscode-extension run test:e2e`

Expected:
- FAIL with the placeholder assertion (1 !== 2)

**Step 5: Commit**

Run:
- `git add apps/vscode-extension/package.json apps/vscode-extension/package-lock.json apps/vscode-extension/playwright.config.ts package.json .gitignore apps/vscode-extension/test/playwright/specs/openLogViewer.e2e.spec.ts`
- `git commit -m "test(e2e): scaffold Playwright runner"`

---

## Task 2: Create the Electron + VS Code fixtures (launch VS Code)

**Files:**
- Create: `apps/vscode-extension/test/playwright/fixtures/desktopTest.ts`
- Create: `apps/vscode-extension/test/playwright/utils/locators.ts`
- Modify: `apps/vscode-extension/test/playwright/specs/openLogViewer.e2e.spec.ts`

**Step 1: Update spec to require VS Code workbench**

Replace placeholder assertion with:

```ts
import { expect } from '@playwright/test';
import { test } from '../fixtures/desktopTest';
import { WORKBENCH } from '../utils/locators';

test('opens VS Code workbench', async ({ page }) => {
  await expect(page.locator(WORKBENCH)).toBeVisible();
});
```

**Step 2: Run to verify it fails**

Run:
- `npm --prefix apps/vscode-extension run test:e2e -- openLogViewer.e2e.spec.ts`

Expected:
- FAIL because `../fixtures/desktopTest` doesn’t exist

**Step 3: Implement minimal `desktopTest` fixture**

Implement:
- Download VS Code once per worker via `@vscode/test-electron`
- Launch Electron via `@playwright/test` `_electron`
- Provide `page` as `electronApp.firstWindow()`
- Wait for `.monaco-workbench`
- Add `DEBUG_MODE=1` pause-on-failure in `afterEach`

**Step 4: Run to verify it passes (GREEN)**

Run:
- `npm --prefix apps/vscode-extension run test:e2e -- openLogViewer.e2e.spec.ts`

Expected:
- PASS `opens VS Code workbench`

**Step 5: Commit**

Run:
- `git add apps/vscode-extension/test/playwright/fixtures/desktopTest.ts apps/vscode-extension/test/playwright/utils/locators.ts apps/vscode-extension/test/playwright/specs/openLogViewer.e2e.spec.ts`
- `git commit -m "test(e2e): launch VS Code via Playwright"`

---

## Task 3: Add scratch org provisioning helpers (DevHub + scratch org)

**Files:**
- Create: `apps/vscode-extension/test/playwright/fixtures/sfCli.ts`
- Create: `apps/vscode-extension/test/playwright/fixtures/scratchOrg.ts`
- Modify: `apps/vscode-extension/test/playwright/fixtures/desktopTest.ts`

**Step 1: Extend fixtures to create a scratch org**

Update `desktopTest` to provide:
- `scratchAlias` (string)
- `devhubAlias` (string)

RED change: reference `scratchAlias` in spec even before implementation:

```ts
test('has a scratch org alias', async ({ scratchAlias }) => {
  expect(scratchAlias).toBeTruthy();
});
```

**Step 2: Run to verify it fails**

Expected:
- FAIL because fixture doesn’t provide `scratchAlias`

**Step 3: Implement `sfCli.ts`**

- `execSfJson(args: string[], opts)` → runs `sf ... --json` and parses JSON
- `sfOrgDisplay(alias)` → returns `{ username, instanceUrl, accessToken, apiVersion }`

**Step 4: Implement `scratchOrg.ts`**

- `ensureDevHub()`:
  - if `SF_DEVHUB_AUTH_URL` set, login via `sf org login sfdx-url ... --alias <SF_DEVHUB_ALIAS> --set-default-dev-hub`
- `ensureScratchOrg()`:
  - reuse if `sf org display -o <SF_SCRATCH_ALIAS>` works
  - else create with `sf org create scratch --target-dev-hub <SF_DEVHUB_ALIAS> --alias <SF_SCRATCH_ALIAS> --duration-days <n> --wait 15 --json`
- `cleanupScratchOrg()`:
  - delete unless `SF_TEST_KEEP_ORG=1`

**Step 5: Run to verify GREEN**

Run:
- `SF_DEVHUB_ALIAS=InsuranceOrgTrialCreme6DevHub npm --prefix apps/vscode-extension run test:e2e -- openLogViewer.e2e.spec.ts`

Expected:
- PASS (and scratch org reused/created)

**Step 6: Commit**

Run:
- `git add apps/vscode-extension/test/playwright/fixtures/sfCli.ts apps/vscode-extension/test/playwright/fixtures/scratchOrg.ts apps/vscode-extension/test/playwright/fixtures/desktopTest.ts apps/vscode-extension/test/playwright/specs/openLogViewer.e2e.spec.ts`
- `git commit -m "test(e2e): provision scratch org via DevHub"`

---

## Task 4: Create a temp workspace that targets the scratch org

**Files:**
- Create: `apps/vscode-extension/test/playwright/fixtures/workspace.ts`
- Modify: `apps/vscode-extension/test/playwright/fixtures/desktopTest.ts`

**Step 1: Add failing assertion that `.sf/config.json` exists**

In spec:
- assert the fixture returns `workspaceDir`
- assert file `<workspaceDir>/.sf/config.json` exists

Run and verify RED.

**Step 2: Implement `workspace.ts`**

Implement `createE2EWorkspace({ scratchAlias })`:
- `mkdtemp` workspace
- write `sfdx-project.json` (sourceApiVersion `64.0` unless env override)
- create `.sf/config.json` with `{ "target-org": "<scratchAlias>" }`

**Step 3: Wire into Electron launch args**

Launch VS Code with `workspaceDir` as the last CLI arg.

**Step 4: Run to verify GREEN**

Expected:
- VS Code opens that workspace and fixture assertions pass

**Step 5: Commit**

`git commit -m "test(e2e): launch VS Code with temp workspace"`

---

## Task 5: Seed a deterministic Apex log (TraceFlag + Execute Anonymous)

**Files:**
- Create: `apps/vscode-extension/test/playwright/fixtures/tooling.ts`
- Create: `apps/vscode-extension/test/playwright/fixtures/seedLog.ts`
- Modify: `apps/vscode-extension/test/playwright/fixtures/desktopTest.ts`
- Modify: `apps/vscode-extension/test/playwright/specs/openLogViewer.e2e.spec.ts`

**Step 1: Add failing expectation for `seededLogId`**

In spec:

```ts
test('seeds an apex log', async ({ seededLogId }) => {
  expect(seededLogId).toMatch(/^[a-zA-Z0-9]{15,18}$/);
});
```

Run and verify RED.

**Step 2: Implement `tooling.ts`**

Implement minimal REST helpers:
- `getOrgAuthFromSf(alias)` using `sf org display -o <alias> --json`
- `query(auth, soql)` via `GET /services/data/vXX.X/query?q=...`
- `toolingQuery(auth, soql)` via `GET /services/data/vXX.X/tooling/query?q=...`
- `toolingCreate(auth, sobject, payload)` via `POST /services/data/vXX.X/tooling/sobjects/<SObject>`
- `toolingPatch(auth, sobject, id, payload)` via `PATCH ...`

**Step 3: Implement TraceFlag ensure**

In `seedLog.ts`:
- Find current user id (`SELECT Id FROM User WHERE Username = '<username>'`)
- Ensure a `DebugLevel` exists (create one if missing, with reasonable fields)
- Ensure a `TraceFlag` exists for `USER_DEBUG` (create or update Start/Expiration window)

**Step 4: Execute Apex and pick the new log**

- `sf apex list log -o <scratch> --json` → before set
- `sf apex run -o <scratch> --file <tmp.apex>`
- `sf apex list log -o <scratch> --json` → after set
- pick first log id not in before set as `seededLogId`
- marker: `ALV_E2E_MARKER_<timestamp>`

**Step 5: Run to verify GREEN**

Expected:
- Seed step succeeds and yields a log id

**Step 6: Commit**

`git commit -m "test(e2e): seed deterministic apex log"`

---

## Task 6: Drive the UI to open the Log Viewer webview

**Files:**
- Create: `apps/vscode-extension/test/playwright/pages/commandPalette.ts`
- Create: `apps/vscode-extension/test/playwright/pages/webviews.ts`
- Modify: `apps/vscode-extension/test/playwright/specs/openLogViewer.e2e.spec.ts`

**Step 1: RED — spec executes the “Show Electivus Apex Logs” view**

Add:
- `executeCommandWithCommandPalette(page, 'View: Show Electivus Apex Logs')`

Run and verify RED (helpers missing).

**Step 2: Implement command palette helpers**

Implement:
- `openCommandPalette(page)` (F1, focus + retry)
- `executeCommandWithCommandPalette(page, command)` (type, click first match)

**Step 3: Find logs webview and click Open**

Implement in `webviews.ts`:
- `findWebviewFrameByText(page, 'Electivus Apex Logs')` (fallback: find frame containing `button[aria-label="Open"]`)
- `findWebviewFrameByText(page, 'Apex Log Viewer')`

In spec:
- wait for logs webview open buttons
- click up to N visible `aria-label="Open"` buttons until the log viewer title includes `seededLogId`

**Step 4: Assert log viewer content includes marker**

In log viewer frame:
- expect `text=Apex Log Viewer` visible
- expect marker text visible somewhere

**Step 5: Run to verify GREEN**

Run:
- `SF_DEVHUB_ALIAS=InsuranceOrgTrialCreme6DevHub npm --prefix apps/vscode-extension run test:e2e -- openLogViewer.e2e.spec.ts`

Expected:
- PASS end-to-end

**Step 6: Commit**

`git commit -m "test(e2e): open log in viewer via UI"`

---

## Task 7: Add GitHub Actions workflow + docs updates

**Files:**
- Create: `.github/workflows/e2e-playwright.yml`
- Modify: `docs/TESTING.md`
- Modify: `apps/vscode-extension/docs/TESTING.md`

**Step 1: Add workflow_dispatch workflow**

- Setup Node 22.x
- `npm ci --workspaces=false` in `apps/vscode-extension`
- `npm run test:linux-deps`
- Run E2E with env:
  - `SF_DEVHUB_AUTH_URL: ${{ secrets.SF_DEVHUB_AUTH_URL }}`
  - `SF_DEVHUB_ALIAS=DevHub`
  - `SF_SCRATCH_ALIAS=ALV_E2E_${{ github.run_id }}`
- Upload `output/playwright/` artifacts (always)

**Step 2: Update docs**

Add local run example:
- `SF_DEVHUB_ALIAS=InsuranceOrgTrialCreme6DevHub npm run ext:test:e2e`

**Step 3: Run lint/docs checks**

- `npm --prefix apps/vscode-extension run lint`

**Step 4: Commit**

`git commit -m "ci(e2e): add Playwright workflow"`

---

## Verification checklist (before claiming completion)

Run locally (from repo root or worktree root):

- `npm --prefix apps/vscode-extension run test:webview`
- `SF_DEVHUB_ALIAS=InsuranceOrgTrialCreme6DevHub npm --prefix apps/vscode-extension run test:e2e`

If running headless Linux without a display, ensure E2E uses `xvfb-run` or Playwright headless mode appropriately and capture artifacts under `output/playwright/`.

