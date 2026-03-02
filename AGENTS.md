# Repository Guidelines

## Scope
- This file defines guidance for the whole repository.

## Project Structure
- `src/` contains extension host, services, providers, and shared types.
- `src/webview/` contains the webview React UI.
- `test/` contains VS Code extension integration/unit tests.
- `docs/` holds architecture/testing/publishing notes and plan docs.
- `media/` stores bundled webview assets.
- `scripts/` contains build/test helper scripts.

## Build and Development
- Use Node `22` via `.nvmrc`.
- Install deps with `npm ci`.
- Build with `npm run build`.
- Watch mode: `npm run watch`.
- Test suite: `npm run test`.

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
