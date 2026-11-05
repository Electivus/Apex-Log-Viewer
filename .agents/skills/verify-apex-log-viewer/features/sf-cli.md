# sf electivus CLI plugin

The `sf electivus` Salesforce CLI plugin exposes the same core as the extension, for terminals and agents. It syncs Apex logs into the shared `apexlogs/` store, reports sync state, lists, reads and triages logs, manages trace flags and debug levels behind a preview, reads and captures custom logs, and installs the bundled Agent Skills.

## Sub-features

- `cli-log-sync` (`log sync`) downloads new logs into `apexlogs/orgs/<safe org username>/logs/<YYYY-MM-DD>/…` and advances `apexlogs/.alv/sync-state.json`. `--force-full` rescans every org log.
- `cli-log-status` (`log status`) reads the local state only: `hasState`, `logCount`, `lastSyncedLogId`, `lastSyncedStartTime`, `orgLogsRoot`, and the counts of the last sync.
- `cli-log-read` covers `log list`, `log read`, `log resolve`, `log triage` and `log delete`.
- `cli-trace-flag` covers `trace-flag status`, `apply` and `remove`. Each takes `--log-type DEVELOPER_LOG|USER_DEBUG` (default `DEVELOPER_LOG`) and echoes `result.logType`. Without a target flag the target is the current user; `--user-id`, `--current-user`, `--automated-process` and `--platform-integration` are mutually exclusive. `status` also reports `otherLogType` and a warning when the other type's flag matters. `remove` deletes every flag of the chosen type on the target, expired ones included.
- `cli-debug-level` covers `debug-level list`, `get`, `create`, `update` and `delete`.
- `cli-custom-log` covers `custom-log sources`, `list`, `get`, `entry` and `capture` (see [custom-logs.md](./custom-logs.md)).
- `cli-org-user-tooling` covers `org list`, `org resolve`, `user search`, `tooling query` and `tooling get` (read-only).
- `cli-doctor` (`doctor`) checks the runtime, the org auth and the local log store.
- `cli-skill-install` (`skill install --agent <a>|--skills-dir <dir> [--skill <name>…|--all] [--global] [--dry-run] [--force]`) copies the bundled Agent Skills.

## How to get to it (user POV)

