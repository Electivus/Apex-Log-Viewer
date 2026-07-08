# Testing

This project uses three test layers:

- Node-only extension tests for modules that can run without a real `vscode` host.
- VS Code integration tests (Mocha running inside the Extension Development Host) for activation, commands, providers, and other `vscode`-bound behavior.
- Playwright E2E tests against a real org across two surfaces: the `sf electivus` plugin and the VS Code extension.

## Commands

- `npm run test:webview`: executes the React webview suites under Jest with a jsdom environment (fast, no VS Code host required).
- `npm run test:extension:node`: executes Node-only extension tests under Mocha without launching VS Code.
- `npm run test:unit`: fast path; runs Jest first and then the VS Code-hosted unit scope.
- `npm run test:integration`: installs dependency extensions if needed and runs integration tests.
- `npm run test:all`: runs the Jest webview suites, the Node-only extension lane, and then both VS Code-hosted scopes.
- `npm run test:e2e:cli`: runs the `sf electivus` plugin real-org Playwright suite. If plugin build output is missing, it builds the Salesforce CLI plugin before validating `sf electivus logs sync` and `logs status` against a seeded scratch org.
- `npm run test:e2e`: runs Playwright E2E tests against a real scratch org. The runner uses either the legacy single-scratch flow or the Dev Hub scratch-org pool, depending on the configured strategy.
- `npm run test:e2e:telemetry`: runs the same Playwright E2E suite, but first resolves a dedicated App Insights component for E2E and then validates that telemetry from the current run arrived there.

The Node-only Mocha runner lives in `scripts/run-node-tests.js`. The `sf electivus` real-org runner lives in `scripts/run-playwright-cli-e2e.js` and uses `playwright.cli.config.ts`. The VS Code-hosted test orchestrator lives in `scripts/run-tests.js` and the Mocha programmatic host runner in `apps/vscode-extension/src/test/runner.ts`.

## Test placement guidance

- Put tests in `apps/vscode-extension/src/node-test/` when the module can be loaded without a real `vscode` runtime. Prefer `proxyquire`, fakes, and narrow module seams here.
- Put tests in `apps/vscode-extension/src/test/` when the subject imports `vscode`, depends on activation wiring, touches commands/providers/views, or needs the Extension Development Host lifecycle.
- Keep the default CLI-driven VS Code runtime on `stable`. Use `VSCODE_TEST_VERSION` only when you are intentionally validating another build.
- If a test can be rewritten to avoid `vscode` at runtime, prefer moving it to `src/node-test/` instead of expanding the host-bound suite.

### VS Code UI Test Runner (opcional)

Se você preferir rodar e depurar via UI, instale a extensão “Extension Test Runner”. Use o launch `Extension Tests` (em `.vscode/launch.json`) para abrir o host de testes apontando para `out/test/runner.js`.

## How it works

- VS Code is downloaded via `@vscode/test-electron` and launched with `--extensionDevelopmentPath` and `--extensionTestsPath` (the compiled runner).
- A temporary workspace is created with a minimal `sfdx-project.json` (including `sourceApiVersion`) and opened during tests.
- The CLI real-org suite uses the same scratch-org helper layer as the extension suite, but it stays entirely outside the VS Code host and validates the `sf electivus` workflows directly.
- Playwright E2E runs keep the isolated VS Code profile intentionally minimal. Support extensions are installed per scenario instead of pulling the full Salesforce Extension Pack by default. Replay-specific specs opt into `salesforce.salesforcedx-vscode-apex-replay-debugger`, and the harness dismisses visible VS Code notifications during startup to reduce click interception flakiness.
- Playwright E2E keeps `--extensions-dir` isolated. If a required support extension is missing from that isolated profile, the harness now fails explicitly instead of reusing your machine-wide VS Code extensions.
- On headless Linux, the script re‑executes under `xvfb-run` if available and sets Electron flags to reduce GPU/DBus issues.

## Environment variables

- `VSCODE_TEST_VERSION`: VS Code build to test against. Defaults to `stable` (local e CI); sobrescreva quando precisar validar outra versão.
- `VSCODE_TEST_EXTENSIONS`: Comma-separated list of VS Code extension IDs to install for integration tests (default: `salesforce.salesforcedx-vscode,salesforce.salesforcedx-vscode-apex-replay-debugger`).
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
- `SF_DEVHUB_ALIAS`: Alias for the Dev Hub.
- `SF_SETUP_SCRATCH=1`: Enables scratch org creation and requires `SF_DEVHUB_AUTH_URL` or `SF_DEVHUB_ALIAS` to be explicitly set.
- `SF_SCRATCH_ALIAS`: Scratch alias (default `ALV_Test_Scratch`).
- `SF_SCRATCH_DURATION`: Scratch duration in days (default `1`).
- `SF_TEST_KEEP_ORG=1`: Skip deleting the scratch org during cleanup.

