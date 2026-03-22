# Azure Deployment Plan

> **Status:** Ready for Validation

Generated: 2026-03-22T22:15:00Z

---

## 1. Project Overview

**Goal:** Add a versioned Azure Monitor IaC area to the repository so the shared workspace, Application Insights components, workbook scaffolding, and alert scaffolding can be reviewed and deployed from source control.

**Path:** Modernize existing Azure Monitor operations

---

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Production-adjacent operations |
| Scale | Small |
| Budget | Cost-Optimized |
| Subscription | Kept outside the public repo |
| Location | Parameterized |

---

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| Apex Log Viewer | VS Code extension | TypeScript + `@vscode/extension-telemetry` | `src/`, `package.json` |
| Azure telemetry operations | Documentation + scripts | Markdown + Node.js + Azure CLI | `docs/`, `scripts/` |
| Azure monitor IaC | Infrastructure as code | Bicep | `infra/azure-monitor/` |

---

## 4. Recipe Selection

**Selected:** Bicep + Azure CLI deployment helper

**Rationale:** The repository already operates against Azure Monitor resources directly, and Bicep gives a lightweight, Azure-native way to version the monitor stack without introducing Terraform state for a small observability surface.

---

## 5. Architecture

**Stack:** VS Code extension + workspace-based Azure Monitor backend

### Service Mapping

| Component | Azure Service | Notes |
|-----------|---------------|-------|
| Shared telemetry store | Log Analytics workspace | Source of truth for `AppEvents` queries |
| Runtime telemetry ingress | Application Insights components | One production component and one dedicated E2E component |
| Dashboards | Azure Workbook | Parameterized and safe for public source |
| Notifications | Action Group + scheduled query alerts | Optional and parameterized |

---

## 6. Execution Checklist

### Phase 1: Planning
- [x] Analyze workspace
- [x] Gather requirements
- [x] Scan existing Azure-related docs and scripts
- [x] Select recipe
- [x] Plan architecture
- [x] User approved adding a versioned Azure Monitor area to the repo

### Phase 2: Execution
- [x] Add `infra/azure-monitor/` with Bicep modules
- [x] Add a deploy helper script for resource-group deployments
- [x] Add sanitized parameter starter file
- [x] Sanitize public docs and internal plan of live identifiers
- [x] Validate Bicep and script wiring locally

### Phase 3: Validation
- [x] Compile Bicep successfully
- [x] Check helper script usage
- [x] Review remaining public docs for live Azure identifiers

---

## 7. Files to Generate or Update

| File | Purpose | Status |
|------|---------|--------|
| `.azure/plan.md` | Execution record for this Azure-backed change | ✅ |
| `infra/azure-monitor/main.bicep` | Entry point for Azure Monitor IaC | ✅ |
| `infra/azure-monitor/modules/*.bicep` | Reusable monitor modules | ✅ |
| `infra/azure-monitor/workbook.json` | Workbook scaffold | ✅ |
| `infra/azure-monitor/parameters/apex-log-viewer.bicepparam` | Sanitized starter parameters | ✅ |
| `scripts/deploy-azure-monitor.js` | Deployment helper | ✅ |
| `docs/TELEMETRY.md` | Sanitized operational guidance | ✅ |
| `docs/AZURE-MONITOR.md` | Sanitized Azure Monitor operations guide | ✅ |
| `docs/TESTING.md` | Sanitized E2E telemetry guidance | ✅ |
| `docs/CI.md` | Sanitized CI guidance | ✅ |

---

## 8. Notes

- Public documentation should use placeholders such as `<subscription-id>` and `<workspace-customer-id>`.
- Live defaults that identify production Azure resources should stay in CI variables, private parameter files, or an internal runbook.
- The repo can safely keep IaC structure, KQL patterns, alert logic, and workbook definitions in public source control.
- Local Bicep validation succeeded with `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 az bicep build --file infra/azure-monitor/main.bicep` in this environment.
