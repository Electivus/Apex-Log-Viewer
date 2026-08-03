---
name: apex-log-viewer-cli
description: Use the Apex Log Viewer Salesforce CLI plugin for Apex log investigation, local log sync/read/triage, org resolution, debug level and trace flag operations, and read-only Tooling API checks. Trigger when an agent needs to inspect Apex logs with `sf electivus`, operate on local `apexlogs/` caches, diagnose Salesforce log failures, manage trace flags or debug levels through the ALV plugin, or safely run Apex Log Viewer agent workflows.
---

# Apex Log Viewer Salesforce CLI Plugin

Use the standalone `sf electivus` plugin for terminal workflows. It and the VS Code extension are independent adapters over the same TypeScript core; the extension does not install or execute the plugin.

## Start With Doctor

Run from the Salesforce workspace whose `apexlogs/` cache should be read or updated:

```text
sf electivus doctor --json
```

If the user names an org or alias, pass it explicitly on the doctor command and every later org-backed command:

```text
sf electivus doctor --target-org my-org --json
sf electivus org resolve --target-org my-org --json
```

Read `runtimeVersion`, `platform`, `arch`, `workspaceRoot`, `apexlogsRoot`, and every reported check before choosing an operation. Treat `runtimeVersion` as the first compatibility signal, not proof that a particular command exists.

Before relying on an operation that may be absent from an older plugin, verify its public command help, for example:

```text
sf electivus log triage --help
```

Only attempt the operation when its help succeeds and describes the expected command. Do not guess a command from these instructions when the installed plugin does not expose it.

If `doctor` is unavailable because the plugin is missing, explain the failure and offer this exact action without running it:

```text
sf plugins install @electivus/plugin-electivus
```

If the installed plugin is incompatible or lacks a required operation, explain the observed version or missing capability and offer this exact action without running it:

```text
sf plugins install @electivus/plugin-electivus@latest --force
```

Wait for explicit user intent before installing or updating the plugin. Diagnosis alone never authorizes an environment change.

Authentication comes from Salesforce CLI state. Never expose access tokens, session IDs, auth URLs, full logs, or org-sensitive payloads unless the user explicitly requests that exact artifact.

## JSON Contract

Use `--json` for agent workflows. Salesforce CLI wraps a successful command value under `result` and reports a zero `status`. Read the command-specific camel-case fields inside `result`, such as `targetOrg`, `safeTargetOrg`, `logCount`, `logId`, or `startTime`. On failure, inspect `name`, `message`, `exitCode`, and `context` before deciding whether a retry is safe.

## Safe Log Flow

Inspect the local sync state first. `log status` reads the workspace cache; `log list` performs a read-only Tooling API query for the latest remote metadata:

```text
sf electivus log status --target-org my-org --json
sf electivus log list --target-org my-org --limit 20 --json
```

Sync only when the local cache is missing required logs. This reads the Salesforce Tooling API and writes the canonical store under `apexlogs/`:

```text
sf electivus log sync --target-org my-org --concurrency 6 --json
```

Resolve or triage exact IDs with flags, not positional arguments:

```text
sf electivus log resolve --log-id 07L000000000001AAA --target-org my-org --json
sf electivus log triage --log-id 07L000000000001AAA --target-org my-org --json
```

Use `log read` only when the user requests log content. Start with a bounded response such as `sf electivus log read --log-id 07L000000000001AAA --target-org my-org --max-bytes 20000 --json`, and do not reproduce the body in chat unless explicitly requested.

Repeat `--log-id` to triage or delete multiple logs. The canonical layout is `apexlogs/orgs/<safe-target-org>/logs/YYYY-MM-DD/<logId>.log`, with sync state at `apexlogs/.alv/sync-state.json`. The core can still read legacy `<safeUser>_<logId>.log` cache files during migration. Do not use removed `logs search` or `logs index` commands.

## Users And Debug Configuration

Search users with an explicit query before targeting user-specific trace flags:

```text
sf electivus user search --query "Ada Lovelace" --target-org my-org --limit 10 --json
```

Inspect current configuration before changing it:

```text
sf electivus debug-level list --target-org my-org --json
sf electivus debug-level get --target-org my-org --developer-name ALV_DEBUG --json
sf electivus trace-flag status --target-org my-org --current-user --json
```

Supply exactly one trace target: `--current-user`, `--user-id <005...>`, `--automated-process`, or `--platform-integration`.

## Writes

These commands mutate Salesforce state and require explicit user intent before live execution:

- `log delete`
- `trace-flag apply` and `trace-flag remove`
- `debug-level create`, `debug-level update`, and `debug-level delete`

Preview writes first:

```text
sf electivus log delete --target-org my-org --log-id 07L000000000001AAA --dry-run --json
sf electivus trace-flag apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --dry-run --json
sf electivus debug-level create --target-org my-org --developer-name ALV_DEBUG --master-label ALV_DEBUG --dry-run --json
```

Execute only the Salesforce operation the user approved, and include `--yes`:

```text
sf electivus trace-flag apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --yes --json
```

Never run live `log delete --scope all` unless the user specifically asks to delete all matching org logs.

## Raw Read-Only Escape Hatch

Prefer typed commands. Use raw Tooling only for read-only gaps, with required values passed as flags:

```text
sf electivus tooling query --soql "SELECT Id, StartTime, Operation, Status FROM ApexLog ORDER BY StartTime DESC LIMIT 5" --target-org my-org --json
sf electivus tooling get --path "/services/data/v61.0/tooling/query/?q=SELECT+Id+FROM+ApexLog+LIMIT+1" --target-org my-org --json
```

Do not use raw Tooling requests to mutate Salesforce state.

## Update This Skill

Only when the user explicitly asks to update this Agent Skill, use the standard updater from the project that owns its `skills-lock.json`:

```text
npx skills update apex-log-viewer-cli --project -y
```

For an explicitly requested global-scope update, use `npx skills update apex-log-viewer-cli --global -y`. Never install, remove, or update the Agent Skill merely because the user is investigating logs.

## Output Discipline

Report the resolved org, the commands run, counts and IDs needed for the task, local paths written, and any warnings or failures. Keep secrets and log bodies out of summaries unless the user explicitly asks for them.
