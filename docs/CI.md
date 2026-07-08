# Continuous Integration

This repository uses GitHub Actions to build, test, package, and publish the extension.

- Workflow CI (`.github/workflows/ci.yml`): build/test on `push` and `pull_request` across `ubuntu-latest`, `windows-latest`, and `macos-latest`. Manual `workflow_dispatch` allows choosing the test scope (`unit`, `integration`, or `all`). This workflow enforces dependency provenance with `node scripts/check-dependency-sources.mjs` before every `npm ci`, then runs npm registry signature verification (`npm run security:npm-signatures`) before compile/test. The VSIX smoke test remains Ubuntu-only after the OS matrix succeeds.
- Workflow Dependency Review (`.github/workflows/dependency-review.yml`): blocks pull requests that introduce new moderate-or-higher dependency risk in runtime or development scopes.
- Workflow E2E (`.github/workflows/e2e-playwright.yml`): real scratch-org Playwright validation on `pull_request` and manual dispatch. This workflow is pool-only in CI: it requires `SF_SCRATCH_POOL_NAME` plus `SF_DEVHUB_AUTH_URL`, leases one pooled scratch org per Playwright test through each slot's stored `sfdxAuthUrl`, and defaults to `1` Playwright worker unless `PLAYWRIGHT_WORKERS` is set as a repository variable or `playwright_workers` is set for a manual dispatch. Ubuntu keeps the full MITM proxy-lab path and runs both real-org surfaces in order across four Playwright shards: `npm run test:e2e:cli` for the `sf electivus` plugin, then `npm run test:e2e` for the VS Code extension flow. The Ubuntu extension proxy-lab lane has a dedicated `PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS` override because that path exercises VS Code/Electron inside Docker. Windows and macOS run the same CLI and VS Code E2E suites directly against the scratch-org pool, without Docker/proxy-lab, also across four shards. After those sharded jobs pass, a final non-sharded Ubuntu telemetry job runs `npm run test:e2e:telemetry` through the proxy lab when Azure OIDC secrets and the E2E telemetry target variables are configured. CLI artifacts upload from `output/playwright-cli/`; extension artifacts upload from `output/playwright/`, with OS and shard suffixes for direct Windows/macOS runs.
- Workflow Release (`.github/workflows/release.yml`): runs on tag push `v*`. Packages the VSIX and publishes to Marketplace (if `VSCE_PAT` is configured) and Open VSX (if `OVSX_PAT` is configured). Channel is auto‑detected: odd minor → pre‑release; even minor → stable.
- Workflow Pre‑release (`.github/workflows/prerelease.yml`): runs nightly (03:00 UTC) and on manual dispatch. Builds and packages a pre‑release VSIX, creates/updates a GitHub pre‑release and attaches the asset, and publishes automatically to the Marketplace and Open VSX pre‑release channels (when `VSCE_PAT`/`OVSX_PAT` are set).

Build & Test basics:

- Node from `.nvmrc` on `ubuntu-latest`, `windows-latest`, and `macos-latest` with npm cache.
- `npm ci` → `npm run build` → tests. CI defaults to unit tests on manual runs; Release runs all tests.
- `npm run build` runs `npm run build:sf-plugin`, `npm run build:embedded-sf-plugin`, copies tree-sitter/ripgrep/package metadata, bundles the extension host, and builds the webview.
- `npm run test:scripts` includes the repository security regression suite plus `node scripts/check-dependency-sources.mjs`, so local script verification catches dependency source drift without waiting for CI.
- `npm run test:sf-plugin` runs the plugin's Node test lane; `npm run test:extension:node` covers the extension-side plugin client without launching VS Code.
- Extension packaging always includes `apps/vscode-extension/sf-plugin/electivus-runner.cjs`; release/pre-release workflows build it before target VSIX packaging.

