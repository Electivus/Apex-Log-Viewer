# Remove Claude Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove both Claude Code GitHub Actions workflows from the repository.

**Architecture:** This is a CI configuration cleanup. The implementation deletes the two Claude workflow YAML files and verifies that `.github/workflows` no longer contains Claude automation.

**Tech Stack:** GitHub Actions YAML, shell, `rg`, `git`.

---

## File Structure

- Delete: `.github/workflows/claude-code-review.yml`
  - Responsibility today: automatic Claude Code Review on pull request events.
- Delete: `.github/workflows/claude.yml`
  - Responsibility today: mention-triggered Claude Code runs from `@claude` comments or reviews.
- No product source files, test files, package manifests, or CI workflows other than the two Claude workflows should change.

### Task 1: Remove Claude Workflow Files

**Files:**
- Delete: `.github/workflows/claude-code-review.yml`
- Delete: `.github/workflows/claude.yml`

- [ ] **Step 1: Confirm both workflow files exist before removal**

Run:

```bash
test -f .github/workflows/claude-code-review.yml
test -f .github/workflows/claude.yml
```

Expected: both commands exit with status `0` and produce no output.

- [ ] **Step 2: Delete the workflow files**

Run:

```bash
git rm .github/workflows/claude-code-review.yml .github/workflows/claude.yml
```

Expected output includes:

```text
rm '.github/workflows/claude-code-review.yml'
rm '.github/workflows/claude.yml'
```

- [ ] **Step 3: Confirm Git sees exactly the workflow deletions plus plan/spec docs**

Run:

```bash
git status --short
```

Expected output includes the two workflow deletions:

```text
D  .github/workflows/claude-code-review.yml
D  .github/workflows/claude.yml
```

Expected: no unrelated source, package, runtime, or test files are modified.

### Task 2: Verify Claude Workflow Removal

**Files:**
- Inspect: `.github/workflows/`
- Inspect: repository references returned by `rg`

- [ ] **Step 1: List remaining workflow files**

Run:

```bash
rg --files .github/workflows
```

Expected: output does not include either of these paths:

```text
.github/workflows/claude-code-review.yml
.github/workflows/claude.yml
```

- [ ] **Step 2: Check for remaining Claude references in workflow files**

Run:

```bash
rg -n "claude|Claude|anthropic" .github/workflows
```

Expected: command exits with status `1` because there are no matches in `.github/workflows`.

- [ ] **Step 3: Check broader repository references**

Run:

```bash
rg -n "claude|Claude|anthropic" .github docs package.json README.md
```

Expected: matches outside `.github/workflows` may remain only if they are non-operational documentation or editor guidance. There should be no remaining Claude GitHub Actions workflow definition.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff -- .github/workflows/claude-code-review.yml .github/workflows/claude.yml
```

Expected: diff shows both workflow files deleted in full.

- [ ] **Step 5: Commit the workflow removal**

Run:

```bash
git add .github/workflows/claude-code-review.yml .github/workflows/claude.yml docs/superpowers/plans/2026-05-18-remove-claude-workflows.md
git commit -m "ci: remove claude workflows"
```

Expected: commit succeeds and includes the deleted workflow files and this implementation plan.
