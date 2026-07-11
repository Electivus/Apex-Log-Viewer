# Settings

All extension settings use the `electivus.apexLogViewer.*` namespace. The previous `sfLogs.*` and `electivus.apexLogs.*` keys are not aliases and are not migrated automatically.

```jsonc
{
  "electivus.apexLogViewer.logs.pageSize": 100,
  "electivus.apexLogViewer.logs.processingConcurrency": 5,
  "electivus.apexLogViewer.logs.columns": {},
  "electivus.apexLogViewer.tail.bufferLines": 10000,
  "electivus.apexLogViewer.logging.trace": false
}
```

## Logs

- `electivus.apexLogViewer.logs.pageSize` — number, minimum `10`, default `100`; visible log rows fetched per page, with an effective maximum of 200.
- `electivus.apexLogViewer.logs.processingConcurrency` — number, minimum `1`, default `5`; concurrent log processing requests.
- `electivus.apexLogViewer.logs.columns` — object managed by the Logs panel; persists column visibility, order, and widths in user settings.

## Tail

- `electivus.apexLogViewer.tail.bufferLines` — number from `1000` to `200000`, default `10000`; maximum lines retained in the rolling tail buffer. Changes apply to an open Tail view immediately.

## Logging

- `electivus.apexLogViewer.logging.trace` — boolean, default `false`; enables verbose extension and shared-core diagnostics in the **Electivus Apex Log Viewer** output channel.

The extension no longer exposes a Salesforce CLI path, CLI cache TTLs, or a configurable log directory. The shared core reads Salesforce auth state directly and uses the canonical workspace `apexlogs/` store.
