**Publishing**

Maintainer quick start

1. Create a Marketplace publisher and PAT, add secret `VSCE_PAT` in GitHub.
2. Create an Open VSX namespace + PAT, add secret `OVSX_PAT` in GitHub.
3. For standard releases, update `CHANGELOG.md` manually, bump `package.json`, and push a tag `vX.Y.Z`.
4. The Release workflow on the tag builds, attaches the `.vsix`, and—if `VSCE_PAT`/`OVSX_PAT` exist—publishes automatically.
5. Alternatively, publish locally with `npm run vsce:publish` (or `:pre`) and `npx --yes ovsx publish`.

This repository includes automated publish flows for the Visual Studio Code Marketplace and Open VSX with first‑class support for pre‑releases. It uses GitHub Actions, `vsce`, and `ovsx` and follows a simple semver convention:

- Stable: even minor versions (e.g., 0.6.0, 0.6.1).
- Pre‑release: odd minor versions (e.g., 0.7.0, 0.7.1).

VS Code Marketplace does not use semver pre‑release identifiers in the manifest version. Instead, publishing a pre‑release is signaled via `vsce --pre-release`. Our CI infers the correct channel automatically using the odd/even minor rule, and can also be forced by adding `-pre`, `-beta`, `-alpha`, or `-rc` to the Git tag name.

Prerequisites

- Create a publisher and PAT on the VS Code Marketplace.
- Add the PAT as the repository secret `VSCE_PAT` (Settings → Secrets and variables → Actions).
- Create a namespace + PAT on Open VSX.
- Add the PAT as the repository secret `OVSX_PAT` (Settings → Secrets and variables → Actions).

How it works

- Tags matching `v*` trigger the packaging workflow (`.github/workflows/release.yml`).
- The workflow reads `package.json` version and determines the channel:
  - Odd minor → pre‑release → `vsce publish --pre-release`.
  - Even minor → stable → `vsce publish`.
- If `VSCE_PAT` is present, it publishes to Marketplace; otherwise it only attaches the `.vsix` artifact to the workflow run.
- If `OVSX_PAT` is present, it publishes the same VSIX artifacts to Open VSX.


Quick recipes

- Prepare a stable release (automated):
  - Merge feature/fix PRs using Conventional Commits.
  - Bump `package.json` and push tag `vX.Y.Z`; CI builds and publishes.

- Prepare a pre‑release (odd minor channel):
  - Bump `package.json` to the next odd minor/patch, commit, and tag (e.g., `v0.7.0`); CI will package/publish using the pre‑release channel.
  - Optional: append a suffix to the tag (e.g., `v0.7.0-pre`) to force the pre‑release path regardless of minor parity.

Local packaging/publish

- Package a VSIX (stable): `npm run vsce:package`
- Package a VSIX (pre‑release flag): `npm run vsce:package:pre`
- Publish to Marketplace (stable): `npm run vsce:publish`
- Publish to Marketplace (pre‑release): `npm run vsce:publish:pre`
- Publish to Open VSX (stable): `npx --yes ovsx publish --pat <token>`
- Publish to Open VSX (pre‑release): `npx --yes ovsx publish --pat <token> --pre-release`

Notes

- `CHANGELOG.md` is manual. Keep entries concise; document breaking changes clearly.
- Versions must be unique between stable and pre‑releases; do not re‑use the same `major.minor.patch` for both channels.
- The Marketplace listing for this extension will show a “Pre‑Release” tab for users who opt in to pre‑releases.
