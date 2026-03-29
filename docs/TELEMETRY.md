# Telemetry

This extension uses the official `@vscode/extension-telemetry` module to emit minimal, coarse-grained usage and error telemetry. The telemetry contract is enforced by `src/shared/telemetry.ts` and documented publicly in the root `telemetry.json`.

What we collect

- Coarse command and workflow outcomes such as `ok`, `error`, `cancel`, `partial`, or `invoked`.
- Coarse performance timings such as `durationMs`.
- Small cardinality buckets such as `scope`, `view`, `sourceView`, `targetType`, and org-count buckets.
- Coarse error codes such as `ENOENT`, `ETIMEDOUT`, `CLI_NOT_FOUND`, and `AUTH_FAILED`.
- Coarse daemon method names such as `initialize`, `org/list`, `org/auth`, `logs/list`, `search/query`, and `logs/triage`.
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
- In the monorepo, keep telemetry partitioned by user-facing environment (`prod` vs `e2e`), not by internal implementation detail. The legacy JS CLI path and the bundled daemon both emit into the same environment-specific components.
- Every new event, property, or measurement must be added to `telemetry.json` before code is merged.
- Keep telemetry privacy-first: prefer booleans, enums, buckets, and finite counts. Never send raw strings that can drift into PII.
- `testRunId` is the only test-only custom property in the catalog. It is injected only during explicit E2E telemetry validation runs and only targets the dedicated E2E App Insights component.

Key runtime event families:

- `command.refresh`: command invocation timing for the main refresh workflow.
- `logs.search`: outcome, latency, match count, pending count, and query-length bucket for the in-view search experience.
- `cli.command`: coarse latency/outcome for `sf`/`sfdx` process execution.
- `daemon.request`: coarse latency/outcome/retry count for calls into the bundled runtime daemon.

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
| where _ResourceId =~ "<prod-component-resource-id>"
| summarize count() by Name
| order by count_ desc
```

Breakdown by outcome:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ "<prod-component-resource-id>"
| extend props = parse_json(Properties)
| summarize count() by Name, outcome = tostring(props["outcome"])
| order by Name asc, count_ desc
```

Performance by event:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ "<prod-component-resource-id>"
| extend meas = parse_json(Measurements)
| extend durationMs = todouble(meas["durationMs"])
| where isfinite(durationMs)
| summarize avgMs = avg(durationMs), p50Ms = percentile(durationMs, 50), p95Ms = percentile(durationMs, 95) by Name
| order by p95Ms desc
```

Search latency by query bucket:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ "<prod-component-resource-id>"
| where Name == "electivus.apex-log-viewer/logs.search"
| extend props = parse_json(Properties), meas = parse_json(Measurements)
| extend queryLength = tostring(props["queryLength"]), outcome = tostring(props["outcome"]), durationMs = todouble(meas["durationMs"])
| where outcome in ("searched", "error")
| summarize total = count(), errors = countif(outcome == "error"), p95Ms = percentile(durationMs, 95) by queryLength
| order by queryLength asc
```

Daemon request latency by method:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ "<prod-component-resource-id>"
| where Name == "electivus.apex-log-viewer/daemon.request"
| extend props = parse_json(Properties), meas = parse_json(Measurements)
| extend method = tostring(props["method"]), outcome = tostring(props["outcome"]), durationMs = todouble(meas["durationMs"]), attempts = todouble(meas["attempts"])
| summarize total = count(), errors = countif(outcome == "error"), retries = countif(attempts > 1), p95Ms = percentile(durationMs, 95) by method
| order by p95Ms desc
```

Version and platform split for activations:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ "<prod-component-resource-id>"
| where Name endswith "extension.activate"
| extend props = parse_json(Properties)
| summarize count() by tostring(props["common.extversion"]), tostring(props["common.os"])
| order by count_ desc
```

Schema hygiene checks:

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where _ResourceId =~ "<prod-component-resource-id>"
| extend props = parse_json(Properties)
| summarize missingOutcome = countif(isempty(tostring(props["outcome"]))) by Name
| where missingOutcome > 0
```

Dedicated E2E run validation:

```kusto
AppEvents
| where TimeGenerated > ago(2h)
| where _ResourceId =~ "<e2e-component-resource-id>"
| extend props = parse_json(Properties)
| where tostring(props["testRunId"]) == "<run-id>"
| summarize count() by Name
| order by count_ desc
```

See also: `docs/AZURE-MONITOR.md` for the reusable report script, workbook guidance, and recommended scheduled query alerts.

GitHub Actions and packaging

- Workflows can package or publish the VSIX without injecting telemetry secrets.
- Keep `telemetry.json` in the packaged file list so the runtime and users can inspect the contract shipped in the VSIX.
- `npm run test:e2e:telemetry` resolves the dedicated E2E App Insights connection string dynamically through `az`, so the test target stays out of the checked-in runtime package metadata.

References

- VS Code telemetry overview: https://code.visualstudio.com/docs/configure/telemetry
- VS Code extension telemetry guide: https://code.visualstudio.com/api/extension-guides/telemetry
