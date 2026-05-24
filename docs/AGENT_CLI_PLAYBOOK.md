# Apex Log Viewer Agent CLI Playbook

This playbook is for agents helping Salesforce developers inspect Apex logs with the canonical `apex-log-viewer` command. It is not a contributor guide for building the CLI.

## First Command

Always start with:

```powershell
apex-log-viewer --json doctor
```

Read the JSON before doing anything else. If the user named an org, rerun with an explicit org:

```powershell
apex-log-viewer --json doctor --target-org my-org-alias
```

Prefer explicit `--target-org` on every org-backed command. Never rely on the default org when the user gave an alias, username, scratch org, project, ticket, or reproduction context.

## JSON Contract

Use `--json` for agent workflows. Success responses are command-specific JSON on stdout. Progress and human messages belong on stderr. Errors use this shape and must not contain tokens:

```json
{
  "status": "error",
  "code": "command_failed",
  "message": "short actionable message",
  "data": {}
}
```

If a command fails, inspect `code`, `message`, and `data` before retrying. Do not paste access tokens, session IDs, auth URLs, or full org-sensitive payloads into chat.

## Safe Investigation Flow

Use the narrowest read path first:

1. Verify runtime and org readiness with `doctor`.
2. Resolve the org if there is ambiguity:

   ```powershell
   apex-log-viewer --json orgs resolve --target-org my-org-alias
   ```

3. List recent logs with a small limit:

   ```powershell
   apex-log-viewer --json logs list --target-org my-org-alias --limit 20
   ```

4. Sync only when the local cache is missing what you need:

   ```powershell
   apex-log-viewer --json logs sync --target-org my-org-alias
   ```

5. Read or triage specific log IDs:

   ```powershell
   apex-log-viewer --json logs read 07L000000000001AAA --target-org my-org-alias --max-bytes 200000
   apex-log-viewer --json logs triage 07L000000000001AAA --target-org my-org-alias
   ```

6. Search the local cache before broadening scope:

   ```powershell
   apex-log-viewer --json logs search "FATAL_ERROR|EXCEPTION_THROWN" --target-org my-org-alias
   ```

Use `logs resolve` when you need to prove whether a log is cached and where it lives:

```powershell
apex-log-viewer --json logs resolve 07L000000000001AAA --target-org my-org-alias
```

## Operational Writes

Writes are allowed only when the user explicitly asks for the operation. Prefer preview commands first:

```powershell
apex-log-viewer --json logs delete --target-org my-org-alias --scope mine --dry-run
apex-log-viewer --json trace-flags apply --target-org my-org-alias --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --dry-run
apex-log-viewer --json debug-levels create --target-org my-org-alias --developer-name ALV_DEBUG --master-label ALV_DEBUG --dry-run
```

Run live writes only with clear user intent and `--yes`:

```powershell
apex-log-viewer --json logs delete --target-org my-org-alias --scope mine --yes
apex-log-viewer --json trace-flags apply --target-org my-org-alias --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --yes
apex-log-viewer --json debug-levels delete --target-org my-org-alias --id 7dl000000000001AAA --yes
```

Do not run live `--scope all` log cleanup unless the user specifically asked to delete all org logs.

## Users, Trace Flags, And Debug Levels

Find users before applying a user-specific trace flag:

```powershell
apex-log-viewer --json users search "Ada Lovelace" --target-org my-org-alias --limit 10
```

Check status before changing trace flags:

```powershell
apex-log-viewer --json trace-flags status --target-org my-org-alias --current-user
apex-log-viewer --json trace-flags status --target-org my-org-alias --user-id 005000000000001AAA
```

List or inspect debug levels before creating duplicates:

```powershell
apex-log-viewer --json debug-levels list --target-org my-org-alias
apex-log-viewer --json debug-levels get --target-org my-org-alias --developer-name ALV_DEBUG
```

## Raw Read-Only Escape Hatches

Use raw Tooling commands only when typed commands cannot answer the question. Keep them read-only:

```powershell
apex-log-viewer --json tooling query "SELECT Id, StartTime, Operation, Status FROM ApexLog ORDER BY StartTime DESC LIMIT 5" --target-org my-org-alias
apex-log-viewer --json tooling request get "/services/data/v61.0/tooling/query/?q=SELECT+Id+FROM+ApexLog+LIMIT+1" --target-org my-org-alias
```

Raw POST, PATCH, and DELETE are intentionally out of scope for v1. Use typed commands for writes.

## Multi-Agent Handoff

When splitting work between agents, hand off stable IDs and JSON evidence, not vague instructions:

- Org resolver agent: runs `doctor`, `orgs list`, and `orgs resolve`; returns selected username, alias, and any warnings.
- Log investigator agent: runs `logs list`, `logs sync`, `logs read`, `logs search`, and `logs triage`; returns log IDs, timestamps, concise findings, and cache paths.
- Operations agent: runs only preview writes unless the user explicitly approved a live write; returns dry-run counts and the exact command that would require `--yes`.

Each handoff should include `--target-org`, command JSON, and whether any live write was requested or avoided.

