# Testing

This project uses VS Code integration tests (Mocha running inside the Extension Development Host) and also runs unit‑style tests that don’t require a real org. The same runner powers both paths.

## Commands

- `npm run test:webview`: executes the React webview suites under Jest with a jsdom environment (fast, no VS Code host required).
- `npm run test:unit`: fast path; runs Jest first and then the VS Code-hosted unit scope.
- `npm run test:integration`: installs dependency extensions if needed and runs integration tests.
- `npm run test:all`: runs the Jest webview suites, then both unit and integration scopes.
- `npm run test:e2e`: runs Playwright E2E tests against a real scratch org (creates a scratch org + seeds an Apex log).

The test orchestrator lives in `scripts/run-tests.js` and the Mocha programmatic runner in `src/test/runner.ts`.

### VS Code UI Test Runner (opcional)

Se você preferir rodar e depurar via UI, instale a extensão “Extension Test Runner”. Use o launch `Extension Tests` (em `.vscode/launch.json`) para abrir o host de testes apontando para `out/test/runner.js`.

## How it works

- VS Code is downloaded via `@vscode/test-electron` and launched with `--extensionDevelopmentPath` and `--extensionTestsPath` (the compiled runner).
- A temporary workspace is created with a minimal `sfdx-project.json` (including `sourceApiVersion`) and opened during tests.
- On integration runs, the Salesforce Extension Pack (`salesforce.salesforcedx-vscode`) is installed via the VS Code CLI.
- On headless Linux, the script re‑executes under `xvfb-run` if available and sets Electron flags to reduce GPU/DBus issues.

## Environment variables

- `VSCODE_TEST_VERSION`: VS Code build to test against. Defaults to `stable` (local e CI); sobrescreva quando precisar validar outra versão.
- `VSCODE_TEST_EXTENSIONS`: Comma-separated list of VS Code extension IDs to install for integration tests (default: `salesforce.salesforcedx-vscode`).
- `VSCODE_TEST_FORCE_INSTALL_DEPS=1`: Forces reinstalling dependency extensions even if already present in the cache (useful when debugging flaky installs).
- `VSCODE_TEST_GREP`: Mocha grep filter (string or regexp); use with `VSCODE_TEST_INVERT=1` to invert.
- `VSCODE_TEST_MOCHA_TIMEOUT_MS`: Per‑test timeout (default 120000ms).
- `VSCODE_TEST_TOTAL_TIMEOUT_MS`: Global hard timeout for the whole run.
- `VSCODE_TEST_WORKSPACE`: If set, path opened by the test host. Normally the runner creates one for you.
- `SF_LOG_TRACE=1`: Enables verbose trace logging in the temporary workspace settings.

### Test cache cleanup

- `npm run test:clean`: cleans temp test dirs (user data, legacy temp extension dirs) but preserves `.vscode-test/` (VS Code download cache) by default.
- `npm run test:clean:all`: fully removes `.vscode-test/` too (forces a re-download on the next run).
- `CLEAN_VSCODE_TEST_CACHE=1`: removes `.vscode-test/` (same effect as `test:clean:all`).
- `KEEP_VSCODE_TEST_CACHE=1`: preserves `.vscode-test/` (default behavior; useful to override `CLEAN_*`).

### Salesforce CLI and scratch org (optional)

Tests do not require an authenticated org by default. If you want the runner to authenticate a Dev Hub and create a scratch org automatically:

- `SF_DEVHUB_AUTH_URL`: SFDX URL for the Dev Hub auth.
- `SF_DEVHUB_ALIAS`: Alias for the Dev Hub (default `DevHub`).
- `SF_SETUP_SCRATCH=1`: Enables scratch org creation when a Dev Hub is available.
- `SF_SCRATCH_ALIAS`: Scratch alias (default `ALV_Test_Scratch`).
- `SF_SCRATCH_DURATION`: Scratch duration in days (default `1`).
- `SF_TEST_KEEP_ORG=1`: Skip deleting the scratch org during cleanup.

## Playwright E2E (real org)

The Playwright suite validates the webview UX end-to-end by:

1. Authenticating a Dev Hub (CI via `SF_DEVHUB_AUTH_URL`, local via an existing auth)
2. Creating/reusing a scratch org
3. Seeding an Apex log (anonymous Apex with a unique marker)
4. Launching VS Code and verifying the Logs panel + Log Viewer show that log

### Run locally

From the repo root:

- `SF_TEST_KEEP_ORG=1 npm run test:e2e`

Useful env vars:

- `SF_DEVHUB_AUTH_URL`: Optional locally; required in CI. If not set, the E2E suite assumes you already have a Dev Hub authenticated locally.
- `SF_DEVHUB_ALIAS`: Dev Hub alias to use. If unset, local runs prefer `DevHubElectivus` when available.
- `SF_SCRATCH_ALIAS`: Scratch alias (default `ALV_E2E_Scratch`).
- `SF_SCRATCH_DURATION`: Scratch duration in days (default `1`).
- `SF_TEST_KEEP_ORG=1`: Keep the scratch org after the run (recommended while iterating).
- `SF_E2E_DEBUG_FLAGS_USERNAME`: Optional username for the Debug Flags E2E user. If unset, tests auto-manage `alv.debugflags.<orgid>@example.com` (create if missing, reuse if present). If the org has no spare Salesforce licenses, tests fall back to the authenticated user.

Troubleshooting:

- If the Logs panel shows **“Salesforce CLI not found”**, set the VS Code setting `electivus.apexLogs.cliPath` to the absolute path of your `sf` executable.

Artifacts (screenshots/traces/videos on failure) are written under `output/playwright/`.

## Debugging

Use the `Extension Tests` launch config. It points to `out/test/runner.js`. Set breakpoints in `src/test/**/*.ts` (VS Code loads the compiled JavaScript).

## Notes

- The runner enforces Mocha UI `tdd` (`suite`/`test`) and loads `out/test/mocha.setup.js` to count executed tests; if zero tests run and `VSCODE_TEST_FAIL_IF_NO_TESTS=1`, the run fails.
- We inject an HTTPS request shim in tests to avoid interference from extension host instrumentation.
- The temporary workspace is deleted after the run.
