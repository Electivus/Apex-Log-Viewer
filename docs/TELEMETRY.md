# Telemetry

This extension uses the official `@vscode/extension-telemetry` module to emit minimal, coarse-grained usage and error telemetry. The telemetry contract is enforced by `src/shared/telemetry.ts` and documented publicly in the root `telemetry.json`.

What we collect

- Coarse command and workflow outcomes such as `ok`, `error`, `cancel`, `partial`, or `invoked`.
- Coarse performance timings such as `durationMs`.
- Small cardinality buckets such as `scope`, `view`, `sourceView`, `targetType`, `logType`, and org-count buckets.
- Coarse error codes such as `ENOENT`, `ETIMEDOUT`, `CLI_NOT_FOUND`, and `AUTH_FAILED`.
- Coarse plugin method names such as `org_list`, `org_auth`, `logs_list`, `logs_sync`, and `logs_triage`.
- Search-specific finite counters such as `matchCount` and `pendingCount`, plus bucketed `queryLength`.

What we do not collect

- No Apex log bodies, source code, access tokens, usernames, org IDs, instance URLs, file paths, or raw error messages.
- No custom telemetry properties outside the schema declared in `telemetry.json`.

Automatic metadata from VS Code

- `@vscode/extension-telemetry` adds `common.*` fields automatically.
- Treat these as platform metadata for diagnostics and version/platform slicing, not as primary product analytics dimensions.
- Do not add duplicate custom properties when the same information is already available through `common.*`.

Respecting user settings and modes

- VS Code's `telemetry.telemetryLevel` controls whether telemetry is sent. When it is `off`, nothing is sent.
- Telemetry is disabled automatically in Development and Test modes.
- Development/Test mode can opt in to a dedicated non-production App Insights target only when `ALV_ENABLE_TEST_TELEMETRY=1` and `ALV_TEST_TELEMETRY_CONNECTION_STRING` is provided.
- If `telemetry.json` is missing or invalid, telemetry becomes a no-op instead of sending schema-less data.

Opt-out

- Set `"telemetry.telemetryLevel": "off"` in VS Code settings to disable telemetry globally.

For maintainers

- The production connection string is intentionally checked in via `package.json.telemetryConnectionString`.
- `APPLICATIONINSIGHTS_CONNECTION_STRING` or `VSCODE_TELEMETRY_CONNECTION_STRING` can still override it for controlled experiments.
- Production telemetry resources live in a dedicated Azure subscription, resource group, Application Insights component, and linked Log Analytics workspace. Keep the live identifiers in CI variables or a private runbook, not in the public repo.
- Dedicated E2E telemetry flows use a separate Application Insights component that links to the same or another Log Analytics workspace.
- Both App Insights components are workspace-based (`IngestionMode: LogAnalytics`), so maintainers should query the linked workspace as the operational source of truth.
- In the monorepo, keep telemetry partitioned by user-facing environment (`prod` vs `e2e`), not by internal implementation detail.
- Every new event, property, or measurement must be added to `telemetry.json` before code is merged.
- Keep telemetry privacy-first: prefer booleans, enums, buckets, and finite counts. Never send raw strings that can drift into PII.
- `testRunId` is the only test-only custom property in the catalog. It is injected only during explicit E2E telemetry validation runs and only targets the dedicated E2E App Insights component.

Key runtime event families:

- `extension.activate`: one per activation. `durationMs` runs from the start of activation until project detection and the expired-cache cleanup finish, and `registrationMs` until the views and commands are registered, which happens before anything is awaited.
- `command.refresh`: command invocation timing for the main refresh workflow.
- `logs.search`: outcome, latency, match count, pending count, and query-length bucket for the in-view search experience.
- `cli.command`: coarse latency/outcome for `sf`/`sfdx` process execution.
- `core.request`: coarse latency/outcome for calls into the shared core bundled in the extension host. A Custom Logs capture is not timed as a request, because a subscription that stays open for hours would skew the latency data. A failure inside a capture update callback is reported as `core.request` with the method `custom_log_capture_callback`.
- `customLogs.capture.start` and `customLogs.capture.end`: one pair for each Custom Logs platform event capture run, however many panels watch it. `start` carries `from`, which is `position`, `retained`, `new`, `standby`, or `none`. `end` carries `outcome`, an optional error `code`, and the counts `durationMs`, `delivered`, `stored`, `gaps`, `reconnects`, and `dropped`. Neither event carries an event payload, an id, a cursor, an object name, or an org value.
- `debugFlags.apply` and `debugFlags.remove`: the outcome of applying or removing trace flags in the Apex Debug Flags panel. Both carry `sourceView`, `targetType`, and `logType`, which is `DEVELOPER_LOG` or `USER_DEBUG`, plus `durationMs`; `remove` also counts `removedCount` when it succeeds. The share of `USER_DEBUG` shows how often people move away from the `DEVELOPER_LOG` default. Neither event carries a user, a debug level name, or a trace flag id.
- `log.open` and `logs.replay`: the open-log and replay flows, with `view` set to `logs` or `tail`, `outcome`, and `durationMs`. `outcome` is `ok`, `error`, or `cancel` when the user cancels the progress notification, and `logs.replay` can also be `unavailable` when the Apex Replay Debugger cannot be made available. Tail's `log.open` shows no progress notification, so it never reports `cancel`. Older extension versions report Tail's `logs.replay` as `ok` for a cancel or an unavailable debugger, so check `CHANGELOG.md` for the version that fixed it before you compare its `ok` rate across versions or with the Logs view. For `log.open`, `durationMs` ends when the viewer panel is created, before it paints, so a cached log takes a few milliseconds and the time mostly reflects a download. Opening a linked log from Custom Logs is not counted. Neither event carries a log id, a user, or an org value.
- `tail.start`: one event per real start attempt from the Start button in the Tail view, with `outcome` (`ok`, `error`, or `cancel` when Tail stops before it subscribes, such as on Stop or on changing the org), an error `code` on `error`, and `durationMs`. A click while Tail is starting or running sends nothing. `command.tail` only counts opening the view. The event carries no log id, user, or org value.
- `host.responsiveness`: one event per five-minute window with webview messages, local desktop hosts only. `waitP50Ms`, `waitP90Ms`, and `waitMaxMs` are the time from the webview's `postMessage` to the start of our host handler; `loopP50Ms`, `loopP99Ms`, and `loopMaxMs` are how late a 20 ms extension host timer fired. The Output channel logs each measured wait as `<Surface>: <type> waited <N> ms in the extension host queue` (`Logs`, `Tail`, `LogViewer`, or `DebugFlags`), at info level from 250 ms and as a `[trace]` line otherwise.

