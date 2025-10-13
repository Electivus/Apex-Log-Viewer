**Publishing**

Maintainer quick start

1. Create a Marketplace publisher and PAT, add secret `VSCE_PAT` in GitHub.
2. Run the `release-please` workflow (or wait for the next push to `main`) to refresh the automated release PR.
3. Review and merge the release PR; it bumps `package.json`/`package-lock.json`, updates `CHANGELOG.md`, and sets the release notes.
4. The merge triggers release-please to publish a GitHub release + tag, which in turn executes the Release workflow that packages and—if `VSCE_PAT` exists—publishes automatically.
5. Alternatively, publish locally with `npm run vsce:publish` (or `:pre`).

This repository includes an automated publish flow for the Visual Studio Code Marketplace with first‑class support for pre‑releases. It uses GitHub Actions and `vsce` and follows a simple semver convention:

- Stable: even minor versions (e.g., 0.6.0, 0.6.1).
- Pre‑release: odd minor versions (e.g., 0.7.0, 0.7.1).

VS Code Marketplace does not use semver pre‑release identifiers in the manifest version. Instead, publishing a pre‑release is signaled via `vsce --pre-release`. Our CI infers the correct channel automatically using the odd/even minor rule, and can also be forced by adding `-pre`, `-beta`, `-alpha`, or `-rc` to the Git tag name.

Prerequisites

- Create a publisher and PAT on the VS Code Marketplace.
- Add the PAT as the repository secret `VSCE_PAT` (Settings → Secrets and variables → Actions).

How it works

- Pushes to `main` (and manual dispatch) run `.github/workflows/release-please.yml`, which keeps a single open release PR using [release-please](https://github.com/googleapis/release-please). When that PR merges, it creates a GitHub release + tag.
- GitHub releases/tags (`v*`) trigger the packaging workflow (`.github/workflows/release.yml`).
- The packaging workflow reads `package.json` version and determines the channel:
  - Odd minor → pre‑release → `vsce publish --pre-release`.
  - Even minor → stable → `vsce publish`.
- If `VSCE_PAT` is present, it publishes to Marketplace; otherwise it only attaches the `.vsix` artifact to the workflow run.

Quick recipes

- Prepare a stable release (automated):
  - Merge feature/fix PRs using Conventional Commits.
  - Dispatch `release-please` (or wait for the next push); merge the release PR once it looks good. CI creates the release/tag and publishes.

- Prepare a pre‑release (odd minor channel):
  - Ensure the current minor is odd (e.g., `0.15.x`). If not, merge a PR that bumps the minor via release-please inputs (`release-as`) or by landing a manual version bump before triggering the workflow.
  - Dispatch `release-please` with `release-as` (if you need to force a specific version) and merge the generated PR. The packaging workflow will publish using the pre-release channel.

Local packaging/publish

- Package a VSIX (stable): `npm run vsce:package`
- Package a VSIX (pre‑release flag): `npm run vsce:package:pre`
- Publish to Marketplace (stable): `npm run vsce:publish`
- Publish to Marketplace (pre‑release): `npm run vsce:publish:pre`

Notes

- `CHANGELOG.md` and version bumps are automated in the release PR; add any editorial tweaks there before merging.
- Versions must be unique between stable and pre‑releases; do not re‑use the same `major.minor.patch` for both channels.
- The Marketplace listing for this extension will show a “Pre‑Release” tab for users who opt in to pre‑releases.
