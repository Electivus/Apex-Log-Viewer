# Remove Rust CLI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all Rust CLI artifacts, tooling, and documentation, leaving only the VS Code extension and `sf` plugin.

**Architecture:** Delete Rust crates and packaging scripts, remove Cargo config and CI workflows, update docs and configs to reflect the new scope.

**Tech Stack:** TypeScript, Node.js, VS Code extension, Salesforce CLI plugin.

---

### Task 1: Remove Rust source and Cargo metadata

**Files:**
- Delete: `crates/`
- Delete: `Cargo.toml`
- Delete: `Cargo.lock`
- Delete: `target/` (if tracked)

**Step 1: Delete Rust directories/files**
Run:
```
rm -rf crates Cargo.toml Cargo.lock target
```
Expected: Rust sources and Cargo metadata removed.

**Step 2: Commit**
```
git add -A
 git commit -m "chore: remove rust cli sources"
```

---

### Task 2: Remove Rust packaging scripts and tests

**Files:**
- Delete: `scripts/cli-npm/`
- Delete: `scripts/cli-npm/resolve-platform.test.cjs`

**Step 1: Delete CLI packaging scripts**
Run:
```
rm -rf scripts/cli-npm
```
Expected: Rust CLI packaging scripts removed.

**Step 2: Commit**
```
git add -A
 git commit -m "chore: remove rust cli packaging scripts"
```

---

### Task 3: Update CI/workflows and dependabot

**Files:**
- Modify: `.github/dependabot.yml`
- Delete: `.github/workflows/cli-npm-release.yml`

**Step 1: Remove cargo updates**
Edit `.github/dependabot.yml` to delete the cargo ecosystem entry.

**Step 2: Remove Rust CLI workflow**
Run:
```
rm -f .github/workflows/cli-npm-release.yml
```

**Step 3: Commit**
```
git add -A
 git commit -m "ci: drop rust cli automation"
```

---

### Task 4: Update documentation and references

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Search/adjust: any references to Rust CLI

**Step 1: Remove Rust CLI section from README**
Update `README.md` to remove the `CLI (Rust)` section and keep only the `sf` plugin and VS Code extension sections.

**Step 2: Add changelog entry**
Update `CHANGELOG.md` under **Unreleased**:
```
- Removed Rust CLI tooling and documentation; sf plugin is the supported CLI.
```

**Step 3: Verify no Rust references remain**
Run:
```
rg -n "cargo|rust|crates/cli|apex-log-viewer-cli" README.md docs scripts .github
```
Expected: no Rust CLI references (allow unrelated "rust" from dependencies if any).

**Step 4: Commit**
```
git add README.md CHANGELOG.md
 git commit -m "docs: remove rust cli references"
```

---

### Task 5: Full test pass (baseline)

**Step 1: Run plugin unit tests**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test
```
Expected: PASS.

**Step 2: Run repo unit suite**
Run:
```
npm run ext:test:unit
```
Expected: PASS.

