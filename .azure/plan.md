# Azure Deployment Plan

> **Status:** Ready for Validation

Generated: 2026-03-08T16:30:00Z

---

## 1. Project Overview

**Goal:** Enable production telemetry for the Apex Log Viewer VS Code extension by provisioning Azure Monitor resources with Azure CLI and wiring the published VSIX to the checked-in Application Insights connection string.

**Path:** Add Components

---

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Production |
| Scale | Small |
| Budget | Cost-Optimized |
| **Subscription** | Azure subscription 1 (`c1b4d537-c3dc-4d64-b022-a97fd1826665`) |
| **Location** | `eastus` |

---

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| Apex Log Viewer | VS Code extension | TypeScript + `@vscode/extension-telemetry` | `src/`, `package.json` |
| Release packaging | CI workflow | GitHub Actions + `vsce` | `.github/workflows/` |

---

## 4. Recipe Selection

**Selected:** AZCLI

**Rationale:** The user asked for Azure CLI to perform all Azure-side configuration, and the extension already contains the required telemetry runtime. No infrastructure template changes are needed for this iteration.

---

## 5. Architecture

**Stack:** Client extension + Azure Monitor backend

### Service Mapping

| Component | Azure Service | SKU |
|-----------|---------------|-----|
| Extension telemetry backend | Application Insights (`appi-apex-log-viewer-telemetry-eastus`) | Workspace-based |
| Telemetry storage/query | Log Analytics (`law-apex-log-viewer-telemetry-eastus`) | PerGB2018 |

### Supporting Services

| Service | Purpose |
|---------|---------|
| Resource Group | Dedicated lifecycle boundary for telemetry resources |
| Log Analytics | Store and query custom events and exceptions |
| Application Insights | Receive extension telemetry from published VSIX builds |

---

## 6. Execution Checklist

### Phase 1: Planning
- [x] Analyze workspace
- [x] Gather requirements
- [x] Confirm subscription and location with user
- [x] Scan codebase
- [x] Select recipe
- [x] Plan architecture
- [x] **User approved this plan**

### Phase 2: Execution
- [x] Research components (load references, invoke skills)
- [x] Provision Azure resource group / workspace / Application Insights with Azure CLI
- [x] Update application configuration (`package.json.telemetryConnectionString`)
- [x] Record user-facing change in `CHANGELOG.md`
- [x] Update plan status to "Ready for Validation"

### Phase 3: Validation
- [x] Run build, test, and packaging checks
- [ ] Verify telemetry in a normal VS Code install
- [x] Record validation proof below

### Phase 4: Deployment
- [ ] Not applicable in this change set

---

## 7. Validation Proof

| Check | Command Run | Result | Timestamp |
|-------|-------------|--------|-----------|
| Azure subscription | `az account set -s c1b4d537-c3dc-4d64-b022-a97fd1826665` | ✅ Pass | 2026-03-08T16:27:00Z |
| Log Analytics workspace | `az monitor log-analytics workspace create --resource-group rg-apex-log-viewer-telemetry-eastus --workspace-name law-apex-log-viewer-telemetry-eastus --location eastus` | ✅ Pass | 2026-03-08T16:27:18Z |
| App Insights component | `az monitor app-insights component create --app appi-apex-log-viewer-telemetry-eastus --location eastus --resource-group rg-apex-log-viewer-telemetry-eastus --kind web --application-type web --workspace /subscriptions/c1b4d537-c3dc-4d64-b022-a97fd1826665/resourceGroups/rg-apex-log-viewer-telemetry-eastus/providers/Microsoft.OperationalInsights/workspaces/law-apex-log-viewer-telemetry-eastus` | ✅ Pass | 2026-03-08T16:24:32Z |
| Connection string lookup | `az monitor app-insights component show --app appi-apex-log-viewer-telemetry-eastus --resource-group rg-apex-log-viewer-telemetry-eastus --query connectionString -o tsv` | ✅ Pass | 2026-03-08T16:25:00Z |
| Build | `npm run build` | ✅ Pass | 2026-03-08T16:38:00Z |
| Webview tests | `npm run test:webview` | ✅ Pass | 2026-03-08T16:41:00Z |
| Extension unit tests | `bash scripts/run-tests.sh --scope=unit` | ✅ Pass | 2026-03-08T16:45:00Z |
| VSIX package | `npx --yes @vscode/vsce package` | ✅ Pass | 2026-03-08T16:47:00Z |
| App Insights query | `az monitor app-insights query -a appi-apex-log-viewer-telemetry-eastus -g rg-apex-log-viewer-telemetry-eastus --analytics-query "customEvents | order by timestamp desc | take 20"` | ⚠️ Empty result until a normal VS Code install emits live events | 2026-03-08T16:48:00Z |

Notes:

- `npm test` does not run as-is on this Windows environment because the package script uses Unix env-var syntax (`ENABLE_COVERAGE=1 ...`). The equivalent webview + unit test commands were run successfully instead.
- Coverage merge was not marked as passing because the `c8` coverage wrapper reported `branches = 0%` in this Windows + Electron environment even though the unit test runner completed with `151 passing`.
- Manual validation is still required in a normal VS Code installation because telemetry is intentionally disabled in Development and Test extension modes.

---

## 8. Files to Generate

| File | Purpose | Status |
|------|---------|--------|
| `.azure/plan.md` | Execution record for this Azure-backed change | ✅ |
| `package.json` | Checked-in telemetry connection string for published VSIX builds | ✅ |
| `CHANGELOG.md` | User-facing release note for live telemetry enablement | ✅ |
| `docs/TELEMETRY.md` | Maintainer notes for the provisioned Azure resources | ✅ |

---

## 9. Next Steps

> Current: update repo files, then run build/test/package validation

1. Install the packaged VSIX in a normal VS Code window and trigger a telemetry event such as `extension.activate` or `sfLogs.refresh`.
2. Re-run the documented `az monitor app-insights query` command and confirm at least one recent `customEvent`.
3. Merge and publish after manual telemetry verification is complete.
