# Repository Guidelines

## Scope

- This file defines guidance for the whole repository.

## Project Structure

- `apps/vscode-extension/` contains the VS Code extension host, extension-only adapters under `src/host`, tests, packaging scripts, and bundled media.
- `packages/core/` contains the private Salesforce and local-log business core shared by both product surfaces.
- `packages/protocol/` contains the private, VS Code-free extension/webview message contract.
- `packages/webview/` contains the webview React UI.
- `packages/sf-plugin/` contains class-per-command Salesforce CLI adapters.
- `test/e2e/` contains Playwright scratch-org E2E specs, fixtures, and utilities.
- `config/` holds scratch-org configuration.
- `docs/` holds architecture/testing/publishing notes and plan docs.
- `scripts/` contains build/test helper scripts.
- `skills/` contains the neutral, portable Agent Skills catalog; `apex-log-viewer-cli` can be installed through the standard `skills` CLI or the offline Salesforce plugin installer.

## Shared Runtime Strategy

- Treat the VS Code extension and Salesforce CLI plugin as separate adapters over private `@alv/core`.
- Implement shared behavior in `packages/core` without VS Code or oclif dependencies, then expose it through a class-per-command `sf electivus ...` adapter and the extension's in-process core client.
- The extension bundles `@alv/core` into `dist/extension.js`; never add an embedded plugin runner or a child-process command bridge.
- Keep webview messages and UI-safe DTOs in `packages/protocol`; do not import VS Code there.
- For Logs and Tail, use the single rebindable Webview Session in `apps/vscode-extension/src/provider/webviewSession.ts` for host binding, delayed mount/readiness, visibility, classified delivery, latest-snapshot replay, retries, generation safety, detach/disposal, and mechanical diagnostics; do not recreate those mechanics in providers.
- Keep presentation, authoritative replay snapshots, bootstrap/refresh policy, validated interactions, workflow errors, and surface diagnostics in the Logs/Tail providers. Let host adapters expose remount/replacement capabilities instead of adding panel/sidebar identity branches to Webview Session.
- For log-local workflows, treat the org-first `apexlogs/orgs/<safe-org>/logs/...` layout as the canonical structure while preserving the existing `<safeUser>_<logId>.log` files for backward compatibility; during the transition both layouts may coexist, but avoid introducing additional cache layouts.
- Treat `apexlogs/.alv/sync-state.json` as the shared incremental-sync contract for both surfaces; preserve backward-readable state fields and avoid breaking extension or CLI consumers when evolving it.
- When a CLI flag overlaps with familiar Salesforce CLI behavior, prefer the `sf`-style spelling such as `--target-org`.
- Keep the portable `skills/` catalog as the only Agent Skill source. Bundle it in the npm plugin for offline installation through `sf electivus skill install`; keep installation mechanics in the CLI adapter, with explicit agent/destination selection and no network or agent-home writes during npm installation.

## Build and Development

- Use Node `24` via `.nvmrc` for CI and default development.
- For explicitly configured native Arch Linux / WSL2 E2E, use the Node 24 runtime selected in the shell (fnm, another manager or system installation), at or above the `.nvmrc` release; follow `docs/E2E_ARCH_WSL.md` when preparing or running that environment. Keep the CI runtime pinned to the exact `.nvmrc` release.
- Install deps with `pnpm install --frozen-lockfile`.
- Clean generated outputs with `pnpm run clean`.
- Type-check only with `pnpm run check-types`.
- Lint with `pnpm run lint`.
- Format with `pnpm run format`.
- Lint + extension TypeScript validation with `pnpm run compile`.
- Build with `pnpm run build`.
- Build the Salesforce CLI plugin with `pnpm run build:sf-plugin`.
- Build the shared packages with `pnpm run build:shared`.
- Build only the extension host bundle with `pnpm run build:extension`.
- Build only the webview bundle and CSS with `pnpm run build:webview`.
- Prepare a publishable package with `pnpm run package`.
- Watch mode: `pnpm run watch`.
- Extension-only watch: `pnpm run watch:extension`.
- Webview-only watch: `pnpm run watch:webview`.
- Compile extension tests with `pnpm run compile-tests`.
- Watch extension tests with `pnpm run watch-tests`.
- Default local test command: `pnpm test`.
- Node-only extension suite: `pnpm run test:extension:node`.
- Shared package and plugin suites: `pnpm run test:core`, `pnpm run test:protocol`, and `pnpm run test:sf-plugin`.
- Core public-contract scenarios: `pnpm run test:conformance` (also included in `test:core`).
- E2E utility Jest suite: `pnpm run test:e2e:utils`.
- Script/security regression suite: `pnpm run test:scripts`.
- Unit-focused local test suite: `pnpm run test:unit`.
- Integration suite: `pnpm run test:integration`.
- Combined local test sweep: `pnpm run test:all`.
- Combined CI unit + integration test suites: `pnpm run test:ci`.
- Webview-only Jest suite: `pnpm run test:webview`.
- Playwright scratch-org E2E: `pnpm run test:e2e`.
- Standalone CLI Playwright E2E: `pnpm run test:e2e:cli`.
- Telemetry-validated Playwright E2E: `pnpm run test:e2e:telemetry`.
- Docs screenshot capture: `pnpm run docs:screenshots`.
- VSIX smoke test: `pnpm run test:smoke:vsix`.
- Test cache cleanup: `pnpm run test:clean` or `pnpm run test:clean:all`.
- Webview Jest watch mode: `pnpm run test:webview:watch`.
- Regenerate extension icon and banner assets with `pnpm run build:icon` and `pnpm run build:assets`.