- Run `sf electivus <topic> <command> [--json]` in an SFDX project, after installing `@electivus/plugin-electivus`. `--target-org <alias>` is optional when the project's `.sf/config.json` sets `target-org`.
- In this repo, `node packages/sf-plugin/bin/run.js electivus …` runs the local build. The verify session wraps that command.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`. The plugin is built (`start` runs `pnpm run build`, which includes `build:sf-plugin`).

Shorthand: `S` is `node .agents/skills/verify-apex-log-viewer/scripts/verify.mjs sf --`.

- **Status after extension activity.** After the `logs-open-viewer` step and the Logs panel's background sync, `S log status --json` exits 0 with `result.hasState: true` and `lastSyncedLogId` set to the newest log that sync listed. This proves both surfaces share `sync-state.json`. In a session where no panel refreshed yet, `hasState` is `false`.
- **Sync.** Seed a log, then run `S log sync --json`. It exits 0 with `result.status: "success"`, `downloaded ≥ 1` and `lastSyncedLogId` equal to the newest id. A second run returns `downloaded: 0, cached: 0` with `checkpointAdvanced: true`, because that flag only means the sync had no failures; compare `lastSyncedLogId` before and after instead. `S log sync --force-full --json` counts the stored logs as `cached`.
- **Read back.** After `logs-open-viewer`, `S log read --log-id <session.seeded.logId> --json` returns the dated path the panel's sync wrote, which proves the CLI reads the shared store. To prove a fetch from the org, read a log nothing has cached yet: run a step that returns `await h.seedLog()`, check `S log resolve --log-id <logId> --json` returns `cached: false`, then run `S log read --log-id <logId> --json`. The body contains the marker, and the log is now cached at `apexlogs/orgs/<safe org username>/logs/unknown-date/<logId>.log`. The panel's sync uses a dated folder instead, so the two layouts coexist. A panel refresh in between caches the log first, so read before you refresh.
- **Triage.** `S log triage --log-id <id from h.seedErrorLog()> --json` returns `result[0].summary` with `hasErrors: true`, `primaryReason: "Fatal exception"` and a `fatal_exception` reason at line 4.
- **Trace flags.** `S trace-flag status --json` reports the seeded flag: `logType: "DEVELOPER_LOG"`, `isActive: true`, `debugLevelName: "ALV_E2E"`. `S trace-flag apply --debug-level ALV_E2E --log-type USER_DEBUG --ttl-minutes 5 --json` previews `status: "dry-run"`; add `--yes` to create it. `S trace-flag status --log-type USER_DEBUG --json` then has `otherLogType: { logType: "DEVELOPER_LOG", isActive: true, … }` and `warnings[0]` `A DEVELOPER_LOG trace flag is also active on this target…`, the CLI side of the Debug Flags note. Finish with `S trace-flag remove --log-type USER_DEBUG --yes --json`, which leaves the seeded `DEVELOPER_LOG` flag alone.
- **Debug levels.** `S debug-level create --developer-name ALV_VERIFY_CLI --system FINE --yes --json` creates the level in `en_US`, then `get --developer-name …`. `update --id <id> --apex-code FINEST --yes --json` changes only that field, which a Tooling read-back proves. Without `--yes`, both commands preview and fail on a value the org's restricted picklists reject, such as `--language Bogus`. Finish with `delete --id <id> --yes`.
- **Delete.** `S log delete --log-id <id> --json` previews (`dryRun: true`, `logIds`); `--yes` deletes, and `S tooling query --soql "SELECT Id FROM ApexLog WHERE Id = '<id>'" --json` returns `totalSize: 0`.
- **Other topics.** `S doctor --json` (`status: "ok"`, `orgAuth.ok`, `workspaceRoot` = the session workspace), `S org resolve --json` (`source: "alias"`), `S user search --query alv.debugflags --json`, and from the session workspace `node <repo>/packages/sf-plugin/bin/run.js electivus skill install --skills-dir <scratch dir> --all --dry-run --json` (three skills, `status: "wouldInstall"`).
- **Proof.** Each `S` call writes `cli-<YYYYMMDD-HHMMSS.mmm>-sf-<first two non-flag arguments>.json` (command, cwd, exit code, stdout, stderr) to the evidence directory, for example `…-sf-log-sync.json`, or `…-sf-doctor-<alias>.json` for a one-word command, because the appended alias counts. stdout is exactly the command's stdout; the `verify: exit <n>; recorded <file>` line goes to stderr.

## Gotchas

- `verify.mjs sf` appends `--target-org <session alias>` unless you pass `--target-org` or `-o`. `org list` and `skill install` take no `--target-org`, so run them directly with `node packages/sf-plugin/bin/run.js electivus <cmd>`, with cwd set to the session workspace, and save their stdout yourself.
- The command runs with the session workspace as cwd, so `apexlogs/` paths in results point into the session workspace (`session.workspacePath`, under `$TMPDIR` on macOS), not the repo.
- Mutating commands preview by default: without `--yes`, or with `--dry-run`, they exit 0 and write nothing. The preview's `status` differs: `"dry-run"` for `trace-flag apply|remove`, `"success"` with `dryRun: true` for `log delete` and `debug-level *`. `custom-log capture` has no preview and spends the org's daily event allocation. Keep mutations to the harness org.
- `verify.mjs sf` never contacts the host, so it does not reset the 30-minute idle timer. In a CLI-only stretch, run `node $V doctor` now and then, or start with `--idle-minutes 60`.
- A CLI rebuild needs no session restart, because each call starts the plugin fresh.
- For CLI-only regression coverage without VS Code, use `pnpm run test:e2e:cli`.
