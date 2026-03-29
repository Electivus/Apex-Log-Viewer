# Azure Monitor Operations

This repository sends extension telemetry to Application Insights, but the production and E2E components are both workspace-based (`IngestionMode: LogAnalytics`). Treat the linked Log Analytics workspace as the operational source of truth for queries, workbooks, and alerts.

Public documentation should stay sanitized. Keep your live values in private parameter files, CI variables, or an internal runbook.

Typical values you will need when operating this stack:

- Subscription: `<subscription-id>`
- Resource group: `<telemetry-resource-group>`
- Production App Insights: `<prod-app-insights-name>`
- E2E App Insights: `<e2e-app-insights-name>`
- Workspace: `<log-analytics-workspace-name>`
- Workspace customer id: `<workspace-customer-id>`

## Quick Start

Generate the operational report used for documentation and telemetry reviews:

```bash
npm run telemetry:report -- \
  --app=<prod-app-insights-name> \
  --resource-group=<telemetry-resource-group> \
  --subscription=<subscription-id> \
  --lookback=30d
```

Useful overrides:

```bash
npm run telemetry:report -- \
  --app=<e2e-app-insights-name> \
  --resource-group=<telemetry-resource-group> \
  --subscription=<subscription-id> \
  --lookback=7d
npm run telemetry:report -- --subscription=<sub-id> --resource-group=<rg> --app=<app-name>
```

Direct workspace query example:

```bash
az monitor log-analytics query \
  -w <workspace-customer-id> \
  --analytics-query "AppEvents | where TimeGenerated > ago(30d) | summarize count() by Name"
```

## Workbook Recommendation

Add one workbook on top of `<log-analytics-workspace-name>` with these sections:

### Usage overview

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where Name startswith "electivus.apex-log-viewer/"
| summarize count() by Name
| order by count_ desc
```

### CLI and auth health

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where Name in ("electivus.apex-log-viewer/cli.exec", "electivus.apex-log-viewer/cli.getOrgAuth")
| extend props = parse_json(Properties)
| summarize count() by Name, code = tostring(props["code"])
| order by Name asc, count_ desc
```

### CLI command health

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where Name == "electivus.apex-log-viewer/cli.command"
| extend props = parse_json(Properties), measurements = parse_json(Measurements)
| extend command = tostring(props["command"]), outcome = tostring(props["outcome"]), durationMs = todouble(measurements["durationMs"])
| summarize total = count(), p50 = percentile(durationMs, 50), p95 = percentile(durationMs, 95) by command, outcome
| order by command asc, outcome asc
```

### Refresh health

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where Name == "electivus.apex-log-viewer/logs.refresh"
| extend props = parse_json(Properties)
| summarize total = count(), errors = countif(tostring(props["outcome"]) == "error")
| extend errorRate = round(100.0 * todouble(errors) / todouble(total), 2)
```

### Search health

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where Name == "electivus.apex-log-viewer/logs.search"
| extend props = parse_json(Properties), measurements = parse_json(Measurements)
| extend outcome = tostring(props["outcome"]), queryLength = tostring(props["queryLength"]), durationMs = todouble(measurements["durationMs"]), matchCount = todouble(measurements["matchCount"]), pendingCount = todouble(measurements["pendingCount"])
| summarize total = count(), errors = countif(outcome == "error"), p50 = percentile(durationMs, 50), p95 = percentile(durationMs, 95), avgMatches = avg(matchCount), avgPending = avg(pendingCount) by queryLength, outcome
| order by queryLength asc, outcome asc
```

### Daemon request health

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where Name == "electivus.apex-log-viewer/daemon.request"
| extend props = parse_json(Properties), measurements = parse_json(Measurements)
| extend method = tostring(props["method"]), outcome = tostring(props["outcome"]), durationMs = todouble(measurements["durationMs"]), attempts = todouble(measurements["attempts"])
| summarize total = count(), errors = countif(outcome == "error"), retries = countif(attempts > 1), p50 = percentile(durationMs, 50), p95 = percentile(durationMs, 95) by method
| order by p95 desc
```

### Debug Levels / Debug Flags health

```kusto
AppEvents
| where TimeGenerated > ago(30d)
| where Name == "electivus.apex-log-viewer/debugLevels.load"
| extend props = parse_json(Properties), measurements = parse_json(Measurements)
| extend outcome = tostring(props["outcome"]), durationMs = todouble(measurements["durationMs"])
| summarize total = count(), errors = countif(outcome == "error"), p50 = percentile(durationMs, 50), p95 = percentile(durationMs, 95)
| extend errorRate = round(100.0 * todouble(errors) / todouble(total), 2)
```

### Ingestion sanity

```kusto
AppEvents
| where TimeGenerated > ago(24h)
| where Name startswith "electivus.apex-log-viewer/"
| summarize events = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated)
```

