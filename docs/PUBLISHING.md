**Publishing**

This repository includes an automated publish flow for the Visual Studio Code Marketplace with first‑class support for pre‑releases. It uses GitHub Actions and `vsce` and follows a simple semver convention:

- Stable: even minor versions (e.g., 0.6.0, 0.6.1).
- Pre‑release: odd minor versions (e.g., 0.7.0, 0.7.1).

VS Code Marketplace does not use semver pre‑release identifiers in the manifest version. Instead, publishing a pre‑release is signaled via `vsce --pre-release`. Our CI infers the correct channel automatically using the odd/even minor rule, and can also be forced by adding `-pre`, `-beta`, `-alpha`, or `-rc` to the Git tag name.

Prerequisites

- Create a publisher and PAT on the VS Code Marketplace.
- Add the PAT as the repository secret `VSCE_PAT` (Settings → Secrets and variables → Actions).

How it works

- Tags matching `v*` trigger the packaging workflow (`.github/workflows/ci.yml`).
- The workflow reads `package.json` version and determines the channel:
  - Odd minor → pre‑release → `vsce publish --pre-release`.
  - Even minor → stable → `vsce publish`.
- If `VSCE_PAT` is present, it publishes to Marketplace; otherwise it only attaches the `.vsix` artifact to the workflow run.

Quick recipes

- Prepare a stable release (even minor):
  - Update code and `CHANGELOG.md`.
  - Bump to next even minor/patch in `package.json` (e.g., `npm version 0.6.0 --no-git-tag-version`).
  - Commit and push, then create a tag: `git tag v0.6.0 && git push origin v0.6.0`.

- Prepare a pre‑release (odd minor):
  - Update code and `CHANGELOG.md` (note that this is a pre‑release).
  - Bump to the next odd minor/patch in `package.json` (e.g., `npm version 0.7.0 --no-git-tag-version`).
  - Commit and push, then create a tag: `git tag v0.7.0 && git push origin v0.7.0`.
  - Optional: append a suffix to the tag (e.g., `v0.7.0-pre`) to force the pre‑release path regardless of minor parity.

Local packaging/publish

- Package a VSIX (stable): `npm run vsce:package`
- Package a VSIX (pre‑release flag): `npm run vsce:package:pre`
- Publish to Marketplace (stable): `npm run vsce:publish`
- Publish to Marketplace (pre‑release): `npm run vsce:publish:pre`

Notes

- Versions must be unique between stable and pre‑releases; do not re‑use the same `major.minor.patch` for both channels.
- The Marketplace listing for this extension will show a “Pre‑Release” tab for users who opt in to pre‑releases.
- This repo also uses Release Please for automated changelog/version PRs for standard releases. For pre‑releases, you can bump `package.json` manually as shown above or use a `Release-As: x.y.z` footer in a commit if desired.

