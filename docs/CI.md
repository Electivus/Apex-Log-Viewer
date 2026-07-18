# Continuous Integration

This repository uses GitHub Actions to build, test, package, and publish the extension.

- Workflow CI (`.github/workflows/ci.yml`): build/test on `push` and `pull_request` across `ubuntu-latest`, `windows-latest`, and `macos-latest`. Manual `workflow_dispatch` allows choosing the test scope (`unit`, `integration`, or `all`). This workflow enforces dependency provenance with `node scripts/check-dependency-sources.mjs` before every `pnpm install --frozen-lockfile`, then runs npm registry signature verification (`pnpm run security:npm-signatures`) before compile/test. The VSIX smoke test remains Ubuntu-only after the OS matrix succeeds.
- Workflow Dependency Review (`.github/workflows/dependency-review.yml`): blocks pull requests that introduce new moderate-or-higher dependency risk in runtime or development scopes.
- Workflow E2E (`.github/workflows/e2e-playwright.yml`): real scratch-org Playwright validation on `pull_request` and manual dispatch. This workflow is pool-only in CI: it requires `SF_SCRATCH_POOL_NAME` plus `SF_DEVHUB_AUTH_URL`, leases one pooled scratch org per Playwright test through each slot's stored `sfdxAuthUrl`, and defaults to `1` Playwright worker unless `PLAYWRIGHT_WORKERS` is set as a repository variable or `playwright_workers` is set for a manual dispatch. Multiple workflow runs may execute concurrently; the atomic lease service admits work up to the configured slot capacity and makes excess tests wait for a slot. Ubuntu runs one full CLI and extension pass through the MITM proxy lab, while Windows and macOS each run one full direct pass. The direct jobs reuse the dependency, VS Code, and Salesforce CLI caches and build their artifacts in the same job. The Ubuntu extension proxy-lab lane has a dedicated `PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS` override. When Azure telemetry configuration is present, the Ubuntu extension run emits telemetry and a final lightweight job validates it. The stable `Real Org E2E required` gate summarizes all lanes and is a required status check in the active `main` ruleset, so a missing workflow check or startup failure blocks merging. CLI artifacts upload from `output/playwright-cli/`; extension artifacts upload from `output/playwright/`, with OS suffixes for direct Windows/macOS runs.
- Workflow Release (`.github/workflows/release.yml`): runs on tag push `v*`. Packages the VSIX and publishes to Marketplace (if `VSCE_PAT` is configured) and Open VSX (if `OVSX_PAT` is configured). Channel is auto‑detected: odd minor → pre‑release; even minor → stable.
- Workflow Pre‑release (`.github/workflows/prerelease.yml`): runs nightly (03:00 UTC) and on manual dispatch. Builds and packages a pre‑release VSIX, creates/updates a GitHub pre‑release and attaches the asset, and publishes automatically to the Marketplace and Open VSX pre‑release channels (when `VSCE_PAT`/`OVSX_PAT` are set).

Build & Test basics:

- Node from `.nvmrc` and pnpm from the root `packageManager` field on `ubuntu-latest`, `windows-latest`, and `macos-latest`, with the pnpm store cached from `pnpm-lock.yaml`.
- `pnpm install --frozen-lockfile` → `pnpm run build` → tests. CI defaults to unit tests on manual runs; Release runs all tests.
- `pnpm run build` builds `@alv/core`, `@alv/protocol`, the direct-core extension bundle, the webview, and the standalone Salesforce CLI plugin.
- `pnpm run test:scripts` includes the repository security regression suite plus `node scripts/check-dependency-sources.mjs`, so local script verification catches dependency source drift without waiting for CI.
- `pnpm run test:core`, `pnpm run test:protocol`, and `pnpm run test:sf-plugin` cover shared and CLI boundaries; `pnpm run test:extension:node` covers the in-process core client without launching VS Code.
- Extension packaging uses `--no-dependencies`; `@alv/core` is bundled into `dist/extension.js`, and CI rejects an embedded `sf-plugin/` payload in the VSIX smoke path.

Concurrency: Most workflows use concurrency groups to avoid duplicate runs per ref. The real-org Playwright workflow intentionally has no workflow-level concurrency group: its Dev Hub service locks the pool record while atomically assigning a free slot, each test heartbeats and releases its lease, and acquire retries wait when all slots are busy. Pool size therefore controls useful parallelism across workflow runs without allowing two tests to share a scratch org.

