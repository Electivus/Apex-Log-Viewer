# Move CLI to crates/cli Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Relocate the Rust CLI from `apps/cli` to `crates/cli` and update workspace references, docs, and scripts accordingly.

**Architecture:** Keep VS Code extension in `apps/vscode-extension`, move Rust crate into `crates/cli`, and update root Cargo workspace and any docs referencing the CLI path.

**Tech Stack:** Rust workspace (Cargo), Node/VS Code extension docs.

---

### Task 1: Move the CLI crate into crates/cli

**Files:**
- Move: `apps/cli/` -> `crates/cli/`
- Modify: `Cargo.toml` (root workspace members)
- Modify: `README.md` (root)

**Step 1: Move the crate directory**
- Command: `mkdir -p crates && git mv apps/cli crates/cli`
- Expected: `crates/cli/Cargo.toml` exists.

**Step 2: Update Cargo workspace members**
- Edit root `Cargo.toml`:
```toml
[workspace]
members = ["crates/cli"]
resolver = "2"
```

**Step 3: Update root README**
- Replace references to `apps/cli` with `crates/cli`.

**Step 4: Commit**
```bash
git add Cargo.toml README.md crates/cli
git commit -m "chore: move cli to crates"
```

---

### Task 2: Update docs that mention CLI paths

**Files:**
- Modify: `docs/plans/2026-01-22-apex-log-viewer-cli-monorepo-design.md`
- Modify: `docs/plans/2026-01-22-apex-log-viewer-cli-monorepo-plan.md`
- Modify: `apps/vscode-extension/README.md` (if referencing apps/cli)

**Step 1: Update plan/design docs**
- Replace `apps/cli` with `crates/cli` in the monorepo design and plan docs.

**Step 2: Update extension README if needed**
- Ensure any references to CLI path are generic or updated.

**Step 3: Commit**
```bash
git add docs/plans/2026-01-22-apex-log-viewer-cli-monorepo-design.md docs/plans/2026-01-22-apex-log-viewer-cli-monorepo-plan.md apps/vscode-extension/README.md
git commit -m "docs: update cli path to crates"
```

---

### Task 3: Sanity check

**Files:**
- None

**Step 1: Build CLI**
```bash
cargo build -p apex-log-viewer-cli
```
Expected: success.

**Step 2: Commit any remaining changes**
```bash
git add Cargo.lock
```
