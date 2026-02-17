# Playwright VS Code E2E (Real Scratch Org) — Design

Date: 2026-02-17

## Goal

Add end-to-end (E2E) tests for the VS Code extension that:

- Drive **real VS Code (Electron)** via **Playwright**
- Use a **real Salesforce scratch org** for validation
- Create the scratch org locally using the DevHub alias **`InsuranceOrgTrialCreme6DevHub`**
- Support running the same E2E suite in CI using a GitHub Actions secret **`SF_DEVHUB_AUTH_URL`**

The first must-pass scenario is:

1. Provision scratch org (or reuse it)
2. Seed a deterministic Apex log (unique marker)
3. Launch VS Code with the extension under test
4. Open the **Electivus Apex Logs** panel
5. Click **Open** on the newest log row
6. Assert the **Apex Log Viewer** webview renders and shows expected content

## Non-goals (initial scope)

- Testing Apex Replay Debugger integration (depends on Salesforce extensions; more brittle)
- Testing Tail Logs (long-running, streaming; separate scenario)
- Running E2E as part of the default `CI` workflow for every PR/push (secrets + flake risk)

## Current state

The repository already has:

- Webview unit tests via Jest (`apps/vscode-extension/src/webview/__tests__`)
- VS Code-hosted unit/integration tests via `@vscode/test-electron` and a custom runner (`apps/vscode-extension/scripts/run-tests.js`)
- Optional DevHub + scratch org setup logic in test runner (env-driven)

However, there is no Playwright-based E2E coverage that validates the full UX from the actual VS Code UI into our webviews.

## Approach (recommended)

Build a minimal, in-repo Playwright **desktop Electron** harness using `@playwright/test`:

- Download VS Code with `@vscode/test-electron` (cached)
- Launch VS Code as an Electron app using Playwright `_electron.launch(...)`
- Create an isolated, temporary workspace directory containing:
  - `sfdx-project.json` (with `sourceApiVersion`)
  - `.sf/config.json` pointing `target-org` at the scratch org alias
- Provision a scratch org (or reuse an existing alias) and seed a deterministic debug log
- Drive VS Code UI:
  - Use Command Palette to open the **Electivus Apex Logs** panel
  - Interact with the Logs list webview and click the **Open** action
  - Validate the Log Viewer webview renders expected content

This intentionally avoids bringing in an external E2E harness dependency; we copy only the patterns we need.

## Scratch org provisioning

### Inputs

The E2E runner will support these environment variables:

- `SF_DEVHUB_ALIAS`
  - Local default: `InsuranceOrgTrialCreme6DevHub`
  - CI default: `DevHub` (after auth via `SF_DEVHUB_AUTH_URL`)
- `SF_DEVHUB_AUTH_URL` (CI secret): SFDX auth URL for the Dev Hub
- `SF_SCRATCH_ALIAS` (default `ALV_E2E_Scratch`; CI will use a unique alias per run)
- `SF_SCRATCH_DURATION` (default `1`)
- `SF_TEST_KEEP_ORG=1` (skip deletion)

### Behavior

- If `SF_DEVHUB_AUTH_URL` is set, authenticate the DevHub in a throwaway manner for the test run:
  - `sf org login sfdx-url --sfdx-url-file <file> --alias <SF_DEVHUB_ALIAS> --set-default-dev-hub --json`
- If the scratch alias already exists (`sf org display -o <alias> --json`), reuse it.
- Otherwise create it:
  - `sf org create scratch --target-dev-hub <SF_DEVHUB_ALIAS> --alias <SF_SCRATCH_ALIAS> --duration-days <n> --wait 15 --json`
- Delete the scratch org at the end unless `SF_TEST_KEEP_ORG=1` is set.

We avoid mutating the developer’s global default org except where the CLI requires a default dev hub during a CI run.

## Seeding a deterministic Apex log

We need a reliable way to guarantee at least one recent ApexLog row exists.

### Steps

1. List existing logs **before**:
   - `sf apex list log -o <scratchAlias> --json`
2. Ensure debug logging is enabled for the current user:
   - Create/update Tooling API `TraceFlag` for `USER_DEBUG` with a known `DebugLevel`
   - This will be implemented in Node using the same Tooling API primitives the extension already uses (`apps/vscode-extension/src/salesforce/traceflags.ts`)
3. Run anonymous Apex containing a unique marker:
   - `System.debug('ALV_E2E_MARKER_<timestamp>');`
   - via `sf apex run -o <scratchAlias> --file <tmp.apex>`
4. List logs **after** and select the newest ID not present in the “before” set.
5. Store `seededLogId` for assertions.

This avoids needing to deploy metadata and keeps E2E runs relatively quick.

## VS Code UI automation details

### Launching VS Code

- Download VS Code with `@vscode/test-electron` into `apps/vscode-extension/.vscode-test/`
- Launch via Playwright Electron with:
  - `--extensionDevelopmentPath=<apps/vscode-extension>`
  - isolated `--user-data-dir` and `--extensions-dir` under the temp workspace
  - `--disable-workspace-trust`
  - `--no-sandbox`
  - open the temp workspace folder

### Opening the extension UI

- Use Command Palette (F1) with retry logic (focus is flaky on Windows)
- Prefer command: `View: Show Electivus Apex Logs`
- Provide fallbacks if needed:
  - `View: Open View...` → select `Electivus Apex Logs`

### Interacting with webviews

- Locate the Logs view webview `<iframe>` (VS Code uses nested iframes for webviews)
- Click the row **Open** action (`aria-label="Open"`)
- Switch to the Log Viewer panel webview `<iframe>`
- Assert:
  - Header text includes `Apex Log Viewer`
  - File name includes the seeded log id (or at least ends with `.log`)
  - Content rendered (e.g., `Total Lines: N` where `N > 0`)
  - Optionally: search for the marker string

### Artifacts + debugging

- Store Playwright artifacts under `output/playwright/`
- Default: traces/videos/screenshots on failure only
- `DEBUG_MODE=1` can pause Playwright on failures for local debugging

## CI workflow

Add a dedicated workflow (manual by default):

- `.github/workflows/e2e-playwright.yml`
- Trigger: `workflow_dispatch`
- Uses `secrets.SF_DEVHUB_AUTH_URL`
- Creates a unique scratch alias (example: `ALV_E2E_${{ github.run_id }}`)
- Uploads `output/playwright/` as workflow artifacts

This avoids breaking PR builds where secrets are unavailable.

## Risks and mitigations

- **VS Code DOM changes / iframe structure** → centralize locators + prefer accessible labels
- **Webview virtualization** (log rows are virtualized) → avoid relying on row order beyond “first visible row” and click the `aria-label="Open"` action
- **Scratch org provisioning delays** → generous timeouts + reuse org locally
- **Flaky focus / keybindings** → command palette open/execute helpers with retries

## Follow-ups (future)

- Add a Tail Logs E2E scenario (requires streaming + waiting)
- Add Replay Debugger integration checks (requires Salesforce extension pack behavior)
- Expand assertions to verify the seeded marker is present in the parsed log content

