**Publishing**

Maintainer quick start

1. Create a Marketplace publisher and PAT, add secret `VSCE_PAT` in GitHub.
2. Create an Open VSX namespace + PAT, add secret `OVSX_PAT` in GitHub.
3. For standard extension releases, update `CHANGELOG.md` manually, bump `apps/vscode-extension/package.json`, and push a tag `vX.Y.Z`.
4. The Release workflow on the tag builds, attaches the `.vsix`, and, if `VSCE_PAT`/`OVSX_PAT` exist, publishes automatically.
5. For plugin-only npm releases, bump `packages/sf-plugin/package.json`, merge the release PR, and push a tag `sf-plugin-vX.Y.Z`; the SF Plugin Release workflow validates, stages, publishes to npm, and creates the GitHub release.
6. Alternatively, publish the extension locally with `pnpm run vsce:publish` (or `:pre`) and `pnpm dlx ovsx publish`.

IntelliJ plugin release

The IntelliJ plugin has an independent signed artifact lane and is not uploaded to JetBrains Marketplace automatically.

1. Update `apps/intellij-plugin/build.gradle.kts` and `CHANGELOG.md` in a release PR.
2. Configure protected GitHub secrets `INTELLIJ_CERTIFICATE_CHAIN`, `INTELLIJ_PRIVATE_KEY`, and `INTELLIJ_PRIVATE_KEY_PASSWORD` with the long-lived Electivus signing identity, and keep the repository ruleset for `intellij-v*` tags immutable against update or deletion.
3. On the exact candidate commit, complete real-org validation on Linux, Windows, and macOS plus the installed IntelliJ IDEA Ultimate 2026.2 UI smoke checklist. After reviewing that evidence, an approver sets the protected `intellij-release` environment variable `INTELLIJ_RELEASE_CANDIDATE_SHA` to that commit SHA.
4. Merge the release PR and create a matching stable tag such as `intellij-v1.0.0`. Versions below 1.0.0 are development artifacts and the release workflow rejects them.
5. `.github/workflows/intellij-plugin-release.yml` validates the tag and candidate SHA, runs the dual-runtime corpus and plugin tests on Linux, Windows, and macOS, verifies IntelliJ IDEA 2026.1 and 2026.2 compatibility, signs the ZIP, and attaches it to a GitHub release.
6. Reinstall that signed ZIP into IntelliJ IDEA Ultimate 2026.2 for a final signature-preserving smoke check before manually submitting the same artifact to JetBrains Marketplace.

Local development builds and pull requests require no signing secrets. `buildPlugin` produces an unsigned development ZIP; `verifyPlugin` checks both supported IDE lines. The release workflow intentionally has no Marketplace token or publication step.

Installed IntelliJ smoke checklist

Record the candidate SHA, signed ZIP SHA-256, OS, exact IDEA build, redacted org alias, tester, and outcome for each run.

1. Install the signed ZIP into a clean IDEA 2026.2 profile and confirm that enable, disable, and re-enable complete without startup errors.
2. Open a Salesforce workspace, select an authenticated org, refresh Logs, and verify metadata columns, pagination, sorting, raw opening, and Parsed Viewer navigation.
3. Enter a three-or-more-character query, verify the 750 ms delayed progressive search, cancel it, retry it, and use Continue Search to retrieve the next bounded pass without duplicates.
4. Open a marker-bearing external `.log` explicitly in the Parsed Viewer and confirm that an unrelated or oversized file is rejected.
5. With Illuminated Cloud 2 installed, send a locally materialized log to replay and confirm that IC2 receives the active Project and VirtualFile; repeat without IC2 and verify the localized recovery message.
6. Confirm Download All asks for approval, cancellation stops further acquisition, diagnostics contain no credentials or log bodies, and no telemetry request is emitted.

Rollback and rebuild

- Before Marketplace submission, stop the release and retain the signed candidate as evidence; do not upload a known-bad artifact.
- After submission, hide or unpublish the affected Marketplace version when policy permits and direct users to the last known-good signed ZIP.
- Never rebuild a published version in place. Fix from the tagged source, increment the patch version, repeat the exact-SHA matrix, signing, signature verification, and installed smoke checklist, then publish the replacement artifact.

This repository includes automated publish flows for the Visual Studio Code Marketplace, Open VSX, and the standalone npm plugin. Workspace installation and builds use pnpm.

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
- The workflow reads `apps/vscode-extension/package.json` and determines the channel:
  - Odd minor → pre‑release → `vsce publish --pre-release`.
  - Even minor → stable → `vsce publish`.
- If `VSCE_PAT` is present, it publishes to Marketplace; otherwise it only attaches the `.vsix` artifact to the workflow run.
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
  - The `.github/workflows/sf-plugin-release.yml` workflow validates that the tag version matches the package manifest, runs `pnpm run test:sf-plugin`, `pnpm run build:sf-plugin`, and `pnpm run stage:sf-plugin-npm`, then publishes the staged package to npm through Trusted Publishing/OIDC.
  - For an existing tag that predates the workflow, rerun the SF Plugin Release workflow manually with the `tag_name` input.
  - The staging step removes the plugin's workspace-only `private` marker, copies plugin artifacts, and materializes private `@alv/core` under `node_modules/@alv/core` as a bundled dependency.

Local packaging/publish

- Package a VSIX (stable): `pnpm run vsce:package`
- Package a VSIX (pre‑release flag): `pnpm run vsce:package:pre`
- Publish to Marketplace (stable): `pnpm run vsce:publish`
- Publish to Marketplace (pre‑release): `pnpm run vsce:publish:pre`
- Publish to Open VSX (stable): `pnpm dlx ovsx publish --pat <token>`
- Publish to Open VSX (pre‑release): `pnpm dlx ovsx publish --pat <token> --pre-release`

Notes

- `CHANGELOG.md` is manual. Keep entries concise; document breaking changes clearly.
- Versions must be unique between stable and pre‑releases; do not re‑use the same `major.minor.patch` for both channels.
- The Marketplace listing for this extension will show a “Pre‑Release” tab for users who opt in to pre‑releases.