Concurrency: Workflows use concurrency groups to avoid duplicate runs per ref, except the real-org Playwright workflow when `SF_SCRATCH_POOL_NAME` is configured. That workflow keys concurrency by scratch-org pool name with `cancel-in-progress: false` so active E2E runs are not canceled by dependency bursts or allowed to over-lease the shared Dev Hub pool.

## Workflow Supply Chain Controls

- Third-party and GitHub-owned Actions are pinned to full commit SHAs rather
  than mutable tags.
- Dependency-source policy allows only registry packages, in-repo workspace
  links, plus the explicit pinned `tree-sitter-sfapex` git exception, and it
  validates both manifests and `package-lock.json` before dependency install.
- If `npm audit signatures` fails in CI, treat it as a provenance problem:
  investigate the package metadata or lockfile change instead of removing the
  gate.

## E2E Scratch Org Strategy

The Playwright workflow in `.github/workflows/e2e-playwright.yml` is pool-only in CI:

- It uses the Dev Hub scratch-org pool.
- It leases a dedicated org per Playwright test within each sharded Playwright job.
- It defaults to four shards with `1` worker per shard on PR runs unless `PLAYWRIGHT_WORKERS` or `playwright_workers` raises per-shard workers.
- It runs the `sf electivus` real-org suite before the VS Code extension suite on every E2E lane.
- Ubuntu runs those suites through the MITM proxy lab; Windows and macOS run them directly on the hosted runner.
- A final non-sharded Ubuntu telemetry job runs after the sharded jobs and performs the dedicated App Insights validation when telemetry config is present.
- It fails fast when the pool configuration is incomplete instead of falling back to the legacy single-scratch CI path.

### Pool mode

Required repository secrets:

- `SF_DEVHUB_AUTH_URL`

Required repository variables:

- `SF_SCRATCH_POOL_NAME`

Optional repository variables:

- `SF_SCRATCH_POOL_LEASE_TTL_SECONDS`
- `SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS`
- `SF_SCRATCH_POOL_HEARTBEAT_SECONDS`
- `SF_SCRATCH_POOL_MIN_REMAINING_MINUTES`
- `SF_SCRATCH_POOL_SEED_VERSION`
- `SF_SCRATCH_POOL_SNAPSHOT_NAME`
- `PLAYWRIGHT_WORKERS`
- `PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS`
- `PLAYWRIGHT_RETRIES`
- `PLAYWRIGHT_TIMEOUT_MS`
- `PLAYWRIGHT_EXPECT_TIMEOUT_MS`
- `VSCODE_TEST_VERSION`

Key behavior in pool mode:

- `SF_SCRATCH_STRATEGY=pool` and `PLAYWRIGHT_WORKERS` are injected automatically.
- The workflow defaults to `PLAYWRIGHT_WORKERS=1` in pool mode; repository variables can override it for pull requests, and manual dispatch can override it with the `playwright_workers` input.
- The Ubuntu extension proxy-lab step defaults to `PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS=1` and can be raised independently of the CLI and direct Windows/macOS lanes.
- `PLAYWRIGHT_SHARD` is injected from the GitHub Actions matrix as `1/4`, `2/4`, `3/4`, or `4/4`; the local runner scripts translate it to Playwright's `--shard` flag.
- `PLAYWRIGHT_TIMEOUT_MS` and `PLAYWRIGHT_EXPECT_TIMEOUT_MS` default to `360000` and `60000` in GitHub Actions so stuck tests fail faster than the historical local 15-minute test timeout.
- The Ubuntu CLI real-org step runs `npm run test:e2e:cli` through the proxy lab with the same scratch-org env contract as the extension step, then uploads `output/playwright-cli/` as a dedicated shard artifact.
- The Ubuntu extension step then runs `npm run test:e2e` through the proxy lab and uploads `output/playwright/` as a dedicated shard artifact.
- The final Ubuntu telemetry job waits for both sharded E2E jobs, runs without `PLAYWRIGHT_SHARD`, and uses `npm run test:e2e:telemetry` to generate and validate a dedicated `testRunId` after the faster shard coverage has completed.
- The Windows/macOS direct matrix runs `npm run test:e2e:cli` and `npm run test:e2e` without proxy-lab, then uploads artifacts with OS and shard suffixes such as `playwright-cli-e2e-windows-shard-1` and `playwright-e2e-macos-shard-4`.
- The workflow-level concurrency lock uses the configured `SF_SCRATCH_POOL_NAME` when pool mode is active, with `cancel-in-progress: false`, so active runs sharing the same Dev Hub pool are not canceled or allowed to over-lease the pool during dependency bursts.
- The Playwright configs enable `fullyParallel` in pool mode because each test acquires its own scratch org slot; legacy single-scratch mode stays serial.
- Manual `workflow_dispatch` runs use the same pool-only path as `pull_request`, so dispatch validation exercises the same concurrency and lease behavior as CI.

