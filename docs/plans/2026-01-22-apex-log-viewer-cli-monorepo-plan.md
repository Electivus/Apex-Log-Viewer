# Apex Log Viewer CLI + Monorepo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the repo to a monorepo and add a Rust CLI (`logs sync`) that the VS Code extension uses as its source of truth.

**Architecture:** Root workspace holds Node extension and Rust CLI. The CLI uses `sf/sfdx` only for auth, then calls Salesforce Tooling REST API directly and writes logs to `apexlogs/` under cwd. The extension delegates refresh to the CLI and consumes JSON output.

**Tech Stack:** Rust (clap, serde, serde_json, reqwest), TypeScript (VS Code extension), Node tooling, Salesforce Tooling API.

---

### Task 1: Bring the extension into monorepo layout

**Files:**
- Move: `Apex-Log-Viewer/` -> `apps/vscode-extension/`
- Create: `Cargo.toml` (root)
- Modify: `.gitignore`
- Create: `README.md` (root, monorepo overview)

**Step 1: Move extension directory into monorepo**
- Command: `mkdir -p apps && mv ../Apex-Log-Viewer apps/vscode-extension` (adjust paths in execution)
- Expected: `apps/vscode-extension/package.json` exists.

**Step 2: Add root Cargo workspace**
- Create `Cargo.toml`:
```toml
[workspace]
members = ["apps/cli"]
resolver = "2"
```
- No tests yet.

**Step 3: Update root .gitignore**
- Append:
```
apexlogs/
```
- Keep `.worktrees/` entry.

**Step 4: Add root README**
- Document monorepo layout, how to build extension + CLI, and how to run `apex-log-viewer logs sync`.

**Step 5: Commit**
```bash
git add Cargo.toml .gitignore README.md apps/vscode-extension
git commit -m "chore: adopt monorepo layout"
```

---

### Task 2: Scaffold Rust CLI crate

**Files:**
- Create: `apps/cli/Cargo.toml`
- Create: `apps/cli/src/main.rs`
- Create: `apps/cli/src/lib.rs`
- Create: `apps/cli/src/commands/mod.rs`
- Create: `apps/cli/src/commands/logs_sync.rs`
- Create: `apps/cli/src/sfdx_project.rs`
- Create: `apps/cli/src/auth.rs`
- Create: `apps/cli/src/http.rs`
- Create: `apps/cli/src/output.rs`
- Test: `apps/cli/src/sfdx_project.test.rs` (or `tests/`)

**Step 1: Write failing tests for sfdx-project discovery**
- Test: `find_project_root` returns None when missing.
- Test: `find_project_root` returns nearest parent containing `sfdx-project.json`.
- Expected: tests fail (functions not implemented).

**Step 2: Implement sfdx-project discovery + API version parsing**
- Implement in `apps/cli/src/sfdx_project.rs`.
- Parse `sourceApiVersion` (string) and validate `\d+\.\d+`.

**Step 3: Run tests**
```bash
cargo test -p apex-log-viewer-cli sfdx_project
```
Expected: PASS.

**Step 4: Define CLI skeleton**
- Use `clap` to define `logs sync --limit --target` and `--json` (implicit).
- Wire to `commands::logs_sync::run`.

**Step 5: Commit**
```bash
git add apps/cli/Cargo.toml apps/cli/src apps/cli/tests
git commit -m "feat(cli): scaffold logs sync command"
```

---

### Task 3: Implement auth retrieval via sf/sfdx (TDD)

**Files:**
- Modify: `apps/cli/src/auth.rs`
- Test: `apps/cli/src/auth.test.rs` (or `tests/auth.rs`)

**Step 1: Write failing tests for JSON parsing**
- Provide sample `sf org display --json` and `sfdx force:org:display --json` payloads.
- Test `parse_auth_json` extracts `accessToken`, `instanceUrl`, `username`.