## Workflow Supply Chain Controls

- Third-party and GitHub-owned Actions are pinned to full commit SHAs rather
  than mutable tags.
- The repository Actions allowlist must include every pinned third-party action.
  In particular, keep the current `pnpm/action-setup` SHA synchronized with the
  selected-actions policy or workflows will fail before creating jobs.
- Dependency-source policy allows only registry packages and in-repo workspace
  links, and it validates workspace manifests and `pnpm-lock.yaml` before
  dependency install.
- Native pnpm resolution also blocks exotic transitive sources, strictly delays
  regular dependency updates for 24 hours, and rejects registry trust
  downgrades except for reviewed, exact-version lockfile entries.
  Dependabot security updates bypass only the release-age delay so urgent fixes
  can proceed immediately. For Dependabot-authored pull requests, CI sets
  `PNPM_CONFIG_TRUST_LOCKFILE=true` so frozen installs do not reapply that age
  check; Dependabot still applies the trust policy while resolving the lockfile,
  and the source, signature, and dependency-review gates remain active.
- If `pnpm audit signatures` fails in CI, treat it as a provenance problem:
  investigate the package metadata or lockfile change instead of removing the
  gate.

## E2E Scratch Org Strategy

The Playwright workflow in `.github/workflows/e2e-playwright.yml` is pool-only in CI:

- It uses the Dev Hub scratch-org pool.
- It leases a dedicated org per Playwright test within each Playwright job.
- It runs one full test pass per operating system and defaults to `1` worker unless `PLAYWRIGHT_WORKERS` or `playwright_workers` raises it.
- It runs the `sf electivus` real-org suite before the VS Code extension suite on every E2E lane.
- Ubuntu runs those suites through the MITM proxy lab; Windows and macOS run them directly on the hosted runner.
- A final Ubuntu telemetry job runs after the E2E jobs and validates the App Insights events emitted by the Ubuntu extension run when telemetry config is present.
- The final `Real Org E2E required` gate runs with `if: always()` and fails unless the Ubuntu proxy-lab and Windows/macOS direct jobs succeed. Telemetry may either succeed or be safely skipped for a fork. Do not rename this job without updating the required status check in the `main` ruleset.
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
- `PLAYWRIGHT_TIMEOUT_MS` and `PLAYWRIGHT_EXPECT_TIMEOUT_MS` default to `360000` and `60000` in GitHub Actions so stuck tests fail faster than the historical local 15-minute test timeout.
- The Ubuntu CLI real-org step runs `pnpm run test:e2e:cli` through the proxy lab with the same scratch-org env contract as the extension step, then uploads `output/playwright-cli/` as a dedicated artifact.
- The Ubuntu extension step then runs `pnpm run test:e2e` through the proxy lab and uploads `output/playwright/` as a dedicated artifact.
- The final Ubuntu telemetry job waits for both E2E jobs and validates the shared `testRunId` emitted by the Ubuntu extension run without rerunning Playwright.
- The Windows/macOS direct matrix runs one full `pnpm run test:e2e:cli` and `pnpm run test:e2e` pass per OS without proxy-lab, reusing the configured caches and uploading artifacts with OS suffixes such as `playwright-cli-e2e-windows` and `playwright-e2e-macos`.
- Workflow runs are not globally serialized. The pool API atomically assigns distinct slots, and acquire retries wait up to `SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS` when the configured capacity is full.
- The Playwright configs enable `fullyParallel` in pool mode because each test acquires its own scratch org slot; legacy single-scratch mode stays serial.
- Manual `workflow_dispatch` runs use the same pool-only path as `pull_request`, so dispatch validation exercises the same parallel lease behavior as CI.

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

When the three Azure OIDC secrets and the required telemetry target variables are present, the Ubuntu extension job exports a dedicated `testRunId`, runs the full Playwright suite, and emits test telemetry. The final telemetry job authenticates to Azure and validates that the current E2E run reached the shared Log Analytics workspace rows for the configured E2E Application Insights component. If any required setting is missing, the workflow still runs all Playwright suites and only skips the telemetry-validation layer.

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
