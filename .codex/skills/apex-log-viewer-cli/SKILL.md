---
name: apex-log-viewer-cli
description: Use the Apex Log Viewer Salesforce CLI plugin for Apex log investigation, local log sync/search/read/triage, org resolution, debug level and trace flag operations, and read-only Tooling API checks. Trigger when Codex needs to inspect Apex logs with `sf electivus`, operate on local `apexlogs/` caches, diagnose Salesforce log failures, manage trace flags/debug levels through the ALV plugin, or safely run Apex Log Viewer agent workflows.
---

# Apex Log Viewer Sf Plugin

Use the canonical `sf electivus` command namespace for agent-friendly Apex log work. The VS Code extension embeds the same plugin runner, and the published plugin exposes the same JSON command surface for terminal workflows.

## Start

Run from the Salesforce workspace whose `apexlogs/` cache should be read or updated. The CLI stores local state under the current directory:

```bash
SF_CLI="$(command -v sf || true)"
test -n "$SF_CLI"
"$SF_CLI" electivus doctor --json
```

If the user names an org, alias, username, scratch org, project, ticket, or reproduction context, pass it explicitly on every org-backed command:

```bash
sf electivus doctor --target-org my-org --json
sf electivus orgs resolve --target-org my-org --json
```

Auth is inherited from the Salesforce CLI, not from an Apex Log Viewer token. Expect `sf org display` and `sf org auth show-access-token` to be the underlying auth path. If `sf` is installed somewhere unusual, check whether the repo or user has set `ALV_SF_BIN_PATH`.

Install or refresh this skill from the Salesforce CLI plugin with:

```bash
sf electivus skills install
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
sf electivus logs status --target-org my-org --json
sf electivus logs list --target-org my-org --limit 20 --json
```

Sync only when the cache is missing what the task needs. `logs sync` performs authenticated Salesforce Tooling API reads and writes local files under `apexlogs/`:

```bash
sf electivus logs sync --target-org my-org --concurrency 6 --json
```

Read and triage exact IDs once identified:

```bash
sf electivus logs resolve 07L000000000001AAA --target-org my-org --json
sf electivus logs read 07L000000000001AAA --target-org my-org --max-bytes 200000 --json
sf electivus logs triage 07L000000000001AAA --target-org my-org --json
```

The canonical local layout is `apexlogs/orgs/<safe-target-org>/logs/YYYY-MM-DD/<logId>.log` with sync state in `apexlogs/.alv/sync-state.json`. Do not use removed `logs index` commands.

## Users And Debugging Setup

Find users before applying user-specific trace flags:

```bash
sf electivus users search "Ada Lovelace" --target-org my-org --limit 10 --json
```

Inspect before changing debug configuration:

```bash
sf electivus debug-levels list --target-org my-org --json
sf electivus debug-levels get --target-org my-org --developer-name ALV_DEBUG --json
sf electivus trace-flags status --target-org my-org --current-user --json
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
sf electivus logs delete --target-org my-org --ids 07L000000000001AAA --dry-run --json
sf electivus trace-flags apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --dry-run --json
sf electivus debug-levels create --target-org my-org --developer-name ALV_DEBUG --master-label ALV_DEBUG --dry-run --json
```

Run live writes only after the user approves that specific operation, and include `--yes`:

```bash
sf electivus trace-flags apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --yes --json
```

Do not run live `logs delete --scope all` unless the user specifically asks to delete all org logs.

## Raw Escape Hatch

Use typed commands first. Use raw Tooling only for read-only gaps:

```bash
sf electivus tooling query "SELECT Id, StartTime, Operation, Status FROM ApexLog ORDER BY StartTime DESC LIMIT 5" --target-org my-org --json
sf electivus tooling request get "/services/data/v61.0/tooling/query/?q=SELECT+Id+FROM+ApexLog+LIMIT+1" --target-org my-org --json
```

Do not attempt raw POST, PATCH, or DELETE through this skill. Use typed commands for writes.

## Removed Runtime

The Rust app-server and daemon transports have been removed. Use `sf electivus ... --json` for all agent workflows.

## Copy-Paste Examples

```bash
sf electivus doctor --target-org my-org --json
```

```bash
sf electivus logs sync --target-org my-org --concurrency 6 --json
sf electivus logs status --target-org my-org --json
```

```bash
sf electivus trace-flags apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --dry-run --json
```
