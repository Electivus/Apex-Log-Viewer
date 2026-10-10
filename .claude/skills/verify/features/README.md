# Apex Log Viewer verification map

This directory is the maintained source for verifying the user-facing behavior of the Electivus Apex Log Viewer: the VS Code extension and the `sf electivus` CLI plugin. Read this index first, then use the matching feature file as the recipe. `../SKILL.md` covers the session itself (start, doctor, steps, evidence, stop).

## Baseline preconditions

- A session started with `node .claude/skills/verify/scripts/verify.mjs start` printed `"ready": true`.
- `node .claude/skills/verify/scripts/verify.mjs doctor` exits 0. Exit 2 means no session is running.
- The org is a pool scratch org (`org.strategy` is `pool`), and `session.seeded` holds one Apex log (`marker`, `logId`) created at start.
- VS Code shows the temporary workspace `alv-e2e-ws-*`, whose `.sf/config.json` sets `target-org` to the session org.
- No step has run yet, so no Electivus webview is open.

## Driving conventions

- Drive through palette titles (`Electivus Apex Logs: …`), webview buttons and the keyboard. Do not use internal commands or webview `postMessage`.
- Locate webviews with `h.logsFrame()`, `h.tailFrame()`, `h.viewerFrame()` and `h.debugFlagsFrame()`. Inside a frame, prefer `data-testid`, `data-log-id` and ARIA roles over text and position.
- Use `h.seedLog()` or `h.seedErrorLog()` to make data, and search for the returned `marker`. The org also contains logs from earlier runs.
- Put mutations of org state (trace flags, debug levels, deleted logs) back the way they were before the step returns.

## Proof and skip reporting

- UI proof is a screenshot of the action and one of the resulting state. Use `h.shot(name, frame)` for the webview and `node … shot` for the whole window.
- Side-effect proof uses a second channel: files under `session.workspacePath/apexlogs/`, a Tooling read through `h.tooling.*`, or `node … sf -- <cmd> --json`.
- CLI proof is the `cli-*.json` record (command, exit code, stdout, stderr).
- Report each feature ID with the entry point you used, for example "`logs-search` via the panel search box".
- If an entry point cannot be reached, report the attempted step and the unmet precondition. Do not report it as verified through a different path.

## Features

| Feature                                    | File                               | Canned step                | Last driven                       |
| ------------------------------------------ | ---------------------------------- | -------------------------- | --------------------------------- |
| Logs panel: list, search, filters, cleanup | [logs-panel.md](./logs-panel.md)   | —                          | 2026-10-10 (search, errors only)  |
| Log Viewer: open, search, filters, raw     | [log-viewer.md](./log-viewer.md)   | `logs-open-viewer`         | 2026-10-10                        |
| Tail: live logs                            | [tail.md](./tail.md)               | `tail-live`                | 2026-10-10                        |
| Debug Flags: trace flags and debug levels  | [debug-flags.md](./debug-flags.md) | `debug-flags-apply-remove` | 2026-10-10                        |
| `sf electivus` CLI plugin                  | [sf-cli.md](./sf-cli.md)           | —                          | 2026-10-10 (log sync, log status) |
