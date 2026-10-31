# `@electivus/plugin-electivus`

Salesforce CLI plugin for Apex Log Viewer terminal workflows. It exposes the class-per-command `sf electivus ...` surface backed by the private shared TypeScript core.

```bash
sf plugins install @electivus/plugin-electivus
sf electivus doctor --json
```

## Bundled Agent Skills (no GitHub access required)

After installing the plugin from npm or your corporate npm mirror, install its bundled skills without network access: `apex-log-viewer-cli` for CLI/capture operations, `apex-debug-investigate` for functional debugging, and `apex-debug-performance` for limits and profiling.

```bash
sf electivus skill install
sf electivus skill install --agent codex --agent claude-code --json
sf electivus skill install --all --agent codex --json
sf electivus skill install --skill apex-debug-investigate --skill apex-debug-performance --agent claude-code --json
sf electivus skill install --agent github-copilot --global
sf electivus skill install --agent devin --workspace-root ./my-project
sf electivus skill install --skills-dir ./custom-skills --dry-run
```

Without a destination, an interactive menu highlights detected agents and requires a selection. Project scope is the default. CI, redirected terminals and `--json` require `--agent` or `--skills-dir`. Repeated `--agent` flags support multiple agents; shared destinations are written once. `--skills-dir` is the parent directory, so the installer appends each selected skill name. Without `--skill` or `--all`, only `apex-log-viewer-cli` is installed. `--all` and `--skill` are mutually exclusive.

| Agent          | Project directory | Global directory                                                  |
| -------------- | ----------------- | ----------------------------------------------------------------- |
| Claude Code    | `.claude/skills`  | `$CLAUDE_CONFIG_DIR/skills`, default `~/.claude/skills`           |
| Codex          | `.agents/skills`  | `$CODEX_HOME/skills`, default `~/.codex/skills`                   |
| GitHub Copilot | `.agents/skills`  | `~/.copilot/skills`                                               |
| Devin          | `.devin/skills`   | `$XDG_CONFIG_HOME/devin/skills`, default `~/.config/devin/skills` |

The installer copies all bundled resources. Identical content is unchanged. Different content requires `--force`, including when previewing with `--dry-run`. Replacement removes stale files only inside the selected skill directory and preserves the previous copy if promotion fails. Symlinks/junctions and special files in an existing skill are refused even with `--force`; other skills remain untouched. Multiple destinations are preflighted together; if a later write fails, the error lists completed destinations so you can retry safely. If temporary-directory cleanup fails after a successful installation, that destination retains its successful status and includes a `warnings` entry with the cleanup path; the remaining destinations still run.

Update the plugin through your approved npm registry, then rerun the same skill installation with `--force`. Plugin updates alone do not modify installed skills. The offline installer does not create or modify `skills-lock.json`; do not mix it with the repository installer for the same destination. Copies created by the standard `skills` CLI retain that CLI's update lifecycle.

The old explicit `--codex-home <directory>` option still installs under `<directory>/skills`; it is deprecated and exclusive of the new destination flags. A bare invocation now asks for agents and defaults to the current project instead of silently installing globally for Codex. Without an explicit skill selection, JSON output preserves `skillName`, `pluginVersion`, `source`, `files`, `dryRun`, and `installations` (agents, scope, destination and status). With `--skill` or `--all`, output is `{ pluginVersion, dryRun, skills: [...] }`; each entry in `skills` contains that per-skill result. Every selected skill/destination is preflighted before writing.

## Custom logs

`sf electivus custom-log` reads application logs that a logging framework keeps in Salesforce records. Nebula Logger, unlocked or managed, needs no configuration: the commands detect it and work the same on both. Any other object is mapped in `sfdx-project.json` under `plugins.electivus.customLogs`, and the commands read that file from the project that contains the current directory.

```bash
sf electivus custom-log sources --target-org my-org --json
sf electivus custom-log list --target-org my-org --min-level ERROR --since 24h --limit 20 --json
sf electivus custom-log get --transaction-id <id> --target-org my-org --json
sf electivus custom-log entry --entry-id <id> --target-org my-org --json
sf electivus custom-log list --source app-log --payload-fields orderId,http.status --json
```