## Real Org E2E and Operations

- Local and CI Dev Hub runtime authentication is JWT-only. Use `node scripts/devhub-local.js verify` or `run -- <command>` with durable private operator state described in `docs/DEVHUB_LOCAL.md`; never fall back to a host alias. Authorized administrator bootstrap and PlatformCLI scratch auth remain separate.

- Corporate proxy/MITM E2E lab: `pnpm run test:e2e:proxy-lab`; pass a child command after `--` such as `pnpm run test:e2e:proxy-lab -- pnpm run test:e2e:cli`. Real-org proxy-lab runs require complete Dev Hub JWT inputs from `docs/DEVHUB_JWT.md`; host aliases and `SF_DEVHUB_AUTH_URL` are not fallbacks.
- GitHub real-org E2E is pool-only in `.github/workflows/e2e-playwright.yml`: configure repository variable `SF_SCRATCH_POOL_NAME` plus the four `SF_DEVHUB_*` JWT secrets documented in `docs/DEVHUB_JWT.md`; parallel workflow runs are bounded by the pool's atomic slot leases and wait for capacity instead of using a workflow-level concurrency lock.
- Direct macOS real-org E2E installs Salesforce CLI under the Node runtime pinned by `.nvmrc` and exports the wrapper through `ALV_SF_BIN_PATH`; preserve that isolation when changing Salesforce CLI/runtime setup.
- Faster proxy-lab reruns can reuse Docker dependency volumes with `ALV_E2E_PROXY_LAB_SKIP_PNPM_INSTALL=1 pnpm run test:e2e:proxy-lab -- <child-command>` after dependencies are already installed.
- Salesforce CLI nightly proxy-lab validation uses `pnpm run test:e2e:proxy-lab:sf-nightly -- <child-command>`, for example `pnpm run test:e2e:proxy-lab:sf-nightly -- pnpm run test:e2e -- test/e2e/specs/openLogViewer.e2e.spec.ts`.
- Reset proxy-lab Docker volumes only intentionally with `docker compose -f docker-compose.e2e-proxy.yml down --volumes`; the volumes may contain Salesforce CLI auth state from real-org runs.
- Scratch-org pool admin commands: `pnpm run scratch-pool:bootstrap`, `pnpm run scratch-pool:list`, `pnpm run scratch-pool:reconcile`, `pnpm run scratch-pool:prewarm`, `pnpm run scratch-pool:disable-slot`, and `pnpm run scratch-pool:reset-slot`. Pass script flags after `--` so pnpm forwards them to the script.
- Telemetry usage reports: `pnpm run telemetry:report -- --subscription=<sub-id> --resource-group=<rg> --app=<app-name>`.
- Azure Monitor infrastructure helpers: preview with `pnpm run azure:monitor:what-if`; deploy with `pnpm run azure:monitor:deploy`.

## VS Code Test Runtime Policy

