# Telemetry Review (2026-03-13)

## Scope

- Reviewed the current telemetry implementation in the extension host and provider flows.
- Queried the production Application Insights component for the live environment.
- Validated the current dataset shape against the new privacy-first telemetry contract.

## Findings

### High

1. **Required `outcome` was missing from major event families in the current dataset.**
   - Over the last 30 days, the following events were emitted without `outcome`:
     - `extension.activate`: 160
     - `extension.activate.duration`: 160
     - `cli.exec`: 19
     - `cli.getOrgAuth`: 14
     - `command.showOutput`: 6
     - `command.openLogInViewer`: 4
   - This made failure rates and funnel analysis inconsistent across command and lifecycle flows.

2. **Activation duration was modeled as a second event instead of a measurement on `extension.activate`.**
   - `extension.activate.duration` duplicated every activation and doubled event volume for the same lifecycle action.
   - This made simple volume and funnel queries noisier than necessary.

### Medium

3. **The public telemetry schema was implicit in code and docs, not governed by a checked-in contract.**
   - Before this change, there was no `telemetry.json` catalog to make the event set auditable or testable.
   - That increased the chance of drift, accidental property growth, and undocumented event additions.

4. **Production data shows shallow feature coverage for several important flows.**
   - In the last 30 days there were no observed events for:
     - `command.selectOrg`
     - `command.refresh`
     - `command.tail`
     - `command.troubleshootWebview`
     - `command.resetCliCache`
     - `debugFlags.remove`
     - `logs.replay`
     - `log.open`
   - This is either true low usage or a visibility gap from old builds and partial instrumentation.

### Low

5. **Operational docs were out of sync with the actual connection string strategy.**
   - The repo currently ships the production `telemetryConnectionString` in `package.json`, with optional environment overrides for local validation and packaging.
   - The previous docs implied a release-time injection path that no longer matched the implementation.

## Current Azure Insights

These findings come from live App Insights queries run on 2026-03-13 with 30-day lookback.

### Event volume

| Event | Count |
| --- | ---: |
| `extension.activate` | 160 |
| `extension.activate.duration` | 160 |
| `logs.refresh` | 125 |
| `orgs.list` | 34 |
| `cli.exec` | 19 |
| `cli.getOrgAuth` | 14 |
| `debugFlags.apply` | 7 |
| `command.showOutput` | 6 |
| `debugLevels.load` | 6 |
| `command.openLogInViewer` | 4 |
| `logs.cleanup` | 4 |
| `logs.loadMore` | 1 |
| `logs.downloadAll` | 1 |

The 7-day window returned the same counts, which indicates the current dataset is concentrated in the last week.

### Outcome breakdown

Only a subset of existing events currently expose `outcome` consistently:

| Event | Outcome | Count |
| --- | --- | ---: |
| `logs.refresh` | `ok` | 122 |
| `logs.refresh` | `error` | 3 |
| `orgs.list` | `ok` | 33 |
| `orgs.list` | `error` | 1 |
| `debugFlags.apply` | `ok` | 7 |
| `debugLevels.load` | `ok` | 6 |
| `logs.cleanup` | `done` | 4 |
| `logs.downloadAll` | `partial` | 1 |
| `logs.loadMore` | `ok` | 1 |

### Error rates

| Event | Errors | Total | Error rate |
| --- | ---: | ---: | ---: |
| `orgs.list` | 1 | 34 | 2.94% |
| `logs.refresh` | 3 | 125 | 2.40% |

No exceptions were present in the `exceptions` table for the same 30-day window.

### Performance snapshots

| Event | p50 (ms) | p95 (ms) | Samples |
| --- | ---: | ---: | ---: |
| `extension.activate.duration` | 1,946 | 23,069 | 160 |
| `logs.refresh` | 739 | 53,785 | 125 |
| `orgs.list` | 24 | 71,637 | 34 |
| `debugFlags.apply` | 1,891 | 2,861 | 7 |
| `debugLevels.load` | 3,047 | 45,412 | 6 |
| `logs.cleanup` | 16,051 | 74,607 | 4 |
| `logs.loadMore` | 661 | 661 | 1 |
| `logs.downloadAll` | 409,434 | 409,434 | 1 |

### Version and platform spread

Most events in the current window came from:

- `0.32.0` on `win32`: 185 events
- `0.32.0` on `darwin`: 116 events
- empty `common.extversion` / `common.os`: 106 events
- `0.33.2` on `linux`: 55 events

The empty version/platform bucket is another reason to treat `common.*` as useful platform metadata rather than the primary product analytics contract.

## Changes Implemented

### Contract and privacy

- Added a checked-in telemetry catalog in `telemetry.json`.
- Enforced event allowlisting, property allowlisting, measurement allowlisting, and required properties in the telemetry wrapper.
- Made schema validation fail closed for undeclared events and undeclared fields.
- Restricted product analytics dimensions to coarse-grained values and documented banned data classes:
  - usernames
  - org identifiers
  - instance URLs
  - file paths
  - log content
  - raw error messages

### Event model

- Unified activation timing onto `extension.activate` with `durationMs`.
- Removed the separate `extension.activate.duration` emission from the extension activation flow.
- Added explicit `outcome` values to command events that previously omitted them.
- Added telemetry for `command.resetCliCache`.
- Normalized provider events so `logs.cleanup`, `logs.downloadAll`, and `log.open` always emit the declared fields expected by the schema.

### Governance and docs

- Updated telemetry docs to reflect the actual connection string strategy and the new contract.
- Added KQL quick queries for event volume, outcome breakdown, performance, version/platform split, and schema hygiene.
- Aligned maintainer instructions with the shipping telemetry model.

### Tests

- Expanded telemetry wrapper tests to cover:
  - production-only activation
  - environment override precedence
  - swallowed reporter failures
  - undeclared event drops
  - undeclared field drops
  - required `outcome`
  - error-event normalization
- Added a contract test that scans emitted telemetry event names in source and fails if any event is missing from `telemetry.json`.

## Remaining Validation

The code and tests now enforce the new contract locally, but the Azure dataset still reflects mostly pre-change telemetry. After the next build that includes these changes, run the following manual smoke flows and confirm the resulting events in App Insights:

1. Activate the extension in a Salesforce project.
2. Run:
   - `Refresh Logs`
   - `Select Org`
   - `Tail Logs`
   - `Open Log In Viewer`
   - `Download All`
   - `Cleanup Logs`
   - `Apply Debug Flags`
   - `Remove Debug Flags`
   - `Reset CLI Cache`
3. Verify that:
   - `extension.activate` includes `durationMs` and no separate duration event exists
   - every command event has `outcome`
   - `cli.exec` and `cli.getOrgAuth` follow the declared schema
   - no custom event arrives with undeclared properties or measurements

## Recommended Next Pass

1. Re-query App Insights after the next packaged build is exercised.
2. Confirm the old missing-`outcome` buckets stop growing.
3. If product usage analysis becomes important, add stable funnel points for:
   - org selection success
   - tail start/stop
   - log open success
   - download completion
