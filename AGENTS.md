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
