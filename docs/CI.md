# Continuous Integration

This repository uses GitHub Actions to build, test, package, and publish the extension.

- Workflow CI (`.github/workflows/ci.yml`): build/test only on `push` and `pull_request`. Manual `workflow_dispatch` allows choosing the test scope (`unit`, `integration`, or `all`).
- Workflow Release (`.github/workflows/release.yml`): runs on tag push `v*`. Packages the VSIX and publishes to Marketplace automatically (if `VSCE_PAT` is configured). Channel is auto‑detected: odd minor → pre‑release; even minor → stable.
- Workflow Pre‑release (`.github/workflows/prerelease.yml`): runs nightly (03:00 UTC) and on manual dispatch. Builds and packages a pre‑release VSIX, creates/updates a GitHub pre‑release and attaches the asset, and publishes automatically to the Marketplace pre‑release channel (when `VSCE_PAT` is set).

Build & Test basics:

- Node 20 on `ubuntu-latest` with npm cache.
- `npm ci` → `npm run build` → tests. CI defaults to unit tests on manual runs; Release runs all tests.

Concurrency: Workflows use concurrency groups to avoid duplicate runs per ref.

## Release Flow

Standard releases are driven by git tags `v*`.

1. Merge PRs using Conventional Commits (e.g., `feat:`, `fix:`, `docs:`).
2. Bump the version in `package.json` and push a tag `vX.Y.Z` for that commit.
3. On tag push, the Release workflow packages and publishes to the Marketplace automatically (when `VSCE_PAT` is configured).
4. The changelog (`CHANGELOG.md`) is maintained manually. Update it as part of preparing the release commit.

Pre‑releases: nightly builds run daily and are published automatically to the Marketplace pre‑release channel when `VSCE_PAT` is configured; the VSIX is also attached to a GitHub pre‑release.

See also: `docs/PUBLISHING.md` for the full Marketplace publishing flow and guidance.

## Setup `VSCE_PAT`

- Create a Personal Access Token with publish rights for the Visual Studio Marketplace.
- Add it as a GitHub secret named `VSCE_PAT` in the repository (Settings → Secrets and variables → Actions → New repository secret).
- Publishing is optional; without the secret, the workflow still builds, tests, and attaches the VSIX artifact to the run.

## Release Channels

- Stable: even minor (e.g., `0.2.x`).
- Pre‑release: odd minor (e.g., `0.1.x`).

## Changelog

- Maintained manually in `CHANGELOG.md`. Follow SemVer and include notable changes and any BREAKING CHANGES.
