# Continuous Integration

This repository uses GitHub Actions to build, test, package, and optionally publish the extension.

- Workflow: `.github/workflows/ci.yml` runs on `push` (to `main`), `pull_request`, manual `workflow_dispatch`, and tags matching `v*`.
- Build & Test: Matrix across `ubuntu-latest`, `macos-latest`, and `windows-latest` on Node 20.
  - Installs dependencies with `npm ci` (with Node/NPM cache enabled).
  - On Linux, installs Electron test dependencies via `scripts/install-linux-deps.sh`.
  - Runs `npm run build` then `npm test` (the test step clears `CI` env to avoid scratch‑org attempts).
- Packaging: For tags `v*`, a `package` job runs `npm run package` and creates a VSIX. The job auto‑detects the release channel:
  - Odd minor (e.g., `0.7.x`) → pre‑release → uses `vsce --pre-release`.
  - Even minor (e.g., `0.6.x`) → stable.
  The uploaded artifact is named `apex-log-viewer-${{ github.ref_name }}-(pre|stable)-vsix`.
- Optional Publish: If the repository/org secret `VSCE_PAT` is set (Marketplace token), the workflow publishes to the Marketplace using the detected channel (stable or pre‑release).
- Concurrency: The workflow cancels in‑progress runs for the same ref to keep results tidy.

## Release Flow

Standard releases are automated with Release Please — do not edit `CHANGELOG.md` or bump versions manually.

1. Merge feature/fix PRs using Conventional Commits (e.g., `feat:`, `fix:`, `docs:`).
2. The `Release Please` workflow opens a release PR that updates version and `CHANGELOG.md`.
3. Review and merge the release PR. On merge, Release Please tags and creates the GitHub Release.
4. CI on the tag builds and (optionally) publishes to Marketplace if `VSCE_PAT` is configured.

Pre‑releases: see `docs/PUBLISHING.md` for options (including using a `Release-As:` footer or odd‑minor pre‑release flow).

See also: `docs/PUBLISHING.md` for the full Marketplace publishing flow and guidance.

## Setup `VSCE_PAT`

- Create a Personal Access Token with publish rights for the Visual Studio Marketplace.
- Add it as a GitHub secret named `VSCE_PAT` in the repository (Settings → Secrets and variables → Actions → New repository secret).
- Publishing is optional; without the secret, the workflow still builds, tests, and attaches the VSIX artifact to the run.

## Release Channels

- Stable: even minor (e.g., `0.2.x`).
- Pre‑release: odd minor (e.g., `0.1.x`).

## Changelog Guard

- CI fails pull requests that modify `CHANGELOG.md` unless they originate from the Release Please bot/branch.
- If your PR needs release notes, express them via Conventional Commits; the changelog will be generated for you.
