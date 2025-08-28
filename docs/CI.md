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

1. Bump version in `package.json`, update `CHANGELOG.md`.
2. Create and push a tag like `v0.0.4` to trigger packaging (and publish if `VSCE_PAT` is present).
   - Example: `git tag v0.0.4 && git push origin v0.0.4`.
3. Download the built `.vsix` from the workflow artifacts when needed.

See also: `docs/PUBLISHING.md` for the full Marketplace publishing flow and guidance.

## Setup `VSCE_PAT`

- Create a Personal Access Token with publish rights for the Visual Studio Marketplace.
- Add it as a GitHub secret named `VSCE_PAT` in the repository (Settings → Secrets and variables → Actions → New repository secret).
- Publishing is optional; without the secret, the workflow still builds, tests, and attaches the VSIX artifact to the run.

## Release Channels

- Stable: even minor (e.g., `0.2.x`).
- Pre‑release: odd minor (e.g., `0.1.x`).

