# Continuous Integration

This repository uses GitHub Actions to build, test, package, and publish the extension.

- Workflow CI (`.github/workflows/ci.yml`): build/test only on `push` and `pull_request`. Manual `workflow_dispatch` allows choosing the test scope (`unit`, `integration`, or `all`).
- Workflow E2E (`.github/workflows/e2e-playwright.yml`): real scratch-org Playwright validation on `pull_request` and manual dispatch. When Azure OIDC secrets and the E2E telemetry target variables are configured, it runs the full `npm run test:e2e:telemetry` path and validates telemetry by querying `AppEvents` in the linked Log Analytics workspace scoped to the E2E Application Insights component resource. Without that Azure configuration, it falls back to the existing smoke E2E run.
- Workflow Release (`.github/workflows/release.yml`): runs on tag push `v*`. Packages the VSIX and publishes to Marketplace (if `VSCE_PAT` is configured) and Open VSX (if `OVSX_PAT` is configured). Channel is auto‑detected: odd minor → pre‑release; even minor → stable.
- Workflow Pre‑release (`.github/workflows/prerelease.yml`): runs nightly (03:00 UTC) and on manual dispatch. Builds and packages a pre‑release VSIX, creates/updates a GitHub pre‑release and attaches the asset, and publishes automatically to the Marketplace and Open VSX pre‑release channels (when `VSCE_PAT`/`OVSX_PAT` are set).

Build & Test basics:

- Node from `.nvmrc` on `ubuntu-latest` with npm cache.
- `npm ci` → `npm run build` → tests. CI defaults to unit tests on manual runs; Release runs all tests.

Concurrency: Workflows use concurrency groups to avoid duplicate runs per ref.

## E2E Scratch Org Reuse

The Playwright workflow in `.github/workflows/e2e-playwright.yml` reuses a single CI scratch org to avoid exhausting the Salesforce daily scratch-org quota.

Required repository secrets:

- `SF_DEVHUB_AUTH_URL`: authenticates the workflow to the Dev Hub so it can create or recreate the scratch org when reuse is not possible.
- `SF_SCRATCH_CI_SFDX_AUTH_URL`: stores the current `sfdxAuthUrl` for the reusable CI scratch org so GitHub-hosted runners can log back into it.
- `GH_SECRETS_ROTATOR_PAT`: fine-grained PAT with permission to update repository Actions secrets; used to rotate `SF_SCRATCH_CI_SFDX_AUTH_URL` after the scratch org is recreated.

Key behavior:

- The workflow uses a fixed alias, `ALV_E2E_SCRATCH_CI`, so the E2E scratch-org helpers can find and reuse the same org across runs.
- `SF_TEST_KEEP_ORG` is enabled for `pull_request` runs only when reuse is possible (`SF_SCRATCH_CI_SFDX_AUTH_URL` is available) or when the workflow can rotate the auth secret (`GH_SECRETS_ROTATOR_PAT` is configured). This avoids keeping throwaway scratch orgs when reuse bootstrap is unavailable.
- On `workflow_dispatch`, setting `keep_scratch_org=false` forces the scratch org to be deleted after the run even if it was reused, providing a manual reset path for corrupted state.
- A best-effort login step restores the reusable scratch org from `SF_SCRATCH_CI_SFDX_AUTH_URL` before the tests start. If that auth URL is missing or stale, the E2E helpers fall back to creating a new scratch org through the Dev Hub.
- A post-run rotation step refreshes `SF_SCRATCH_CI_SFDX_AUTH_URL` with the current org credentials when the job has access to `GH_SECRETS_ROTATOR_PAT` and the scratch org is intended to be kept.
- The workflow is serialized with `concurrency.group: sf-e2e-scratch-global`, which prevents simultaneous E2E runs from sharing the same org. GitHub Actions still allows one pending run and may replace older pending runs with newer ones, so this protects the org from concurrent access but is not a strict FIFO queue.

Operational note:

- The scratch org is expected to be cleaned and reseeded by the E2E suite itself before each run. Reuse reduces daily org creation but does not replace test-level cleanup.

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

When the three Azure OIDC secrets and the required telemetry target variables are present, the workflow authenticates to Azure, runs `npm run test:e2e:telemetry`, and validates that the current E2E run reached the shared Log Analytics workspace rows for the configured E2E Application Insights component. If any required setting is missing, the workflow still runs, but it intentionally falls back to the smoke-only Playwright path.

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
