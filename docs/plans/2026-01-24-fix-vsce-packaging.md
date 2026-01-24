# VSCE Packaging No-Dependencies Fix Implementation Plan

> **For the agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent VSCE packaging from pulling the workspace root into the extension VSIX so the nightly packaging jobs stop failing.

**Architecture:** Update the GitHub Actions packaging steps to invoke `vsce package` with `--no-dependencies`, which skips dependency auto-detection that drags in workspace root files. Mirror the same flag in local `vsce:package` scripts for consistency.

**Tech Stack:** GitHub Actions, Node.js, @vscode/vsce.

### Task 1: Reproduce the packaging scope issue locally

**Files:**
- None

**Step 1: Run VSCE listing with dependencies (expected to show parent entry)**

Run: `cd apps/vscode-extension && npx --yes @vscode/vsce ls --tree --no-yarn`
Expected: Output includes a `../` entry (or similar parent path) indicating workspace root files are being pulled in.

**Step 2: Run VSCE listing without dependencies**

Run: `cd apps/vscode-extension && npx --yes @vscode/vsce ls --tree --no-yarn --no-dependencies`
Expected: Output shows only extension files (no `../` entry).

### Task 2: Update nightly packaging workflow

**Files:**
- Modify: `.github/workflows/prerelease.yml`

**Step 1: Add `--no-dependencies` to the VSCE package args**

Update the Node packaging step to include the new flag:

```js
const args = ['--yes', '@vscode/vsce', 'package', '--no-yarn', '--no-dependencies', '--target', target, '--out', outName, '--pre-release'];
```

**Step 2: Save and format (YAML only)**

### Task 3: Update release packaging workflow

**Files:**
- Modify: `.github/workflows/release.yml`

**Step 1: Add `--no-dependencies` to the VSCE package args**

```js
const args = ['--yes', '@vscode/vsce', 'package', '--no-yarn', '--no-dependencies', '--target', target, '--out', outName];
```

### Task 4: Align local VSCE scripts

**Files:**
- Modify: `apps/vscode-extension/package.json`

**Step 1: Update scripts to include `--no-dependencies`**

```json
"vsce:package": "vsce package --no-dependencies",
"vsce:package:pre": "vsce package --pre-release --no-dependencies"
```

### Task 5: Verify packaging command locally

**Files:**
- None

**Step 1: Run a targeted package command**

Run: `cd apps/vscode-extension && npx --yes @vscode/vsce package --no-yarn --no-dependencies --target linux-x64 --out /tmp/apex-log-viewer-no-deps.vsix --pre-release`
Expected: Command completes without `invalid relative path` errors and creates the VSIX.

### Task 6: Commit

**Step 1: Stage changes**

Run: `git add .github/workflows/prerelease.yml .github/workflows/release.yml apps/vscode-extension/package.json`

**Step 2: Commit**

Run: `git commit -m "chore(ci): disable vsce dependency packaging"`
