---
name: apex-log-viewer-cli
description: Use the Apex Log Viewer standalone CLI for Salesforce Apex log investigation, local log sync/search/read/triage, org resolution, debug level and trace flag operations, and read-only Tooling API checks. Trigger when Codex needs to inspect Apex logs with `apex-log-viewer` or `alv`, operate on local `apexlogs/` caches, diagnose Salesforce log failures, manage trace flags/debug levels through the ALV CLI, or safely run Apex Log Viewer agent workflows.
---

# Apex Log Viewer CLI

Use the canonical `apex-log-viewer` command for agent-friendly Apex log work. The npm package also exposes `alv`, but prefer `apex-log-viewer` in examples and handoffs.

## Start

Run from the Salesforce workspace whose `apexlogs/` cache should be read or updated. The CLI stores local state under the current directory:

```bash
ALV_CLI="$(command -v apex-log-viewer || command -v alv || true)"
test -n "$ALV_CLI"
"$ALV_CLI" --json doctor
```

If the user names an org, alias, username, scratch org, project, ticket, or reproduction context, pass it explicitly on every org-backed command:

```bash
apex-log-viewer --json doctor --target-org my-org
apex-log-viewer --json orgs resolve --target-org my-org
```

Auth is inherited from the Salesforce CLI, not from an Apex Log Viewer token. Expect `sf org display` and `sf org auth show-access-token` to be the underlying auth path. If `sf` is installed somewhere unusual, check whether the repo or user has set `ALV_SF_BIN_PATH`.

Install or refresh this skill from the bundled CLI with:

```bash
apex-log-viewer skills install --force
```

## JSON Rules

Use `--json` for agent workflows. Successful output is command-specific JSON on stdout; failures are JSON on stderr with at least:

```json
{
  "status": "error",
  "code": "command_failed",
  "message": "short actionable message"
}
```

Read `status`, `code`, `message`, and any `data` before retrying. Do not paste access tokens, session IDs, auth URLs, full log bodies, or org-sensitive payloads into chat unless the user explicitly asks for that exact artifact.

## Safe Log Flow

Use the narrowest read path first:

```bash
apex-log-viewer --json logs status --target-org my-org
apex-log-viewer --json logs list --target-org my-org --limit 20
```

Sync only when the cache is missing what the task needs. `logs sync` performs authenticated Salesforce Tooling API reads and writes local files under `apexlogs/`:

```bash
apex-log-viewer --json logs sync --target-org my-org --concurrency 6
```

Read and triage exact IDs once identified:

```bash
apex-log-viewer --json logs resolve 07L000000000001AAA --target-org my-org
apex-log-viewer --json logs read 07L000000000001AAA --target-org my-org --max-bytes 200000
apex-log-viewer --json logs triage 07L000000000001AAA --target-org my-org
```

The canonical local layout is `apexlogs/orgs/<safe-target-org>/logs/YYYY-MM-DD/<logId>.log` with sync state in `apexlogs/.alv/sync-state.json`. Do not use removed `logs index` commands.

## Users And Debugging Setup

Find users before applying user-specific trace flags:

```bash
apex-log-viewer --json users search "Ada Lovelace" --target-org my-org --limit 10
```

Inspect before changing debug configuration:

```bash
apex-log-viewer --json debug-levels list --target-org my-org
apex-log-viewer --json debug-levels get --target-org my-org --developer-name ALV_DEBUG
apex-log-viewer --json trace-flags status --target-org my-org --current-user
```

Valid trace flag targets are `--current-user`, `--user-id <005...>`, `--automated-process`, and `--platform-integration`.

## Writes

Treat these as operational writes and require explicit user intent before live execution:

- `logs delete`
- `trace-flags apply`
- `trace-flags remove`
- `debug-levels create`
- `debug-levels update`
- `debug-levels delete`

Always run the preview first:

```bash
apex-log-viewer --json logs delete --target-org my-org --ids 07L000000000001AAA --dry-run
apex-log-viewer --json trace-flags apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --dry-run
apex-log-viewer --json debug-levels create --target-org my-org --developer-name ALV_DEBUG --master-label ALV_DEBUG --dry-run
```

Run live writes only after the user approves that specific operation, and include `--yes`:

```bash
apex-log-viewer --json trace-flags apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --yes
```

Do not run live `logs delete --scope all` unless the user specifically asks to delete all org logs.

## Raw Escape Hatch

Use typed commands first. Use raw Tooling only for read-only gaps:

```bash
apex-log-viewer --json tooling query "SELECT Id, StartTime, Operation, Status FROM ApexLog ORDER BY StartTime DESC LIMIT 5" --target-org my-org
apex-log-viewer --json tooling request get "/services/data/v61.0/tooling/query/?q=SELECT+Id+FROM+ApexLog+LIMIT+1" --target-org my-org
```

Do not attempt raw POST, PATCH, or DELETE through this skill. Use typed commands for writes.

## App Server

`apex-log-viewer app-server --stdio` is for JSON-RPC integrations with the VS Code/runtime protocol. Do not use it for ordinary CLI investigation unless the task is specifically to test or integrate the app-server transport.

## Copy-Paste Examples

```bash
apex-log-viewer --json doctor --target-org my-org
```

```bash
apex-log-viewer --json logs sync --target-org my-org --concurrency 6
apex-log-viewer --json logs status --target-org my-org
```

```bash
apex-log-viewer --json trace-flags apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --dry-run
```