In pool mode, the Dev Hub uses `SF_DEVHUB_AUTH_URL` for create/delete/recreate operations, and each slot reuses its own stored `sfdxAuthUrl` to log back into the scratch org. No custom Connected App or External Client App is required for the pool.

Operational note:

- Each scratch org is expected to be cleaned and reseeded by the E2E test that uses it. Pooling reduces daily org creation and unlocks test-level parallelism, but it does not replace test-level cleanup.

See also: `docs/SCRATCH_ORG_POOL.md`.

## Setup Azure OIDC for E2E Telemetry Validation

The telemetry-aware Playwright workflow uses `azure/login@v3` with GitHub OIDC. Configure these repository secrets:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

Configure these repository variables:

- `ALV_E2E_TELEMETRY_RESOURCE_GROUP`
- `ALV_E2E_TELEMETRY_LOCATION`
- `ALV_E2E_TELEMETRY_APP`
- `ALV_E2E_TELEMETRY_BASE_APP`
- `ALV_E2E_TELEMETRY_WORKSPACE_RESOURCE_ID` (optional)

When the three Azure OIDC secrets and the required telemetry target variables are present, the workflow authenticates to Azure in the final telemetry job, runs `npm run test:e2e:telemetry` without a shard, and validates that the current E2E run reached the shared Log Analytics workspace rows for the configured E2E Application Insights component. If any required setting is missing, the workflow still runs the sharded Playwright suites and only skips the telemetry-validation layer.

## Release Flow

Standard releases are driven by git tags `v*`.

1. Merge PRs using Conventional Commits (e.g., `feat:`, `fix:`, `docs:`).
2. Bump the version in `package.json` and push a tag `vX.Y.Z` for that commit.
3. On tag push, the Release workflow packages and publishes to the Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`) automatically.
4. The changelog (`CHANGELOG.md`) is maintained manually. Update it as part of preparing the release commit.

Pre‑releases: nightly builds run daily and are published automatically to the Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`) pre‑release channels; the VSIX is also attached to a GitHub pre‑release.

See also: `docs/PUBLISHING.md` for the full Marketplace/Open VSX publishing flow and guidance.

## Setup `VSCE_PAT`

- Create a Personal Access Token with publish rights for the Visual Studio Marketplace.
- Add it as a GitHub secret named `VSCE_PAT` in the repository (Settings → Secrets and variables → Actions → New repository secret).
- Publishing is optional; without the secret, the workflow still builds, tests, and attaches the VSIX artifact to the run.

## Setup `OVSX_PAT`

- Create a Personal Access Token with publish rights for your Open VSX namespace.
- Add it as a GitHub secret named `OVSX_PAT` in the repository (Settings → Secrets and variables → Actions → New repository secret).
- Publishing is optional; without the secret, the workflow still builds, tests, and attaches the VSIX artifact to the run.

## Release Channels

- Stable: even minor (e.g., `0.2.x`).
- Pre‑release: odd minor (e.g., `0.1.x`).

## Changelog

- Maintained manually in `CHANGELOG.md`. Follow SemVer and include notable changes and any BREAKING CHANGES.
