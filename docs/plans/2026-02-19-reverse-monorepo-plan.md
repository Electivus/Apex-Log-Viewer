# Reverse Monorepo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore the repository to a single root-based VS Code extension layout and remove all CLI/monorepo artifacts.

**Architecture:** Copy the extension project from `apps/vscode-extension` to root as canonical source, then delete monorepo-only directories and references. Update CI/CD and developer tooling to root-based paths only.

**Tech Stack:** Node.js 22, TypeScript, VS Code Extension toolchain, GitHub Actions.

---

### Task 1: Align root project files with extension canonical files

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.nls.json`
- Modify: `package.nls.pt-br.json`
- Modify: docs in `docs/`
- Copy into root: `src/`, `test/`, `playwright.config.ts` and root config/scripts from `apps/vscode-extension/`

**Step 1: Write the failing test**
- Not applicable for repository layout migration.

**Step 2: Run test to verify it fails**
- Baseline with `npm run build` should fail or be inconsistent in monorepo state.

**Step 3: Write minimal implementation**
- Promote extension root files from `apps/vscode-extension/` to root.

**Step 4: Run test to verify it passes**
- Run `npm run build`.

**Step 5: Commit**
```bash
git add package.json package-lock.json README.md CHANGELOG.md package.nls.json package.nls.pt-br.json docs src test playwright.config.ts
```

### Task 2: Remove CLI and monorepo artifacts

**Files:**
- Delete: `crates/`
- Delete: `Cargo.toml`
- Delete: `Cargo.lock`
- Delete: `scripts/cli-npm/`
- Delete: `.github/workflows/cli-npm-release.yml`

**Step 1: Write the failing test**
- Not applicable; structural cleanup.

**Step 2: Run test to verify it fails**
- `rg` should still show `crates/cli` and Cargo references before deletion.

**Step 3: Write minimal implementation**
- Remove all CLI directories/files and dedicated workflow.

**Step 4: Run test to verify it passes**
- `rg` should return no active CLI/Cargo references (excluding archived plan docs).

**Step 5: Commit**
```bash
git add -A
```

### Task 3: Update CI/CD and developer automation paths

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/prerelease.yml`
- Modify: `.github/workflows/e2e-playwright.yml`
- Modify: `.github/workflows/commitlint.yml`
- Modify: `.github/workflows/forbid-sensitive-files.yml`
- Modify: `.github/dependabot.yml`
- Modify: `.vscode/tasks.json`
- Modify: `.vscode/launch.json`

**Step 1: Write the failing test**
- Not applicable; workflow path migration.

**Step 2: Run test to verify it fails**
- Validate that workflows still reference `apps/vscode-extension` before patching.

**Step 3: Write minimal implementation**
- Move all workflow and tooling path references to root.

**Step 4: Run test to verify it passes**
- `rg` scan should show no root workflow references to `apps/vscode-extension`.

**Step 5: Commit**
```bash
git add .github/workflows .github/dependabot.yml .vscode/tasks.json .vscode/launch.json
```

### Task 4: Verification and final sweep

**Files:**
- Modify (if needed): any residual docs/config files flagged by search

**Step 1: Write the failing test**
- Use search assertions as regression checks.

**Step 2: Run test to verify it fails**
- `rg -n "apps/vscode-extension|crates/cli|Cargo.toml|Cargo.lock|apex-log-viewer-cli|cli-npm" -S --hidden --glob '!docs/plans/**'`

**Step 3: Write minimal implementation**
- Patch remaining references if found.

**Step 4: Run test to verify it passes**
- `npm run build`
- `npm run test:webview -- --runInBand`

**Step 5: Commit**
```bash
git add -A
```