- Follow the official VS Code testing guidance literally: CLI-driven extension tests should default to VS Code `stable`.
- Use VS Code `Insiders` for day-to-day extension development/debugging when you need a separate running instance from the CLI test target.
- Keep unit, integration, and Playwright/E2E test defaults aligned with `stable` unless you are intentionally validating another build via `VSCODE_TEST_VERSION` or `--vscode=...`.
- Do not switch the repo-wide default test runtime to `insiders` just to work around an already-open VS Code instance.
- On this Windows machine, do not launch extension-host suites via `bash scripts/run-tests.sh` from PowerShell. `bash.exe` resolves to WSL here, which makes the runner detect Linux and download `vscode-linux-x64`. Use `pnpm run test:*`, `node scripts/run-tests-cli.js ...`, or `node scripts/run-tests.js ...` directly instead.
- Test generic Webview Session mechanics through its public interface in `apps/vscode-extension/src/node-test/webviewSession.test.ts`; keep provider tests focused on surface-owned snapshots, presentation/workflow policy, validated interactions, errors, and recovery outcomes rather than duplicating session timer, retry, generation, or disposal cases.

## Commit and Pull Request Guidelines

- Use Conventional Commits (for example `feat(logs): add filter`, `fix(tail): handle missing CLI`).
- PRs should include build/test results.
- Update `CHANGELOG.md` for user-facing changes.
- Add screenshots/GIFs for UI changes.

## Releases (stable vs pre-release)

This repo follows the VS Code Marketplace pre-release convention:

- **Even minor versions** (for example `0.26.x`) are **stable** releases.
- **Odd minor versions** (for example `0.25.x`) are **pre-releases**.

### Stable release checklist (even minor only)

1. **Collect changes since the last stable release** (previous even minor).
   - Release notes in `CHANGELOG.md` should cover _everything_ since the last stable tag, even if some changes shipped earlier as odd-minor pre-releases.
2. **Update `CHANGELOG.md`**
   - Move items from `Unreleased` into a new version section `## [X.Y.Z]`.
3. **Bump versions**
   - Update `apps/vscode-extension/package.json#version`; dependency resolution remains locked by `pnpm-lock.yaml`.
   - The release workflow validates `git tag vX.Y.Z` matches `apps/vscode-extension/package.json#version`.
4. **Open a release PR**
   - Conventional commit message usually `chore(release): prepare X.Y.Z`.
   - Include verification (recommended): `pnpm run build` + `pnpm run test:ci`.
5. **After merge, create + push the tag**
   - `git checkout main && git pull --ff-only`
   - `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
6. **Monitor CI**
   - Tag push triggers `.github/workflows/release.yml` (packages VSIX + creates GitHub Release; Marketplace uses Entra ID/GitHub OIDC, Open VSX uses its PAT, and both retain the `marketplace` environment approval).
   - Useful: `gh run list --workflow release.yml --limit 5`
7. **Local packaging/publishing helpers**
   - Package stable/pre-release VSIX with `pnpm run vsce:package` / `pnpm run vsce:package:pre`.
   - Publish stable/pre-release locally with `pnpm run vsce:publish` / `pnpm run vsce:publish:pre`.
   - Publish to Open VSX locally with `pnpm dlx ovsx publish --pat <token>` or add `--pre-release` for the odd-minor channel.

Salesforce CLI plugin releases are independent: update `packages/sf-plugin/package.json`, merge the release PR, then tag `sf-plugin-vX.Y.Z`. `.github/workflows/sf-plugin-release.yml` validates the tag against the manifest, runs `pnpm run test:sf-plugin`, `pnpm run build:sf-plugin`, and `pnpm run stage:sf-plugin-npm`, publishes the staged package to npm through Trusted Publishing/OIDC, and creates the GitHub release.

Nightly pre-releases are managed by `.github/workflows/prerelease.yml`, which packages and publishes the odd-minor pre-release channel. Marketplace uses a dedicated federated managed identity; see `docs/MARKETPLACE_OIDC.md`. The manual `verify_marketplace_only` mode checks authentication and publisher access without publishing.

See also: `docs/PUBLISHING.md` and `docs/CI.md`.

## Security and Configuration Tips

- Salesforce CLI (`sf`/`sfdx`) is required for runtime usage.
- Never commit tokens or org-sensitive data.
- Run dependency/provenance checks with `pnpm run security:dependency-sources` and `pnpm run security:pnpm-signatures`.
- Keep logs under `apexlogs/`.
- `*.log` and `*.txt` are forbidden in commits and rejected by `.github/workflows/forbid-sensitive-files.yml`.