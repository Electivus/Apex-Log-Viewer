# Continuous Integration

This repository uses GitHub Actions to build, test, package, and publish the extension.

- Workflow CI (`.github/workflows/ci.yml`): build/test only on `push` and `pull_request`. Manual `workflow_dispatch` allows choosing the test scope (`unit`, `integration`, or `all`). This workflow enforces dependency provenance with `node scripts/check-dependency-sources.mjs` before every `npm ci`, then runs npm registry signature verification (`npm run security:npm-signatures`) before compile/test.
- Workflow Dependency Review (`.github/workflows/dependency-review.yml`): blocks pull requests that introduce new moderate-or-higher dependency risk in runtime or development scopes.
- Workflow E2E (`.github/workflows/e2e-playwright.yml`): real scratch-org Playwright validation on `pull_request` and manual dispatch. This workflow is now pool-only in CI: it requires `SF_SCRATCH_POOL_NAME` plus `SF_DEVHUB_AUTH_URL`, reuses pooled scratch orgs through each slot's stored `sfdxAuthUrl`, and defaults to `7` Playwright workers so the current seven E2E specs can run in parallel. When Azure OIDC secrets and the E2E telemetry target variables are configured, it runs the full `npm run test:e2e:telemetry` path and validates telemetry by querying `AppEvents` in the linked Log Analytics workspace scoped to the E2E Application Insights component resource. Without that Azure configuration, it still runs the full `npm run test:e2e` suite and simply skips the telemetry-validation layer.
- Workflow Release (`.github/workflows/release.yml`): runs on tag push `v*`. Packages the VSIX and publishes to Marketplace (if `VSCE_PAT` is configured) and Open VSX (if `OVSX_PAT` is configured). Channel is auto‑detected: odd minor → pre‑release; even minor → stable.
- Workflow Pre‑release (`.github/workflows/prerelease.yml`): runs nightly (03:00 UTC) and on manual dispatch. Builds and packages a pre‑release VSIX, creates/updates a GitHub pre‑release and attaches the asset, and publishes automatically to the Marketplace and Open VSX pre‑release channels (when `VSCE_PAT`/`OVSX_PAT` are set).
- Workflow Rust CLI Release (`.github/workflows/rust-release.yml`): runs on `rust-v*` tags, publishes the npm meta/native packages and GitHub release assets built from the tested CLI release bundle, and intentionally keeps `crates.io` out of the bootstrap path for now. Required repository secret for the initial CLI publish path is `NPM_TOKEN`.
- The `linux-x64` runtime artifact in that workflow is built from `x86_64-unknown-linux-musl`, which avoids binding the shipped sidecar to the GitHub runner's host `glibc`.
- That workflow installs Ubuntu `musl-tools` and drives Cargo through `musl-gcc`; local Linux maintainers need the equivalent musl compiler package for their distro when building the `linux-x64` runtime with `npm run package:runtime:local`.
- Workflow Rust Supply Chain (`.github/workflows/rust-supply-chain.yml`): runs `cargo deny check advisories bans licenses sources` on pull requests and pushes to `main`.

Build & Test basics:

- Node from `.nvmrc` on `ubuntu-latest` with npm cache.
- `npm ci` → `npm run build` → tests. CI defaults to unit tests on manual runs; Release runs all tests.
- `npm run test:scripts` includes the repository security regression suite plus `node scripts/check-dependency-sources.mjs`, so local script verification catches dependency source drift without waiting for CI.
- Local Rust fast path: `npm run test:rust:smoke` exercises the CLI/app-server smoke layer first (`alv-cli` `cli_smoke` plus `alv-core` `orgs_smoke`) before involving the VS Code host or Playwright.
- Optional Rust acceleration: if `cargo-nextest` is installed, `npm run test:rust` and `npm run test:rust:smoke` prefer it automatically. You can force it with `npm run test:rust:nextest` or `npm run test:rust:smoke:nextest`.
- Extension packaging consumes `config/runtime-bundle.json` so the bundled runtime stays pinned to a tested CLI release instead of building workspace HEAD during extension packaging.
- The Rust workspace supply-chain policy is committed in `deny.toml` and evaluated against the checked-in root `Cargo.lock`.

Concurrency: Workflows use concurrency groups to avoid duplicate runs per ref.

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
- It leases a dedicated org per Playwright worker.
- It defaults to `7` workers so the current seven E2E specs can run in parallel.
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

Key behavior in pool mode:

- `SF_SCRATCH_STRATEGY=pool` and `PLAYWRIGHT_WORKERS` are injected automatically.
- The workflow defaults to `PLAYWRIGHT_WORKERS=7` in pool mode, which matches the current seven Playwright specs and lets CI use one leased scratch org per worker.
- The workflow-level concurrency lock uses a per-ref group whenever `SF_SCRATCH_POOL_NAME` is configured, so concurrent runs can rely on the Dev Hub lease API instead of serializing the whole repository.
- The helper still keeps `fullyParallel: false`, but multiple Playwright workers can now run in parallel because each worker acquires its own scratch org slot.
- Manual `workflow_dispatch` runs use the same pool-only path as `pull_request`, so dispatch validation exercises the same concurrency and lease behavior as CI.

In pool mode, the Dev Hub uses `SF_DEVHUB_AUTH_URL` for create/delete/recreate operations, and each slot reuses its own stored `sfdxAuthUrl` to log back into the scratch org. No custom Connected App or External Client App is required for the pool.

Operational note:

- The scratch org is expected to be cleaned and reseeded by the E2E suite itself before each run. Pooling reduces daily org creation and unlocks worker-level parallelism, but it does not replace test-level cleanup.

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

When the three Azure OIDC secrets and the required telemetry target variables are present, the workflow authenticates to Azure, runs `npm run test:e2e:telemetry`, and validates that the current E2E run reached the shared Log Analytics workspace rows for the configured E2E Application Insights component. If any required setting is missing, the workflow still runs the full Playwright suite and only skips the telemetry-validation layer.

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