## Alert Recommendation

Prefer scheduled query alerts over metric alerts. These extension signals live in `AppEvents`, not Azure platform metrics.

Recommended first alerts:

- `telemetry-no-data`: detect when extension events go dark for 24 hours.
- `cli-discovery-regression`: detect `ENOENT` and `CLI_NOT_FOUND` spikes from CLI discovery flows.
- `cli-timeout-spike`: detect `ETIMEDOUT` spikes from CLI execution or auth calls.
- `refresh-failure-rate-spike`: detect high `logs.refresh` error rate on the main workflow.
- `logs-search-degraded`: detect slow or failing search execution before it becomes user-visible.
- `daemon-request-degraded`: detect runtime retries, failures, or high latency in the bundled daemon.
- `debug-levels-degraded`: detect sustained `debugLevels.load` failures or severe latency.

Alert queries:

### telemetry-no-data

```kusto
AppEvents
| where TimeGenerated > ago(24h)
| where Name startswith "electivus.apex-log-viewer/"
| summarize events = count()
| where events == 0
```

### cli-discovery-regression

```kusto
AppEvents
| where TimeGenerated > ago(1h)
| where Name in ("electivus.apex-log-viewer/cli.exec", "electivus.apex-log-viewer/cli.getOrgAuth")
| extend props = parse_json(Properties)
| where tostring(props["code"]) in ("ENOENT", "CLI_NOT_FOUND")
| summarize failures = count()
| where failures >= 3
```

### cli-timeout-spike

```kusto
AppEvents
| where TimeGenerated > ago(1h)
| where Name in ("electivus.apex-log-viewer/cli.exec", "electivus.apex-log-viewer/cli.getOrgAuth")
| extend props = parse_json(Properties)
| where tostring(props["code"]) == "ETIMEDOUT"
| summarize failures = count()
| where failures >= 5
```

### refresh-failure-rate-spike

```kusto
AppEvents
| where TimeGenerated > ago(1h)
| where Name == "electivus.apex-log-viewer/logs.refresh"
| extend props = parse_json(Properties)
| summarize total = count(), errors = countif(tostring(props["outcome"]) == "error")
| extend errorRate = iff(total == 0, 0.0, 100.0 * todouble(errors) / todouble(total))
| where total >= 20 and errorRate >= 15
```

### debug-levels-degraded

```kusto
AppEvents
| where TimeGenerated > ago(2h)
| where Name == "electivus.apex-log-viewer/debugLevels.load"
| extend props = parse_json(Properties), measurements = parse_json(Measurements)
| extend outcome = tostring(props["outcome"]), durationMs = todouble(measurements["durationMs"])
| summarize total = count(), errors = countif(outcome == "error"), p95 = percentile(durationMs, 95)
| extend errorRate = iff(total == 0, 0.0, 100.0 * todouble(errors) / todouble(total))
| where total >= 5 and (errorRate >= 50 or p95 >= 60000)
```

### logs-search-degraded

```kusto
AppEvents
| where TimeGenerated > ago(2h)
| where Name == "electivus.apex-log-viewer/logs.search"
| extend props = parse_json(Properties), measurements = parse_json(Measurements)
| extend outcome = tostring(props["outcome"]), durationMs = todouble(measurements["durationMs"])
| where outcome in ("searched", "error")
| summarize total = count(), errors = countif(outcome == "error"), p95 = percentile(durationMs, 95)
| extend errorRate = iff(total == 0, 0.0, 100.0 * todouble(errors) / todouble(total))
| where total >= 10 and (errorRate >= 20 or p95 >= 5000)
```

### daemon-request-degraded

```kusto
AppEvents
| where TimeGenerated > ago(2h)
| where Name == "electivus.apex-log-viewer/daemon.request"
| extend props = parse_json(Properties), measurements = parse_json(Measurements)
| extend method = tostring(props["method"]), outcome = tostring(props["outcome"]), durationMs = todouble(measurements["durationMs"]), attempts = toint(measurements["attempts"])
| summarize total = count(), errors = countif(outcome == "error"), retries = countif(attempts > 1), p95 = percentile(durationMs, 95) by method
| extend errorRate = iff(total == 0, 0.0, 100.0 * todouble(errors) / todouble(total))
| where total >= 10 and (errorRate >= 20 or retries >= 3 or p95 >= 15000)
```

Operational notes:

- Create a dedicated action group for these alerts instead of relying on `Application Insights Smart Detection`.
- Align the shared workspace to `retentionInDays = 90` if you want enough history for regression comparisons across releases and seasonal traffic.
- In the monorepo, keep shared operational visibility in the same workspace and split user-facing environments with `_ResourceId` instead of creating separate Application Insights components for the JS CLI or the bundled daemon.
- Use `_ResourceId` or `ResourceGUID` when you need to split production and E2E telemetry inside the shared workspace.
