# Apex Log Viewer verification map

This directory is the maintained source for verifying the user-facing behavior of the Electivus Apex Log Viewer: the VS Code extension and the `sf electivus` CLI plugin. Read this index first, then use the matching feature file as the recipe. `../SKILL.md` covers the session itself (start, doctor, steps, evidence, stop).

## Baseline preconditions

- A session started with `node .agents/skills/verify-apex-log-viewer/scripts/verify.mjs start` printed `"ready": true`.
- `node .agents/skills/verify-apex-log-viewer/scripts/verify.mjs doctor` exits 0. Exit 2 means no session is running.
- The org is a harness scratch: `org.strategy` is `pool` for a pool slot (`SF_SCRATCH_POOL_NAME` or `SF_SCRATCH_STRATEGY=pool`), otherwise `single`, the reused `ALV_E2E_Scratch`. Start seeded it with an `ALV_E2E` debug level, a 60-minute `DEVELOPER_LOG` trace flag at that level on the authenticated user, and one Apex log (`session.seeded.marker`, `session.seeded.logId`).
- VS Code shows the temporary workspace `alv-e2e-ws-*`, whose `.sf/config.json` sets `target-org` to the session org. The profile sets `window.dialogStyle` to `custom`, so modal confirmations render in the workbench, and `workbench.quickOpen.closeOnFocusLost` to `false`, so a webview taking the focus cannot close the palette.
- No step has run yet, so no Electivus webview is open.

## Driving conventions

- Drive through palette titles (`Electivus Apex Logs: …`), webview buttons and the keyboard. Do not use internal commands or webview `postMessage`.
- Locate webviews with `h.logsFrame()`, `h.tailFrame()`, `h.viewerFrame()`, `h.debugFlagsFrame()`, `h.customLogsFrame()` and `h.customLogViewerFrame()`. Inside a frame, prefer `data-testid`, `data-log-id` and ARIA roles over text and position.
- Check the `Org` select before any write. Logs, Tail and each editor copy keep their own org, and the Debug Flags editor opened from Tail starts on Tail's org.
- Use `h.seedLog()` or `h.seedErrorLog()` to make data, and search for the returned `marker`. The org also contains logs from earlier runs.
- Put mutations of org state (trace flags, debug levels, deleted logs, records) back the way they were before the step returns.

## Proof and skip reporting

- UI proof is a screenshot of the action and one of the resulting state. Use `h.shot(name, frame)` for the webview and `node … shot` for the whole window.
- Side-effect proof uses a second channel: files under `session.workspacePath/apexlogs/`, a Tooling read through `h.tooling.*`, or `node … sf -- <cmd> --json`.
- CLI proof is the `cli-*.json` record (command, exit code, stdout, stderr).
- Report each feature ID with the entry point you used, for example "`logs-search` via the panel search box".
- If an entry point cannot be reached, report the attempted step and the unmet precondition. Do not report it as verified through a different path.

## Features

| Feature                                         | File                               | Canned steps                                                                     | Last driven                                                                                  |
| ----------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Logs panel: list, search, filters, cleanup      | [logs-panel.md](./logs-panel.md)   | `logs-open-viewer`                                                               | 2026-11-06 (all sub-features; Replay only without the extension)                             |
| Log Viewer: open, search, filters, raw          | [log-viewer.md](./log-viewer.md)   | `logs-open-viewer`                                                               | 2026-11-06 (all entry points, `pt-br` included)                                              |
| Tail: live logs                                 | [tail.md](./tail.md)               | `tail-live`                                                                      | 2026-11-06 (all but the 30-minute stop)                                                      |
| Debug Flags: trace flags and debug levels       | [debug-flags.md](./debug-flags.md) | `debug-flags-apply-remove`                                                       | 2026-11-06 (all sub-features)                                                                |
| Custom Logs: list, viewer, JSON columns, events | [custom-logs.md](./custom-logs.md) | `custom-logs-setting`, `custom-logs-open-viewer`, `events-capture`, `events-gap` | 2026-11-06 records on the harness scratch and events on `alv-events`; no Nebula org          |
| `sf electivus` CLI plugin                       | [sf-cli.md](./sf-cli.md)           | —                                                                                | 2026-11-06 (every topic; `custom-log capture` drain, `--follow` and refusal on `alv-events`) |
