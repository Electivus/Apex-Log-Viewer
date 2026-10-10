# sf electivus CLI plugin

The `sf electivus` Salesforce CLI plugin exposes the same core as the extension, for terminals and agents. It syncs Apex logs into the shared `apexlogs/` store, reports sync state, lists, reads and triages logs, and manages trace flags and debug levels with explicit safety flags.

## Sub-features

- `cli-log-sync` (`log sync`) downloads new logs into `apexlogs/orgs/<user>/logs/…` and advances `apexlogs/.alv/sync-state.json`.
- `cli-log-status` (`log status`) reports `logCount`, `downloadedCount`, `lastSyncedLogId` and the state file path for the workspace.
- `cli-log-read` covers `log list`, `log read`, `log resolve`, `log triage` and `log delete` (delete requires preview or confirmation).
- `cli-trace-flag` covers `trace-flag status`, `trace-flag apply` and `trace-flag remove`.
- `cli-debug-level` covers `debug-level list`, `get`, `create`, `update` and `delete`.
- `cli-org-user-tooling` covers `org list`, `org resolve`, `user search`, `tooling query` and `tooling get` (read-only).
- `cli-doctor` (`doctor`) checks the runtime and the local log store.

## How to get to it (user POV)

- Run `sf electivus <topic> <command> [--json] --target-org <alias>` in an SFDX project, after installing `@electivus/plugin-electivus`.
- In this repo, `node packages/sf-plugin/bin/run.js electivus …` runs the local build. The verify session wraps that command.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`. The plugin is built (`start` runs `pnpm run build`, which includes `build:sf-plugin`).

- **Status after extension activity.** Run `node .claude/skills/verify/scripts/verify.mjs sf -- log status --json` after the `logs-open-viewer` step. It exits 0, and `result.hasState` is `true` with `lastSyncedLogId` set to the newest log the extension downloaded. This proves both surfaces share `sync-state.json`.
- **Sync.** Run `node .claude/skills/verify/scripts/verify.mjs sf -- log sync --json`. It exits 0 with `result.status: "success"` and `downloaded + cached ≥ 1`. Logs the extension already fetched count as `cached`, and the checkpoint advances (`checkpointAdvanced: true`).
- **Read back.** Run `node .claude/skills/verify/scripts/verify.mjs sf -- log read --log-id <logId> --json` with the seeded `logId`. The returned body contains `session.seeded.marker`. After `logs-open-viewer`, that log is already cached, so this proves the local-store read. To prove a fetch from the org, read a log nothing has cached yet: run a step that returns `await h.seedLog()`, then read the returned `logId` before any search or sync. The body contains the new marker, and the log is now cached at `apexlogs/orgs/<user>/logs/unknown-date/<logId>.log`. The extension's search uses a dated folder instead, so the two layouts coexist.
- **Trace flags.** Run `node .claude/skills/verify/scripts/verify.mjs sf -- trace-flag status --user-id <005…> --json`, or pass `--current-user`, `--automated-process` or `--platform-integration`. The result matches what the Debug Flags editor shows for that target.
- **Proof.** Each call writes `cli-<time>-sf-<cmd>.json` (command, cwd, exit code, stdout, stderr) to the evidence directory.

## Gotchas

- `verify.mjs sf` appends `--target-org <session alias>` unless you pass `--target-org` or `-o`. `org list` and `skill install` take no `--target-org`, so run them directly with `node packages/sf-plugin/bin/run.js electivus <cmd>`, with cwd set to the session workspace.
- The command runs with the session workspace as cwd, so `apexlogs/` paths in results point into `/tmp/alv-e2e-ws-*`, not the repo.
- Mutating commands (`log delete`, `trace-flag apply|remove`, `debug-level create|update|delete`) require their explicit safety flags. Read `--help` first and keep them to the pool org.
- For CLI-only regression coverage without VS Code, use `pnpm run test:e2e:cli`.
