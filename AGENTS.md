# Repository Guidelines

## Scope
- This file defines guidance for the whole repository.

## Project Structure
- `src/` contains extension host, services, providers, and shared types.
- `src/webview/` contains the webview React UI.
- `src/test/` contains VS Code extension unit/integration tests and test harness code.
- `test/e2e/` contains Playwright scratch-org E2E specs, fixtures, and utilities.
- `docs/` holds architecture/testing/publishing notes and plan docs.
- `media/` stores bundled webview assets.
- `scripts/` contains build/test helper scripts.

## Shared Runtime Strategy
- Treat the VS Code extension and the standalone CLI as separate surfaces built on a shared architecture, not as copies of each other.
- When a new capability is valuable to both the CLI and the extension, prefer implementing the core behavior in shared Rust/runtime layers first (`alv-core` plus app-server/runtime contracts), then expose it through the appropriate surface.
- It is fine for the CLI to be the first consumer of a new shared capability, especially for human/operator and AI-agent workflows, but do not force the extension UX to depend on shelling out to user-facing CLI commands.
- For log-local workflows, preserve the shared workspace contract around `apexlogs/` and the existing `<safeUser>_<logId>.log` naming instead of inventing a parallel cache layout.
- If incremental log sync state is introduced, treat it as a shared runtime contract that the extension may adopt later; keep extension compatibility by avoiding changes that would break existing `apexlogs/` consumers.
- When a CLI flag overlaps with familiar Salesforce CLI behavior, prefer the `sf`-style spelling such as `--target-org`.

## Build and Development
- Use Node `22` via `.nvmrc`.
- Install deps with `npm ci`.
- Type-check only with `npm run check-types`.
- Lint with `npm run lint`.
- Lint + extension TypeScript validation with `npm run compile`.
- Build with `npm run build`.
- Prepare a publishable package with `npm run package`.
- Watch mode: `npm run watch`.
- Default local test command: `npm test`.
- Unit-focused local test suite: `npm run test:unit`.
- Integration suite: `npm run test:integration`.
- Combined local test sweep: `npm run test:all`.
- Full CI-equivalent suite: `npm run test:ci`.
- Webview-only Jest suite: `npm run test:webview`.
- Playwright scratch-org E2E: `npm run test:e2e`.
- VSIX smoke test: `npm run test:smoke:vsix`.
- Test cache cleanup: `npm run test:clean` or `npm run test:clean:all`.

## VS Code Test Runtime Policy
- Follow the official VS Code testing guidance literally: CLI-driven extension tests should default to VS Code `stable`.
- Use VS Code `Insiders` for day-to-day extension development/debugging when you need a separate running instance from the CLI test target.
- Keep unit, integration, and Playwright/E2E test defaults aligned with `stable` unless you are intentionally validating another build via `VSCODE_TEST_VERSION` or `--vscode=...`.
- Do not switch the repo-wide default test runtime to `insiders` just to work around an already-open VS Code instance.
- On this Windows machine, do not launch extension-host suites via `bash scripts/run-tests.sh` from PowerShell. `bash.exe` resolves to WSL here, which makes the runner detect Linux and download `vscode-linux-x64`. Use `npm run test:*`, `node scripts/run-tests-cli.js ...`, or `node scripts/run-tests.js ...` directly instead.

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
   - Update `package.json#version` and `package-lock.json` to `X.Y.Z`.
   - The release workflow validates `git tag vX.Y.Z` matches `package.json#version`.
4. **Open a release PR**
   - Conventional commit message usually `chore(release): prepare X.Y.Z`.
   - Include verification (recommended): `npm run build` + `npm run test:ci`.
5. **After merge, create + push the tag**
   - `git checkout main && git pull --ff-only`
   - `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
6. **Monitor CI**
   - Tag push triggers `.github/workflows/release.yml` (packages VSIX + creates GitHub Release; publishes to Marketplace/Open VSX when tokens are configured).
   - Useful: `gh run list --workflow release.yml --limit 5`
7. **Local packaging/publishing helpers**
   - Package stable/pre-release VSIX with `npm run vsce:package` / `npm run vsce:package:pre`.
   - Publish stable/pre-release locally with `npm run vsce:publish` / `npm run vsce:publish:pre`.
   - Publish to Open VSX locally with `npx --yes ovsx publish --pat <token>` or add `--pre-release` for the odd-minor channel.

Nightly pre-releases are managed by `.github/workflows/prerelease.yml`, which packages and publishes the odd-minor pre-release channel when publishing secrets are configured.

See also: `docs/PUBLISHING.md` and `docs/CI.md`.

## Security and Configuration Tips
- Salesforce CLI (`sf`/`sfdx`) is required for runtime usage.
- Never commit tokens or org-sensitive data.
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
