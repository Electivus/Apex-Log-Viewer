# Continuous Integration

This repository uses GitHub Actions to build, test, package, and publish the extension.

- Workflow CI (`.github/workflows/ci.yml`): build/test only on `push` and `pull_request`. Manual `workflow_dispatch` allows choosing the test scope (`unit`, `integration`, or `all`).
- Workflow release-please (`.github/workflows/release-please.yml`): runs on pushes to `main` and manual dispatch. Uses [googleapis/release-please](https://github.com/googleapis/release-please) to maintain a release PR, update `package.json`/`package-lock.json`, refresh `CHANGELOG.md`, and create GitHub releases and tags automatically once the PR merges.
- Workflow Release (`.github/workflows/release.yml`): runs on tag pushes `v*` and when a GitHub release is published. Packages the VSIX and publishes to Marketplace automatically (if `VSCE_PAT` is configured). Channel is auto‑detected: odd minor → pre‑release; even minor → stable.
- Workflow Pre‑release (`.github/workflows/prerelease.yml`): runs nightly (03:00 UTC) and on manual dispatch. Builds and packages a pre‑release VSIX, creates/updates a GitHub pre‑release and attaches the asset, and publishes automatically to the Marketplace pre‑release channel (when `VSCE_PAT` is set).

Build & Test basics:

- Node 20 on `ubuntu-latest` with npm cache.
- `npm ci` → `npm run build` → tests. CI defaults to unit tests on manual runs; Release runs all tests.

Concurrency: Workflows use concurrency groups to avoid duplicate runs per ref.

## Release Flow

Standard releases are driven by the release-please workflow.

1. Merge PRs using Conventional Commits (e.g., `feat:`, `fix:`, `docs:`).
2. Dispatch `release-please` (or wait for the next push to `main`) to refresh the automated release PR.
3. Review and merge the release PR that bumps version + changelog. The merge commit is conventional (`chore: release X.Y.Z`) so it passes PR checks.
4. Once merged, the workflow creates a GitHub release, tag (`vX.Y.Z`), and curated release notes automatically.
5. The Release workflow (triggered by the new tag/release) packages and publishes to the Marketplace automatically when `VSCE_PAT` is configured.

Pre‑releases: nightly builds run daily and are published automatically to the Marketplace pre‑release channel when `VSCE_PAT` is configured; the VSIX is also attached to a GitHub pre‑release. release-please will default to bumping the patch version within the active minor; trigger the workflow after merging pre-release scoped work to generate the next candidate.

See also: `docs/PUBLISHING.md` for the full Marketplace publishing flow and guidance.

## Setup `VSCE_PAT`

- Create a Personal Access Token with publish rights for the Visual Studio Marketplace.
- Add it as a GitHub secret named `VSCE_PAT` in the repository (Settings → Secrets and variables → Actions → New repository secret).
- Publishing is optional; without the secret, the workflow still builds, tests, and attaches the VSIX artifact to the run.

## Release Channels

- Stable: even minor (e.g., `0.2.x`).
- Pre‑release: odd minor (e.g., `0.1.x`).

## Changelog

- Updated automatically by release-please in the generated release PR. Add hand-written context there if needed before merging.
