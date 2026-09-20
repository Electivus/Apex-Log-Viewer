**Publishing**

Maintainer quick start

1. Configure the Marketplace publisher's dedicated managed identity and GitHub OIDC using [Marketplace authentication](MARKETPLACE_OIDC.md).
2. Create an Open VSX namespace + PAT, add secret `OVSX_PAT` in GitHub.
3. For standard extension releases, update `CHANGELOG.md` manually, bump `apps/vscode-extension/package.json`, and push a tag `vX.Y.Z`.
4. The Release workflow on the tag builds, attaches the `.vsix`, and publishes to Marketplace using OIDC after the `marketplace` environment approval. Open VSX publishing requires `OVSX_PAT`.
5. For plugin-only npm releases, bump `packages/sf-plugin/package.json`, merge the release PR, and push a tag `sf-plugin-vX.Y.Z`; the SF Plugin Release workflow validates, stages, publishes to npm, and creates the GitHub release.
6. Alternatively, publish the extension locally with `pnpm run vsce:publish` (or `:pre`) and `pnpm dlx ovsx publish`.

This repository includes automated publish flows for the Visual Studio Code Marketplace, Open VSX, and the standalone npm plugin. Workspace installation and builds use pnpm.

- Stable: even minor versions (e.g., 0.6.0, 0.6.1).
- Pre‑release: odd minor versions (e.g., 0.7.0, 0.7.1).

VS Code Marketplace does not use semver pre‑release identifiers in the manifest version. Instead, publishing a pre‑release is signaled via `vsce --pre-release`. Our CI infers the correct channel automatically using the odd/even minor rule, and can also be forced by adding `-pre`, `-beta`, `-alpha`, or `-rc` to the Git tag name.

Prerequisites

- Create a VS Code Marketplace publisher and authorize its dedicated managed identity as Contributor.
- Configure the three `MARKETPLACE_AZURE_*` variables in the protected `marketplace` environment; see [Marketplace authentication](MARKETPLACE_OIDC.md).
- Create a namespace + PAT on Open VSX.
- Add the PAT as the repository secret `OVSX_PAT` (Settings → Secrets and variables → Actions).

How it works

- Tags matching `v*` trigger the packaging workflow (`.github/workflows/release.yml`).
- The workflow reads `apps/vscode-extension/package.json` and determines the channel:
  - Odd minor → pre‑release → `vsce publish --pre-release`.
  - Even minor → stable → `vsce publish`.
- Marketplace jobs authenticate with GitHub OIDC and `vsce publish --azure-credential`; missing identity configuration or authorization fails the job instead of silently skipping publication.
- If `OVSX_PAT` is present, it publishes the same VSIX artifacts to Open VSX.
- The extension bundles private `@alv/core` directly and packages with `--no-dependencies`; the VSIX contains no Salesforce CLI plugin runner. The npm plugin is built and released independently over the same core.

Quick recipes

- Prepare a stable release (automated):
  - Merge feature/fix PRs using Conventional Commits.
  - Bump `apps/vscode-extension/package.json` and push tag `vX.Y.Z`; CI builds and publishes.

- Prepare a pre‑release (odd minor channel):
  - Bump `apps/vscode-extension/package.json` to the next odd minor/patch, commit, and tag; CI packages with the pre-release channel.
  - Optional: append a suffix to the tag (e.g., `v0.7.0-pre`) to force the pre‑release path regardless of minor parity.

- Prepare a plugin npm release:
  - Bump `packages/sf-plugin/package.json` when the plugin package is published independently.
  - Open and merge a release PR, then push a matching tag such as `sf-plugin-v0.2.0`.
  - The `.github/workflows/sf-plugin-release.yml` workflow validates that the tag version matches the package manifest, runs `pnpm run test:sf-plugin`, `pnpm run test:sf-plugin:package`, `pnpm run build:sf-plugin`, and `pnpm run stage:sf-plugin-npm`, then publishes the staged package to npm through Trusted Publishing/OIDC.
  - For a manual publication, dispatch the SF Plugin Release workflow with both `--ref sf-plugin-vX.Y.Z` and `-f tag_name=sf-plugin-vX.Y.Z`. The tag must contain this workflow. Branch dispatches are rejected; every job checks out the immutable triggering SHA, so tag input cannot select code to execute in the default branch cache scope.
  - The staging step removes the plugin's workspace-only `private` marker, copies plugin artifacts including the portable `skills/` catalog and offline installation README, and materializes private `@alv/core` under `node_modules/@alv/core` as a bundled dependency.

Local packaging/publish

- Package a VSIX (stable): `pnpm run vsce:package`
- Package a VSIX (pre‑release flag): `pnpm run vsce:package:pre`
- Publish to Marketplace (stable): `pnpm run vsce:publish`
- Publish to Marketplace (pre‑release): `pnpm run vsce:publish:pre`
- These local helpers use the operator's own authentication. CI uses the dedicated federated identity, without a stored PAT.
- Publish to Open VSX (stable): `pnpm dlx ovsx publish --pat <token>`
- Publish to Open VSX (pre‑release): `pnpm dlx ovsx publish --pat <token> --pre-release`

Notes

- `CHANGELOG.md` is manual. Keep entries concise; document breaking changes clearly.
- Versions must be unique between stable and pre‑releases; do not re‑use the same `major.minor.patch` for both channels.
- The Marketplace listing for this extension will show a “Pre‑Release” tab for users who opt in to pre‑releases.
