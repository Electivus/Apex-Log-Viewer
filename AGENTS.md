# Repository Guidelines

## Scope
- This file defines guidance for the whole repository.

## Project Structure
- `apps/vscode-extension/` contains the VS Code extension host, extension-only adapters under `src/host`, tests, packaging scripts, and bundled media.
- `packages/core/` contains the private Salesforce and local-log business core shared by both product surfaces.
- `packages/protocol/` contains the private, VS Code-free extension/webview message contract.
- `packages/webview/` contains the webview React UI.
- `packages/sf-plugin/` contains class-per-command Salesforce CLI adapters and plugin-only skill installation.
- `test/e2e/` contains Playwright scratch-org E2E specs, fixtures, and utilities.
- `config/` holds scratch-org configuration.
- `docs/` holds architecture/testing/publishing notes and plan docs.
- `scripts/` contains build/test helper scripts.
- `.codex/skills/` contains bundled Codex skill packages.

## Shared Runtime Strategy
- Treat the VS Code extension and Salesforce CLI plugin as separate adapters over private `@alv/core`.
- Implement shared behavior in `packages/core` without VS Code or oclif dependencies, then expose it through a class-per-command `sf electivus ...` adapter and the extension's in-process core client.
- The extension bundles `@alv/core` into `dist/extension.js`; never add an embedded plugin runner or a child-process command bridge.
- Keep webview messages and UI-safe DTOs in `packages/protocol`; do not import VS Code there.
- For log-local workflows, treat the org-first `apexlogs/orgs/<safe-org>/logs/...` layout as the canonical structure while preserving the existing `<safeUser>_<logId>.log` files for backward compatibility; during the transition both layouts may coexist, but avoid introducing additional cache layouts.
- If incremental log sync state is introduced, treat it as a shared runtime contract that the extension may adopt later; keep extension compatibility by avoiding changes that would break existing `apexlogs/` consumers in either the org-first or legacy flat layouts.
- When a CLI flag overlaps with familiar Salesforce CLI behavior, prefer the `sf`-style spelling such as `--target-org`.

## Build and Development
- Use Node `24` via `.nvmrc`.
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
- E2E utility Jest suite: `pnpm run test:e2e:utils`.
- Script/security regression suite: `pnpm run test:scripts`.
- Unit-focused local test suite: `pnpm run test:unit`.
- Integration suite: `pnpm run test:integration`.
- Combined local test sweep: `pnpm run test:all`.
- Full CI-equivalent suite: `pnpm run test:ci`.
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
- Corporate proxy/MITM E2E lab: `pnpm run test:e2e:proxy-lab`; pass a child command after `--` such as `pnpm run test:e2e:proxy-lab -- pnpm run test:e2e:cli`. Real-org proxy-lab runs require `SF_DEVHUB_AUTH_URL`.
- GitHub real-org E2E is pool-only in `.github/workflows/e2e-playwright.yml`: configure repository variable `SF_SCRATCH_POOL_NAME` plus secret `SF_DEVHUB_AUTH_URL`; parallel workflow runs are bounded by the pool's atomic slot leases and wait for capacity instead of using a workflow-level concurrency lock.
- Direct macOS real-org E2E installs Salesforce CLI under Node 20 and exports the wrapper through `ALV_SF_BIN_PATH`; preserve that isolation when changing Salesforce CLI/runtime setup.
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
   - Release notes in `CHANGELOG.md` should cover *everything* since the last stable tag, even if some changes shipped earlier as odd-minor pre-releases.
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
   - Tag push triggers `.github/workflows/release.yml` (packages VSIX + creates GitHub Release; publishes to Marketplace/Open VSX when tokens are configured).
   - Useful: `gh run list --workflow release.yml --limit 5`
7. **Local packaging/publishing helpers**
   - Package stable/pre-release VSIX with `pnpm run vsce:package` / `pnpm run vsce:package:pre`.
   - Publish stable/pre-release locally with `pnpm run vsce:publish` / `pnpm run vsce:publish:pre`.
   - Publish to Open VSX locally with `pnpm dlx ovsx publish --pat <token>` or add `--pre-release` for the odd-minor channel.

Nightly pre-releases are managed by `.github/workflows/prerelease.yml`, which packages and publishes the odd-minor pre-release channel when publishing secrets are configured.

See also: `docs/PUBLISHING.md` and `docs/CI.md`.

## Security and Configuration Tips
- Salesforce CLI (`sf`/`sfdx`) is required for runtime usage.
- Never commit tokens or org-sensitive data.
- Run dependency/provenance checks with `pnpm run security:dependency-sources` and `pnpm run security:pnpm-signatures`.
- Keep logs under `apexlogs/`.
- `*.log` and `*.txt` are blocked by hooks/CI.

## JavaScript REPL (Node)
- Use `js_repl` for Node-backed JavaScript with top-level await in a persistent kernel. `codex.state` persists for the session (best effort) and is cleared by `js_repl_reset`.
- `js_repl` is a freeform/custom tool. Direct `js_repl` calls must send raw JavaScript tool input (optionally with first-line `// codex-js-repl: timeout_ms=15000`). Do not wrap code in JSON (for example `{"code":"..."}`), quotes, or markdown code fences.
- Helpers: `codex.state`, `codex.tmpDir`, and `codex.tool(name, args?)`.
- `codex.tool` executes a normal tool call and resolves to the raw tool output object. Use it for shell and non-shell tools alike.
- To share generated images with the model, write a file under `codex.tmpDir`, call `await codex.tool("view_image", { path: "/absolute/path" })`, then delete the file.
- Top-level bindings persist across cells. If you hit `SyntaxError: Identifier 'x' has already been declared`, reuse the binding, pick a new name, wrap in `{ ... }` for block scope, or reset the kernel with `js_repl_reset`.
- Top-level static import declarations (for example `import x from "pkg"`) are currently unsupported in `js_repl`; use dynamic imports with `await import("pkg")` instead.
- Avoid direct access to `process.stdout` / `process.stderr` / `process.stdin`; it can corrupt the JSON line protocol. Use `console.log` and `codex.tool(...)`.
