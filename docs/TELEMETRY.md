# Telemetry

This extension uses the official `@vscode/extension-telemetry` module to emit minimal, anonymized usage and error telemetry. Telemetry helps us prioritize features and improve reliability.

What we collect

- Activation and command usage counts (e.g. `command.refresh`, `command.tail`).
- Coarse performance timings (e.g., activation duration, log refresh time).
- Coarse environment info (platform, VS Code version) to understand compatibility.
- Non‑PII error categories (e.g. error names like `ETIMEDOUT`, not full messages or stacks).

What we do not collect

- No source code, Apex log contents, access tokens, usernames, org IDs, or instance URLs.
- No full error messages or stack traces that could contain PII.

Respecting user settings

- VS Code’s `telemetry.telemetryLevel` controls whether telemetry is sent (`off`, `crash`, `error`, `all`). When `off`, nothing is sent.
- The reporter respects the VS Code setting automatically; no additional configuration is required by users.

Opt‑out

- Set `"telemetry.telemetryLevel": "off"` in your VS Code settings to disable telemetry globally.

For maintainers

- The telemetry connection string is embedded in code as a constant and is not sensitive: `InstrumentationKey=4bb6665c-300d-4506-b2d6-5a47198cccde`.
- No CI injection or packaging steps are required.
- When adding events, avoid PII. Prefer counts, booleans, and coarse buckets. Never include usernames, org IDs, file paths, or log content.

GitHub Actions integration

- No special telemetry-related configuration is needed. Use the standard build/packaging steps.


References

- VS Code telemetry overview: https://code.visualstudio.com/docs/configure/telemetry
- Telemetry guide for extensions: https://code.visualstudio.com/api/extension-guides/telemetry

## Catálogo de eventos

- extension.install
  - props: version
  - meas: —

- extension.update
  - props: from, to
  - meas: —

- extension.activate
  - props: hasWorkspace = 'true'|'false'
  - meas: activationMs

- command.refresh
  - props: outcome = 'ok'|'error' (opcional)
  - meas: durationMs

- command.selectOrg
  - props: outcome = 'picked'|'cancel'|'error'; orgs = '0'|'1'|'2-5'|'6-10'|'10+' (opcional); hasDefault = 'true'|'false' (opcional); code (opcional)
  - meas: —

- command.tail
  - props: outcome (opcional)
  - meas: durationMs

- logs.refresh | logs.loadMore
  - props: outcome = 'ok'|'error'
  - meas: durationMs; pageSize | count (quando aplicável)

- orgs.list
  - props: view = 'logs'|'tail'; outcome = 'ok'|'error'
  - meas: durationMs; count

- debugLevels.load
  - props: outcome = 'ok'|'error'
  - meas: durationMs; count

- log.open
  - props: view = 'logs'|'tail'; outcome (opcional)
  - meas: durationMs

- logs.replay
  - props: view = 'logs'|'tail'; outcome = 'ok'|'error'
  - meas: durationMs

- tail.start
  - props: hasDebugLevel = 'true'|'false'; outcome (marcado automaticamente em caso de erro)
  - meas: durationMs

- tail.stop
  - props: reason = 'user'|'auto'|'viewDispose'|'orgChange'|'error'
  - meas: —
