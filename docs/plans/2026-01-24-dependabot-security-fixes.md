# Dependabot Security Fixes Implementation Plan

> **For the agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve all open Dependabot security alerts by updating vulnerable npm transitive dependencies in both lockfiles.

**Architecture:** Use patch-only dependency updates within existing semver ranges, update the extension workspace lockfile first, then refresh the root lockfile to align workspace resolution. Verify resolved versions and run focused tests.

**Tech Stack:** Node.js, npm workspaces, package-lock.json

### Task 1: Verify current vulnerable versions

**Files:**
- Read: `apps/vscode-extension/package-lock.json`
- Read: `package-lock.json`

**Step 1: Capture current versions in extension lockfile**

Run: `node -e 'const fs=require("fs");const lock=JSON.parse(fs.readFileSync("apps/vscode-extension/package-lock.json","utf8"));const pkgs=lock.packages||{};const find=(name)=>Object.entries(pkgs).filter(([k])=>k.includes(`node_modules/${name}`)).map(([k,v])=>({path:k,version:v.version}));for(const name of ["lodash","qs","glob","js-yaml"]){console.log(name, find(name));}'`
Expected: vulnerable versions such as lodash 4.17.21, qs 6.14.0, glob 10.4.5/11.0.3, js-yaml 4.1.0/3.14.1

**Step 2: Capture current versions in root lockfile**

Run: `node -e 'const fs=require("fs");const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8"));const pkgs=lock.packages||{};const find=(name)=>Object.entries(pkgs).filter(([k])=>k.includes(`node_modules/${name}`)).map(([k,v])=>({path:k,version:v.version}));for(const name of ["lodash","qs","glob","js-yaml"]){console.log(name, find(name));}'`
Expected: vulnerable versions listed (matching extension workspace)

**Step 3: Commit baseline evidence**

Run: `git status -sb`
Expected: clean working tree

### Task 2: Update extension lockfile to patched versions

**Files:**
- Modify: `apps/vscode-extension/package-lock.json`

**Step 1: Update targeted dependencies in extension workspace**

Run: `npm --prefix apps/vscode-extension update lodash qs glob js-yaml`
Expected: npm updates lockfile without errors

**Step 2: Verify patched versions in extension lockfile**

Run: `node -e 'const fs=require("fs");const lock=JSON.parse(fs.readFileSync("apps/vscode-extension/package-lock.json","utf8"));const pkgs=lock.packages||{};const find=(name)=>Object.entries(pkgs).filter(([k])=>k.includes(`node_modules/${name}`)).map(([k,v])=>({path:k,version:v.version}));for(const name of ["lodash","qs","glob","js-yaml"]){console.log(name, find(name));}'`
Expected: lodash 4.17.23, qs 6.14.1, glob 10.5.0 and/or 11.1.0, js-yaml 4.1.1 and 3.14.2

**Step 3: Commit extension lockfile update**

Run: `git add apps/vscode-extension/package-lock.json`
Run: `git commit -m "chore(deps): update extension lockfile security patches"`

### Task 3: Refresh root lockfile to match workspace resolution

**Files:**
- Modify: `package-lock.json`

**Step 1: Refresh root lockfile**

Run: `npm install`
Expected: root lockfile updated, no errors

**Step 2: Verify patched versions in root lockfile**

Run: `node -e 'const fs=require("fs");const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8"));const pkgs=lock.packages||{};const find=(name)=>Object.entries(pkgs).filter(([k])=>k.includes(`node_modules/${name}`)).map(([k,v])=>({path:k,version:v.version}));for(const name of ["lodash","qs","glob","js-yaml"]){console.log(name, find(name));}'`
Expected: lodash 4.17.23, qs 6.14.1, glob 10.5.0 and/or 11.1.0, js-yaml 4.1.1 and 3.14.2

**Step 3: Commit root lockfile update**

Run: `git add package-lock.json`
Run: `git commit -m "chore(deps): refresh root lockfile"`

### Task 4: Verification and regression check

**Files:**
- Read: `apps/vscode-extension/package-lock.json`
- Read: `package-lock.json`

**Step 1: Verify via npm ls (root)**

Run: `npm ls lodash qs glob js-yaml`
Expected: all resolved versions are patched

**Step 2: Verify via npm ls (extension)**

Run: `npm --prefix apps/vscode-extension ls lodash qs glob js-yaml`
Expected: all resolved versions are patched

**Step 3: Run focused webview tests**

Run: `npm --prefix apps/vscode-extension run test:webview -- --ci --runInBand`
Expected: PASS (13 suites / 48 tests)

**Step 4: Commit verification note**

Run: `git status -sb`
Expected: clean working tree