KQL quick queries

Use `az monitor log-analytics query` against the workspace customer id for your environment. Workspace-based App Insights may return empty `customEvents` results even when the data is present in `AppEvents`.

Recent production events:

```bash
az monitor log-analytics query \
  -w <workspace-customer-id> \
  --analytics-query "AppEvents | where TimeGenerated > ago(7d) | where _ResourceId =~ '<prod-component-resource-id>' | project TimeGenerated, Name, Properties, Measurements | order by TimeGenerated desc | take 20"
```

Volume by event in the last 30 days:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ '<prod-component-resource-id>'
| summarize count() by Name
| order by count_ desc
```

Breakdown by outcome:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ '<prod-component-resource-id>'
| extend props = parse_json(Properties)
| extend outcome = tostring(props['outcome'])
| summarize count() by Name, outcome
| order by Name asc, count_ desc
```

Performance by event:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ '<prod-component-resource-id>'
| extend meas = parse_json(Measurements)
| extend durationMs = todouble(meas['durationMs'])
| where isfinite(durationMs)
| summarize avgMs = avg(durationMs), p50Ms = percentile(durationMs, 50), p95Ms = percentile(durationMs, 95) by Name
| order by p95Ms desc
```

Search latency by query bucket:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ '<prod-component-resource-id>'
| where Name == 'electivus.apex-log-viewer/logs.search'
| extend props = parse_json(Properties), meas = parse_json(Measurements)
| extend queryLength = tostring(props['queryLength']), outcome = tostring(props['outcome']), durationMs = todouble(meas['durationMs'])
| where outcome in ('searched', 'error')
| summarize total = count(), errors = countif(outcome == 'error'), p95Ms = percentile(durationMs, 95) by queryLength
| order by queryLength asc
```

Sf plugin request latency by method:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ '<prod-component-resource-id>'
| where Name == 'electivus.apex-log-viewer/core.request'
| extend props = parse_json(Properties), meas = parse_json(Measurements)
| extend method = tostring(props['method']), outcome = tostring(props['outcome']), durationMs = todouble(meas['durationMs'])
| summarize total = count(), errors = countif(outcome == 'error'), p95Ms = percentile(durationMs, 95) by method
| order by p95Ms desc
```

Version and platform split for activations:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ '<prod-component-resource-id>'
| where Name endswith 'extension.activate'
| extend props = parse_json(Properties)
| summarize count() by tostring(props['common.extversion']), tostring(props['common.os'])
| order by count_ desc
```

Schema hygiene checks:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ '<prod-component-resource-id>'
| extend props = parse_json(Properties)
| summarize missingOutcome = countif(isempty(tostring(props['outcome']))) by Name
| where missingOutcome > 0
```

Dedicated E2E run validation:

```kusto
AppEvents
| where TimeGenerated > ago(2h)
| where _ResourceId =~ '<e2e-component-resource-id>'
| extend props = parse_json(Properties)
| where tostring(props['testRunId']) == '<run-id>'
| summarize count() by Name
| order by count_ desc
```

See also: `docs/AZURE-MONITOR.md` for the reusable report script, workbook guidance, and recommended scheduled query alerts.

GitHub Actions and packaging

- Workflows can package or publish the VSIX without injecting telemetry secrets.
- Keep `telemetry.json` in the packaged file list so the runtime and users can inspect the contract shipped in the VSIX.
- `pnpm run test:e2e:telemetry` resolves the dedicated E2E App Insights connection string dynamically through `az`, so the test target stays out of the checked-in runtime package metadata.

References

- VS Code telemetry overview: https://code.visualstudio.com/docs/configure/telemetry
- VS Code extension telemetry guide: https://code.visualstudio.com/api/extension-guides/telemetry