## Playwright E2E (real org)

The `sf electivus` plugin and VS Code extension suites share the same real-org setup contract:

1. Validating/authenticating the explicitly configured Dev Hub
2. Creating/reusing a scratch org or acquiring one from the scratch-org pool
3. Seeding an Apex log (anonymous Apex with a unique marker)

The CLI suite then validates the plugin surface through `packages/sf-plugin/bin/run.js` or `ALV_ELECTIVUS_PLUGIN_BIN_PATH`:

1. `sf electivus logs sync --json` downloads the seeded log into the workspace cache
2. `sf electivus logs status --json` reports the synced scratch-org metadata

The VS Code suite launches the extension host and validates the Logs panel + Log Viewer webview UX against the same seeded org, including panel search through local saved log files.

### Run locally

From the repo root:

- `SF_TEST_KEEP_ORG=1 npm run test:e2e:cli`
- `SF_TEST_KEEP_ORG=1 npm run test:e2e`
- `SF_TEST_KEEP_ORG=1 npm run test:e2e:telemetry`
- `SF_DEVHUB_AUTH_URL=force://REDACTED_DEVHUB_AUTH_URL SF_TEST_KEEP_ORG=1 npm run test:e2e:proxy-lab`

Useful env vars:

- `SF_DEVHUB_AUTH_URL`: Explicit Dev Hub auth for the run. Required for real-org `test:e2e:proxy-lab` runs because the clean runner container cannot use a host `SF_DEVHUB_ALIAS`.
- `SF_DEVHUB_ALIAS`: Explicit Dev Hub alias to use for non-proxy-lab runs. Set this or `SF_DEVHUB_AUTH_URL`.
- `SF_SCRATCH_STRATEGY`: `single` or `pool`. If unset, the helper auto-enables pool mode when `SF_SCRATCH_POOL_NAME` is present. Local runs can use either mode; CI forces `pool`.
- `PLAYWRIGHT_WORKERS`: Number of Playwright workers. In pool mode this controls how many isolated tests can run at once, with one scratch-org lease per test. Default `1` locally; the GitHub Actions pool workflow also defaults to `1` unless overridden by the `PLAYWRIGHT_WORKERS` repository variable or the `playwright_workers` dispatch input. In single-scratch mode, the Playwright configs force serial execution.
- `PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS`: GitHub Actions-only worker override for the Ubuntu VS Code extension proxy-lab lane. This is mapped into `PLAYWRIGHT_WORKERS` for that step.
- `PLAYWRIGHT_RETRIES`: Number of Playwright retries passed by the E2E wrapper.
- `PLAYWRIGHT_TIMEOUT_MS`: Per-test Playwright timeout. Defaults to 15 minutes locally and 6 minutes in the GitHub Actions E2E workflow.
- `PLAYWRIGHT_EXPECT_TIMEOUT_MS`: Playwright expect assertion timeout. Defaults to 60 seconds.
- `SF_SCRATCH_ALIAS`: Scratch alias (default `ALV_E2E_Scratch`).
- `SF_SCRATCH_DURATION`: Scratch duration in days (default `1`).
- `SF_TEST_KEEP_ORG=1`: Keep the scratch org after the run (recommended while iterating).
- `SF_E2E_DEBUG_FLAGS_USERNAME`: Optional username for the Debug Flags E2E user. If unset, tests auto-manage `alv.debugflags.<orgid>@example.com` (create if missing, reuse if present). If the org has no spare Salesforce licenses, tests fall back to the authenticated user.
- `ALV_E2E_TIMING=1`: Prints per-step harness timings for scratch-org setup, VS Code startup, command-palette activation, and webview discovery.
- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`: Primary corporate-proxy configuration path, for example `HTTP_PROXY=http://username:pwd@proxy.company.com:8080`. These are honored by the Node-side E2E helpers, scratch-org pool REST calls, Salesforce CLI, VS Code download step, the VS Code extension host, and the plugin runner process. The Playwright configs enable `NODE_USE_ENV_PROXY=1` automatically when one of these proxy vars is present.
- `ALV_E2E_PROXY_SERVER`: Optional E2E-only shorthand for ad-hoc local runs when you do not want to export the standard proxy vars globally. Prefer `HTTP_PROXY` / `HTTPS_PROXY` for corporate parity.
- `ALV_E2E_PROXY_BYPASS`: Optional E2E-only shorthand for proxy bypass entries (same semantics as `NO_PROXY`).
- `ALV_E2E_PROXY_PAC_URL`: Adds `--proxy-pac-url=...` to the isolated VS Code launch when your corporate desktop depends on a PAC file.
- `ALV_E2E_PROXY_STRICT_SSL=0`: Writes `http.proxyStrictSSL=false` into the temporary VS Code user profile for legacy MITM proxies that do not have their CA installed yet. Prefer CA-based trust instead when possible.
- `ALV_E2E_USE_SYSTEM_CA=1`: Enables `NODE_USE_SYSTEM_CA=1` for Node-side E2E helpers so scratch-org and telemetry requests can trust the OS certificate store.
- `NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem`: Adds one or more extra PEM certificates for Node-side E2E traffic when the corporate CA is not in the system store.

