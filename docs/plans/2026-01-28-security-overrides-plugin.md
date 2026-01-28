# Plugin Security Overrides Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve GitHub Security/Dependabot alerts for the sf plugin by applying npm overrides scoped to `apps/sf-plugin-apex-log-viewer` and regenerating its lockfile.

**Architecture:** Add an `overrides` block to `apps/sf-plugin-apex-log-viewer/package.json` with the patched versions reported by GitHub Security, including dual overrides for packages that have multiple vulnerable major versions (e.g., `js-yaml` and `brace-expansion`). Regenerate the plugin lockfile with `HUSKY=0` and `NPM_CONFIG_LEGACY_PEER_DEPS=true` so `npm ci` works in CI.

**Tech Stack:** npm, package.json overrides, package-lock.json

### Task 1: Capture current alerts (for reference)

**Files:**
- Modify: none

**Step 1: Fetch Dependabot alerts**

Run:
```bash
gh api -H "Accept: application/vnd.github+json" "/repos/Electivus/Apex-Log-Viewer/dependabot/alerts?state=open" > /tmp/dependabot-alerts.json
```
Expected: JSON file with open alerts (13 total)

**Step 2: Summarize alerts to confirm target packages**

Run:
```bash
node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('/tmp/dependabot-alerts.json','utf8'));const pkgs=[...new Set(data.map(a=>a.dependency?.package?.name).filter(Boolean))];console.log(pkgs.sort())"
```
Expected: list including @babel/traverse, form-data, glob, jws, braces, lodash, js-yaml, serialize-javascript, micromatch, @smithy/config-resolver, brace-expansion

### Task 2: Add overrides to the plugin package.json

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer/package.json`

**Step 1: Add overrides block**

Add the following under the top-level fields:

```json
"overrides": {
  "@babel/traverse": "7.23.2",
  "form-data": "4.0.4",
  "glob": "10.5.0",
  "jws": "3.2.3",
  "braces": "3.0.3",
  "lodash": "4.17.23",
  "serialize-javascript": "6.0.2",
  "micromatch": "4.0.8",
  "@smithy/config-resolver": "4.4.0",
  "js-yaml": "4.1.1",
  "js-yaml@^3.0.0": "3.14.2",
  "brace-expansion": "2.0.2",
  "brace-expansion@^1.0.0": "1.1.12"
}
```

### Task 3: Regenerate plugin lockfile with overrides

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer/package-lock.json`

**Step 1: Install with overrides applied**

Run:
```bash
cd apps/sf-plugin-apex-log-viewer
HUSKY=0 NPM_CONFIG_LEGACY_PEER_DEPS=true npm install --workspaces=false
```
Expected: lockfile updated to include override resolutions

**Step 2: Verify npm ci works**

Run:
```bash
HUSKY=0 NPM_CONFIG_LEGACY_PEER_DEPS=true npm ci --workspaces=false
```
Expected: success without lock mismatch

### Task 4: Commit and push

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer/package.json`
- Modify: `apps/sf-plugin-apex-log-viewer/package-lock.json`

**Step 1: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer/package.json apps/sf-plugin-apex-log-viewer/package-lock.json
git commit -m "chore(sf-plugin): add security overrides"
```

**Step 2: Push**

```bash
git push
```

### Task 5: Recheck Dependabot alerts (optional verification)

**Files:**
- Modify: none

**Step 1: Re-fetch alerts**

```bash
gh api -H "Accept: application/vnd.github+json" "/repos/Electivus/Apex-Log-Viewer/dependabot/alerts?state=open" > /tmp/dependabot-alerts.json
```
Expected: reduced alert count (or all resolved)
