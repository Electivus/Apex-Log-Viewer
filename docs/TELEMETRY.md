# Telemetry

This extension uses the official `@vscode/extension-telemetry` module to emit minimal, coarse-grained usage and error telemetry. The telemetry contract is enforced by `src/shared/telemetry.ts` and documented publicly in the root `telemetry.json`.

What we collect

- Coarse command and workflow outcomes such as `ok`, `error`, `cancel`, `partial`, or `invoked`.
- Coarse performance timings such as `durationMs`.
- Small cardinality buckets such as `scope`, `view`, `sourceView`, `targetType`, and org-count buckets.
- Coarse error codes such as `ENOENT`, `ETIMEDOUT`, `CLI_NOT_FOUND`, and `AUTH_FAILED`.

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
- Production telemetry resources live in Azure subscription `c1b4d537-c3dc-4d64-b022-a97fd1826665`, resource group `rg-apex-log-viewer-telemetry-eastus`, Application Insights `appi-apex-log-viewer-telemetry-eastus`, and Log Analytics workspace `law-apex-log-viewer-telemetry-eastus`.
- Dedicated E2E telemetry flows use Application Insights `appi-apex-log-viewer-telemetry-e2e-eastus`.
- Every new event, property, or measurement must be added to `telemetry.json` before code is merged.
- Keep telemetry privacy-first: prefer booleans, enums, buckets, and finite counts. Never send raw strings that can drift into PII.
- `testRunId` is the only test-only custom property in the catalog. It is injected only during explicit E2E telemetry validation runs and only targets the dedicated E2E App Insights component.

KQL quick queries

Recent custom events:

```kusto
customEvents
| where timestamp > ago(7d)
| project timestamp, name, customDimensions, customMeasurements
| order by timestamp desc
| take 20
```

Volume by event in the last 30 days:

```kusto
customEvents
| where timestamp > ago(30d)
| summarize count() by name
| order by count_ desc
```

Breakdown by outcome:

```kusto
customEvents
| where timestamp > ago(30d)
| extend dims = parse_json(tostring(customDimensions))
| summarize count() by name, tostring(dims["outcome"])
| order by name asc, count_ desc
```

Performance by event:

```kusto
customEvents
| where timestamp > ago(30d)
| extend meas = parse_json(tostring(customMeasurements))
| extend durationMs = todouble(meas["durationMs"])
| where isfinite(durationMs)
| summarize avgMs = avg(durationMs), p50Ms = percentile(durationMs, 50), p95Ms = percentile(durationMs, 95) by name
| order by p95Ms desc
```

Version and platform split for activations:

```kusto
customEvents
| where timestamp > ago(30d)
| where name endswith "extension.activate"
| extend dims = parse_json(tostring(customDimensions))
| summarize count() by tostring(dims["common.extversion"]), tostring(dims["common.os"])
| order by count_ desc
```

Schema hygiene checks:

```kusto
customEvents
| where timestamp > ago(30d)
| extend dims = parse_json(tostring(customDimensions))
| summarize missingOutcome = countif(isempty(tostring(dims["outcome"]))) by name
| where missingOutcome > 0
```

Dedicated E2E run validation:

```kusto
customEvents
| where timestamp > ago(2h)
| extend dims = parse_json(tostring(customDimensions))
| where tostring(dims["testRunId"]) == "<run-id>"
| summarize count() by name
| order by count_ desc
```

GitHub Actions and packaging

- Workflows can package or publish the VSIX without injecting telemetry secrets.
- Keep `telemetry.json` in the packaged file list so the runtime and users can inspect the contract shipped in the VSIX.
- `npm run test:e2e:telemetry` resolves the dedicated E2E App Insights connection string dynamically through `az`, so the test target stays out of the checked-in runtime package metadata.

References

- VS Code telemetry overview: https://code.visualstudio.com/docs/configure/telemetry
- VS Code extension telemetry guide: https://code.visualstudio.com/api/extension-guides/telemetry
