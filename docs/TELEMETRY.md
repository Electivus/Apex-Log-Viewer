# Telemetry

This extension may emit minimal, anonymized telemetry to help us improve quality and performance. This document explains what we intend to collect, how you can control it, and guidance for contributors who add instrumentation.

## What we collect (intent)

- Usage events: counts of high-level actions (e.g., commands like `sfLogs.refresh`, `sfLogs.tail`, opening the logs panel/diagram).
- Error categories: bounded, non‑PII classifications such as `ENOENT` (CLI not found), `ETIMEDOUT` (CLI timeout), or HTTP status ranges (`401`, `5xx`). No raw stack traces.
- Coarse performance timings: durations for operations like fetching a logs page (bucketed), not per‑log details.

We do not collect:
- Source code, Apex log contents, or any file contents.
- Access tokens, usernames, org IDs, instance URLs, or repository remotes.
- Free‑form user input or error messages that could contain sensitive data.

## How it’s controlled

The extension follows VS Code’s telemetry preference:

- Setting: `telemetry.telemetryLevel` (values: `off`, `crash`, `error`, `all`).
- If set to `off`, the extension does not send telemetry.
- You can change this in Settings → “telemetry”, or in `settings.json`.

## Contributor guidelines

- Respect user preference: do not emit events if telemetry is disabled.
- Keep events minimal and bounded: prefer enums/booleans/integers over free text.
- No PII or sensitive data: never include code, logs, tokens, usernames, org IDs, or URLs.
- Rate‑limit and/or sample: avoid spamming on high‑frequency operations (e.g., tail updates).
- Stable naming: use a namespaced event id like `apex-log-viewer/<area>/<action>` and short property names.
- Error reporting: record a categorical `errorKind` (e.g., `ENOENT`, `ETIMEDOUT`, `HTTP_401`) and a `where` scope; omit raw messages/stack traces.
- Document new events: update this file and `AGENTS.md` when adding or changing telemetry.

## Examples (proposed)

- `apex-log-viewer/command/invoked` with properties `{ cmd: 'sfLogs.refresh' }`
- `apex-log-viewer/logs/fetch` with properties `{ pageSize: 100, durationMsBucket: '100-300' }`
- `apex-log-viewer/tail/start` with properties `{ debugLevel: 'FINE' }` (do not include org info)
- `apex-log-viewer/error` with properties `{ where: 'cli.getOrgAuth', errorKind: 'ENOENT' }`

Note: these are examples for consistency; the code may implement a small wrapper to handle preference checks and bucketing.

## Opt‑out reminder

To opt out, set `"telemetry.telemetryLevel": "off"` in your VS Code settings.

