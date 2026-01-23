# Monorepo Dev Setup Design

**Goal:** Finish the monorepo re-org by moving dev tooling/CI to the repo root and rolling back the VS Code extension’s dependency on the new Rust CLI so users are not impacted during the CLI trial period.

## Context
The repo is now a monorepo with `apps/vscode-extension` and `crates/cli`. The extension currently uses the new Rust CLI for log sync. We want to minimize user impact while we validate the CLI, and also make the monorepo easier to develop by using the root as the primary workspace.

## Decisions
1. **Root-first tooling:** Create a root `package.json` (workspaces + scripts) and move `.vscode/` and `.github/` to the root. Developers should open the root folder, press F5, and debug the extension without opening a subfolder.
2. **CI/CD from root:** GitHub Actions workflows live in `.github/workflows` at the root with `working-directory: apps/vscode-extension` for Node jobs and root `cargo` steps for Rust. Add `paths` filters to avoid running extension jobs on unrelated changes.
3. **Rollback CLI usage in extension:** Revert the extension to use its original HTTP flow for fetching logs. Remove the `electivus.apexLogs.cliPath` setting, the CLI client, and any CLI sync tests/docs. The CLI remains available for manual testing.

## Architecture & Data Flow
- **Extension:** `LogService.fetchLogs` returns to direct HTTP via existing Salesforce REST calls. No dependency on the Rust CLI.
- **CLI:** `crates/cli` remains unchanged and can be used independently (`apex-log-viewer logs sync`).
- **Root scripts:** Provide simple entrypoints like `npm run ext:watch`, `npm run ext:test`, and `npm run ext:build` that delegate to `apps/vscode-extension`.

## Testing Strategy
- **Baseline:** Existing extension unit/webview tests must continue to pass from the new root setup.
- **CLI:** Keep `cargo test -p apex-log-viewer-cli` for Rust.
- **Manual:** VS Code debug from root using the new `.vscode/launch.json`.

## Non-Goals
- Publishing the CLI to npm (tracked separately).
- Changing CLI behavior or adding new commands.
