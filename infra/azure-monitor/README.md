# Azure Monitor IaC

This folder is the versioned Azure Monitor home for the extension. It is meant to keep observability resources deployable and reviewable from the repository instead of drifting in the Azure portal.

## What it covers

- Shared Log Analytics workspace
- Production Application Insights component
- Dedicated E2E Application Insights component
- Optional workbook
- Optional dedicated action group
- Optional scheduled query alerts for the production component, including CLI/auth, search, and daemon regressions

## Files

- `main.bicep`: entry point for the Azure Monitor stack
- `modules/app-insights.bicep`: workspace-based Application Insights module
- `modules/action-group.bicep`: optional dedicated action group
- `modules/scheduled-query-rule.bicep`: reusable scheduled query alert rule module
- `workbook.json`: workbook definition loaded by `main.bicep`
- `parameters/apex-log-viewer.bicepparam`: sanitized starter parameters

## Security posture

This folder is designed for a public repository:

- No subscription ids are hardcoded.
- No resource ids are hardcoded.
- No connection strings are checked into the template inputs.
- Alerts filter on the production component by resource id generated at deployment time.

You should still keep environment-specific parameter files and receiver details out of the public repo when they identify real production endpoints or people.

## Deployment

Preview the deployment:

```bash
npm run azure:monitor:what-if -- \
  --resource-group=<resource-group> \
  --parameters-file=infra/azure-monitor/parameters/apex-log-viewer.bicepparam
```

Create or update the stack:

```bash
npm run azure:monitor:deploy -- \
  --resource-group=<resource-group> \
  --parameters-file=infra/azure-monitor/parameters/apex-log-viewer.bicepparam
```

To deploy alerts, either:

- pass `--set deployActionGroup=true` and provide receivers in a private parameters file, or
- keep `deployActionGroup=false` and pass an existing `existingActionGroupResourceId` through a private parameters file.

## Operational guidance

- Set `workspaceRetentionInDays=90` for the shared workspace unless your environment has a stricter retention policy.
- Keep production and E2E in the same workspace and split them with `_ResourceId`; keep separate App Insights components by user-facing environment rather than by internal process.
- Keep `deployAlerts=false` in sanitized public parameter files until a dedicated action group exists, but enable it in private/live deployments.
- Treat the workspace as the operational source of truth for `AppEvents`.
- Run `az bicep build --file infra/azure-monitor/main.bicep` in CI to catch schema drift early.
