# Apex Log Viewer CLI + Monorepo Design

## Goals
- Convert the repository into a monorepo with `apps/vscode-extension` and `apps/cli`.
- Introduce a Rust CLI that performs `logs sync` and serves as the single source of truth for log retrieval.
- Refactor the VS Code extension to call the CLI (CLI-first) instead of querying Salesforce directly for log lists.
- Keep `apexlogs/` local and gitignored, created automatically by the CLI.
- Require a valid SFDX project (must find `sfdx-project.json`) and read `sourceApiVersion` from it.

## Non-goals (v1)
- No `logs get` command (removed for now).
- No FFI/shared Rust library; the CLI runs as a standalone process.
- No forced `sf` plugin; use `sf/sfdx` only for auth retrieval.

## Repository Structure
- `apps/vscode-extension/` — current extension code moved from `Apex-Log-Viewer/`.
- `apps/cli/` — new Rust CLI crate.
- Root `Cargo.toml` with workspace `members = ["apps/cli"]`.
- Optional root `package.json` with workspaces for Node (if needed).
- `docs/` for shared documentation; design stored in `docs/plans/`.
- Root `.gitignore` includes `apexlogs/`.

## CLI (Rust) Design
- Binary name: `apex-log-viewer`.
- Command: `apex-log-viewer logs sync`.
- Flags:
  - `--limit <N>` (default 100).
  - `--target <alias|username>` (optional; default org if omitted).
  - `--json` is implicit; output is always JSON in v1.
- Behavior:
  - Validate `sfdx-project.json` from cwd upwards; exit with JSON error if missing.
  - Read `sourceApiVersion` from `sfdx-project.json` and use it for REST Tooling API calls.
  - Use `sf` or `sfdx` only to retrieve auth (`accessToken`, `instanceUrl`, `username`).
  - Create `apexlogs/` under cwd if missing.
  - Fetch latest N ApexLog rows (StartTime DESC, Id DESC).
  - Download each log body and write to `apexlogs/<username>_<id>.log`.
- Output (stdout): JSON with `ok`, `org`, `apiVersion`, `limit`, `savedDir`, `saved[]`, `skipped[]`, `errors[]`.
- Errors: JSON with `ok:false`, `errorCode`, `message`, and non-zero exit code.

## Extension Integration (CLI-first)
- The extension calls `apex-log-viewer logs sync` on refresh.
- The JSON output provides the list of logs and file paths to render the UI.
- The extension prefers local files for open/debug flows; if missing, it can re-run `logs sync` or surface an actionable error.
- Add configuration (optional): `electivus.apexLogs.cliPath` or env `APEX_LOG_VIEWER_CLI` for custom binary path.

## Data Flow Summary
1. User clicks Refresh in VS Code.
2. Extension invokes CLI `logs sync` with `--limit` and optional `--target`.
3. CLI validates SFDX project, resolves API version, fetches logs via REST, writes files to `apexlogs/`.
4. Extension reads JSON and updates UI + state using local file references.

## Error Handling
- CLI emits JSON errors; extension surfaces friendly messages with guidance.
- Missing CLI or invalid JSON results in a clear “CLI not found / output invalid” error.
- Missing `sfdx-project.json` halts CLI with an explicit message.

## Testing Notes
- CLI unit tests for:
  - `sfdx-project.json` discovery and API version parsing.
  - JSON output shape and error behavior.
- Extension tests updated to mock CLI execution and JSON parsing.