`list` and `get` take `--source` when more than one source is ready, and fail with `CUSTOM_LOG_SOURCE_REQUIRED` rather than guess. `nextCursor` is opaque; pass it back as `--cursor` with the same flags. A JSON payload field mapped on a source comes back as flat dot paths under `payload.values`; `--payload-fields` keeps only the paths you name, and `payloadFields` still lists every path on the page. `get` also returns the Apex debug log of the same request as `apexLog` (`linked`, `notFound`, `unavailable` with `reason: noAccess` when this user cannot read debug logs, or `noRequestId`); open it with `sf electivus log read --log-id <id>`.

### Event sources

A source that maps a platform event (`event` in `sfdx-project.json`, or the built-in `nebula-events`) has no records to query: Salesforce delivers each event once and keeps it for about 72 hours. `capture` subscribes and stores every event it receives under `apexlogs/orgs/<org>/events/<object>/`. After that, `list`, `get` and `entry` read the store and never contact the org, so they work offline. An event source is never chosen implicitly, because capturing spends the org's daily event delivery allocation: pass `--source`.

```bash
sf electivus custom-log capture --source app-events --target-org my-org --json
sf electivus custom-log list --source app-events --min-level ERROR --since 2026-10-28 --json
sf electivus custom-log capture --source app-events --target-org my-org --follow --min-level WARN
```

By default `capture` drains: it resumes from the stored position and stops when the stream goes quiet (`outcome: quiet`), after about half of the org's remaining daily allocation (`budget`), or after `--max-time` seconds (`timeLimit`, default 120). It prints one JSON result with `delivered`, `stored`, `newGaps` and `store`. A quiet stream does not prove the backlog was complete, but the stored position is exact, so stopping early costs one more run and loses nothing. A drain that hears nothing over a position older than one hour, or on a first run, waits the whole `--max-time`; lower it for a stream you know is quiet. The first run for an org replays what Salesforce still retains (`--initial retained`, the default) or starts with new events (`--initial new`). With `--follow` it keeps capturing, prints each stored row to stdout and state changes to stderr, and ends on Ctrl-C with the same result and exit code 0. A second Ctrl-C quits at once. Events published while nothing captured and older than 72 hours are lost; they show up as `store.gaps` and `newGaps` ("may be missing"), never silently.

Failures exit 1 and name their code in `name`, with next steps in `actions`: `CUSTOM_LOG_SOURCE_NOT_FOUND`, `CUSTOM_LOG_NOT_EVENT_SOURCE`, `CUSTOM_LOG_SOURCE_UNAVAILABLE`, `CUSTOM_LOG_UNSUPPORTED_FILTER`, `CUSTOM_LOG_STORE_UNAVAILABLE`, `CUSTOM_LOG_DELIVERY_LIMIT`, `CUSTOM_LOG_CLIENT_LIMIT`, `CUSTOM_LOG_SUBSCRIBE_FORBIDDEN` and `CUSTOM_LOG_CAPTURE_FAILED`. The stored position survives all of them, so running the command again resumes.

## Local investigation metadata

`sf electivus log sync --target-org my-org --json` downloads available logs in bulk. Its result includes absolute `apexlogsRoot` and `orgLogsRoot` paths, plus `failures` with stable `logId`/`code` pairs. Search local bodies under those paths rather than downloading candidates individually. `log status` works offline and includes the last sync's `failedCount`; `orgLogsRoot` is present only when a local org identity can be resolved.

Inspect the inner `result.status`: the Salesforce CLI can exit successfully for a partial sync. Retry recoverable partial downloads, and use `--force-full` to reconcile retained history behind the incremental checkpoint when needed. Logs that expired remotely cannot be recovered by a full sync.

The repository-based installer remains available; see the [installation and migration guide](https://github.com/Electivus/Apex-Log-Viewer/blob/main/docs/AGENT-SKILL.md).