**Step 2: Implement parsing + command execution**
- Implement `get_auth(target: Option<String>)`:
  - Try `sf org display --json --verbose -o <target>`
  - Fallback to `sfdx force:org:display --json -u <target>`
  - Parse JSON with `parse_auth_json`
  - Return structured auth or error

**Step 3: Run tests**
```bash
cargo test -p apex-log-viewer-cli auth
```
Expected: PASS.

**Step 4: Commit**
```bash
git add apps/cli/src/auth.rs apps/cli/tests/auth.rs
git commit -m "feat(cli): resolve sf/sfdx auth"
```

---

### Task 4: Implement Tooling API calls + file writing (TDD)

**Files:**
- Modify: `apps/cli/src/http.rs`
- Modify: `apps/cli/src/commands/logs_sync.rs`
- Modify: `apps/cli/src/output.rs`
- Test: `apps/cli/tests/logs_sync.rs`

**Step 1: Write failing tests for filename sanitation + output shape**
- Test `make_log_filename(username, id)` -> `username_id.log` with safe chars.
- Test JSON output struct serializes with expected fields.

**Step 2: Implement REST calls**
- `query_apex_logs(auth, api_version, limit)` -> records list.
- `fetch_log_body(auth, api_version, id)` -> string body.
- Use `reqwest` (blocking) with Authorization Bearer token.

**Step 3: Implement `logs sync` flow**
- Validate `sfdx-project.json` (error if missing).
- Create `apexlogs/` under cwd.
- Fetch logs, download bodies, write files.
- Produce JSON output to stdout.

**Step 4: Run tests**
```bash
cargo test -p apex-log-viewer-cli logs_sync
```
Expected: PASS.

**Step 5: Commit**
```bash
git add apps/cli/src apps/cli/tests
git commit -m "feat(cli): implement logs sync"
```

---

### Task 5: Refactor extension to use CLI (TDD)

**Files:**
- Modify: `apps/vscode-extension/src/services/logService.ts`
- Create: `apps/vscode-extension/src/utils/cliClient.ts`
- Modify: `apps/vscode-extension/src/extension.ts`
- Modify: `apps/vscode-extension/package.json`
- Test: `apps/vscode-extension/src/test/cli.sync.test.ts` (new)
- Update: `apps/vscode-extension/docs/ARCHITECTURE.md`
- Update: `apps/vscode-extension/README.md`

**Step 1: Add failing tests for CLI JSON parsing**
- Test `cliClient.parseSyncOutput` handles ok + error JSON.

**Step 2: Implement CLI client**
- Execute `apex-log-viewer logs sync --limit N --target <org>`.
- Support env `APEX_LOG_VIEWER_CLI` or setting `electivus.apexLogs.cliPath`.
- Parse JSON; surface meaningful errors.

**Step 3: Wire refresh command to CLI**
- In `LogService` or command handler, call CLI sync to fetch logs list.
- Use returned metadata for UI.
- Ensure open/debug uses existing local files; if missing, re-run sync or show error.

**Step 4: Update docs and package.json config**
- Add `electivus.apexLogs.cliPath` setting.
- Update README + architecture docs.

**Step 5: Run tests**
```bash
npm test -- --runInBand
```
Expected: PASS (or run targeted Mocha + jest suites).

**Step 6: Commit**
```bash
git add apps/vscode-extension
git commit -m "feat(extension): refresh logs via CLI"
```

---

### Task 6: End-to-end sanity checks

**Files:**
- None (local only)

**Step 1: Build CLI**
```bash
cargo build -p apex-log-viewer-cli
```

**Step 2: Build extension**
```bash
cd apps/vscode-extension
npm install
npm run build
```

**Step 3: Commit any final doc tweaks**
```bash
git add README.md apps/vscode-extension/README.md apps/vscode-extension/docs/ARCHITECTURE.md
```

---

## Notes
- Keep `apexlogs/` local and ignored.
- CLI output always JSON in v1.
- Error JSON must include `ok:false` and `errorCode` for consistent handling.