### Corporate proxy lab

`npm run test:e2e:proxy-lab` runs the E2E command inside Docker Compose with a real proxy in front of the runner:

- `runner` is attached only to an internal Docker network, so direct internet egress is blocked.
- `proxy` is attached to both the internal network and an external egress network, exposing mitmproxy on `http://proxy:8888` only inside Compose.
- The proxy requires Basic authentication using test-only credentials in the proxy URL, matching the corporate shape `http://username:pwd@proxy.company.com:8080`.
- The lab waits for mitmproxy to generate its CA, then proves that authenticated HTTPS through the proxy fails before that CA is trusted.
- The runner installs the mitmproxy CA into the container trust store, exports `NODE_USE_SYSTEM_CA=1`, `ALV_E2E_USE_SYSTEM_CA=1`, `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE`, and keeps VS Code `http.proxyStrictSSL` enabled.
- The lab verifies that `curl` and a dependency-free Node HTTPS check can reach the internet through the authenticated MITM proxy after CA trust is installed. Real-org commands fail fast when `SF_DEVHUB_AUTH_URL` is missing; explicit non-real-org smoke commands skip the Salesforce CLI preflight.
- Real-org proxy-lab runs require `SF_DEVHUB_AUTH_URL`; a host `SF_DEVHUB_ALIAS` is not sufficient inside the clean runner container.
- After logging in from `SF_DEVHUB_AUTH_URL`, the lab uses `ConfiguredDevHub` as the container-local Dev Hub alias by default. `ALV_E2E_PROXY_LAB_DEVHUB_ALIAS` only changes that container-local alias.
- The lab sets `SFDX_DISABLE_DNS_CHECK=true` because the runner has no direct DNS/egress path to Salesforce; Salesforce CLI traffic must be validated through the proxy instead.
- `ALV_E2E_PROXY_LAB_PROXY_URL` can override the runner proxy URL for negative tests; by default it is `http://alv-proxy-user:alv-proxy-pass@proxy:8888`.
- Docker named volumes persist `node_modules`, `.vscode-test`, npm cache, and Salesforce CLI auth state under `/root/.sf` and `/root/.sfdx` between proxy-lab runs. These volumes may contain org credentials; reset them with `docker compose -f docker-compose.e2e-proxy.yml down --volumes` only when you intentionally want a clean lab.

By default the lab runs `npm run test:e2e`. To run another E2E command inside the same proxy-only network:

```bash
npm run test:e2e:proxy-lab -- npm run test:e2e:cli
```

For local real-org proxy-lab runs, derive an auth URL from an already-authenticated Dev Hub on the host and pass it into the clean container:

```bash
ALV_LOCAL_DEVHUB_AUTH_URL="$(sf org auth show-sfdx-auth-url --target-org <dev-hub-alias> --json --no-prompt | jq -r '.result.sfdxAuthUrl')"
SF_DEVHUB_AUTH_URL="${ALV_LOCAL_DEVHUB_AUTH_URL}" SF_TEST_KEEP_ORG=1 npm run test:e2e:proxy-lab
```

To target the plugin path that powers `logs/list` without paying the full VS Code UI startup cost, run a focused CLI spec:

```bash
npm run test:e2e:proxy-lab -- npm run test:e2e:cli -- test/e2e/cli/specs/logs.e2e.spec.ts
```

For faster iteration after the named Docker volumes already contain dependencies:

```bash
ALV_E2E_PROXY_LAB_SKIP_NPM_CI=1 npm run test:e2e:proxy-lab -- npm run test:e2e:cli
```

To validate against a Salesforce CLI package override, such as the nightly build that carries upcoming credential-redaction behavior:

```bash
npm run test:e2e:proxy-lab:sf-nightly -- npm run test:e2e -- test/e2e/specs/openLogViewer.e2e.spec.ts
```

The standard GitHub Playwright E2E workflow keeps the Ubuntu lane on this MITM proxy lab. The Ubuntu CLI step populates the proxy-lab dependency volume, and the Ubuntu extension step reuses that volume with `ALV_E2E_PROXY_LAB_SKIP_NPM_CI=1`. Windows and macOS lanes run the same real-org CLI and VS Code E2E commands directly on their hosted runners against the scratch-org pool. When telemetry validation is configured, Azure resource resolution and Log Analytics queries stay on the GitHub runner host while the Ubuntu Playwright child run executes inside the MITM proxy lab.

Pool-specific env vars:

- `SF_SCRATCH_POOL_NAME`
- `SF_DEVHUB_AUTH_URL`
- `ALV_E2E_PROXY_LAB_DEVHUB_ALIAS`
- `SF_SCRATCH_POOL_OWNER`
- `SF_SCRATCH_POOL_LEASE_TTL_SECONDS`
- `SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS`
- `SF_SCRATCH_POOL_HEARTBEAT_SECONDS`
- `SF_SCRATCH_POOL_MIN_REMAINING_MINUTES`
- `SF_SCRATCH_POOL_SEED_VERSION`
- `SF_SCRATCH_POOL_SNAPSHOT_NAME`

For the pool bootstrap flow and the stored `sfdxAuthUrl` reuse model, see `docs/SCRATCH_ORG_POOL.md`.

The E2E helpers no longer auto-discover or retry alternate Dev Hub aliases. Missing, invalid, or failing `SF_DEVHUB_AUTH_URL` / `SF_DEVHUB_ALIAS` values now fail the run immediately.

For Dev Hub bootstrap, operational scripts, and GitHub Actions / Codex Cloud setup, see `docs/SCRATCH_ORG_POOL.md`.

Troubleshooting:

- If `npm run test:e2e:cli` reports a missing plugin command, rerun `npm run build:sf-plugin` or let the runner rebuild it for you.
- If the Logs panel shows **“Salesforce CLI not found”**, set the VS Code setting `electivus.apexLogs.cliPath` to the absolute path of your `sf` executable.

- CLI artifacts (screenshots/traces/videos and attached command/stdout/stderr files on failure) are written under `output/playwright-cli/`.
- VS Code Playwright artifacts (screenshots/traces/videos on failure) are written under `output/playwright/`.

### Playwright E2E + dedicated App Insights validation

`npm run test:e2e:telemetry` is the full telemetry-validation path. It:

1. Resolves or creates the dedicated E2E Application Insights component configured for the environment
2. Reuses the existing Log Analytics workspace from the production telemetry resource
3. Injects a test-only telemetry connection string plus a per-run `testRunId`
4. Runs the full Playwright suite
5. Queries `AppEvents` in the linked Log Analytics workspace and fails if the current run's telemetry does not arrive

The Ubuntu lane of `.github/workflows/e2e-playwright.yml` prefers this path automatically when Azure OIDC secrets and the E2E telemetry target variables are configured. If that Azure configuration is incomplete, the workflow still runs `npm run test:e2e`, but skips the telemetry-validation layer. Windows and macOS E2E lanes run direct non-telemetry Playwright validation.

Required Azure targets for the telemetry path:

- Subscription: `<subscription-id>`
- Resource group: `<telemetry-resource-group>`
- Production App Insights (workspace source): `<prod-app-insights-name>`
- E2E App Insights target: `<e2e-app-insights-name>`
- Shared Log Analytics workspace: `<log-analytics-workspace-name>`

Optional overrides:

- `ALV_E2E_TELEMETRY_SUBSCRIPTION`
- `ALV_E2E_TELEMETRY_RESOURCE_GROUP`
- `ALV_E2E_TELEMETRY_LOCATION`
- `ALV_E2E_TELEMETRY_APP`
- `ALV_E2E_TELEMETRY_BASE_APP`
- `ALV_E2E_TELEMETRY_WORKSPACE_RESOURCE_ID`
- `ALV_E2E_TELEMETRY_QUERY_ATTEMPTS`
- `ALV_E2E_TELEMETRY_QUERY_DELAY_MS`
- `ALV_E2E_TELEMETRY_LOOKBACK`

When `ALV_E2E_TELEMETRY_SUBSCRIPTION` is not set, the telemetry runner falls back to `AZURE_SUBSCRIPTION_ID`. The resource group and App Insights names must be provided explicitly through env vars, CI variables, or an internal runbook; the public repo does not keep live Azure defaults.

The runner scopes the workspace query to the E2E component resource id and `testRunId`, so production and E2E telemetry can share the same workspace safely.

Internal env vars used by the test runner:

- `ALV_ENABLE_TEST_TELEMETRY=1`
- `ALV_TEST_TELEMETRY_CONNECTION_STRING`
- `ALV_TEST_TELEMETRY_RUN_ID`

## Debugging

Use the `Extension Tests` launch config. It points to `out/test/runner.js`. Set breakpoints in `src/test/**/*.ts` (VS Code loads the compiled JavaScript).

## Notes

- The runner enforces Mocha UI `tdd` (`suite`/`test`) and loads `out/test/mocha.setup.js` to count executed tests; if zero tests run and `VSCODE_TEST_FAIL_IF_NO_TESTS=1`, the run fails.
- We inject an HTTPS request shim in tests to avoid interference from extension host instrumentation.
- The temporary workspace is deleted after the run.
