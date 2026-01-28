# Fix NPM Release CI Husky Failure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the `sf Plugin NPM Release` workflow publish successfully by skipping Husky installation during CI.

**Architecture:** Update the publish workflow to set `HUSKY=0` during `npm ci` (or disable the postinstall hook) so the job does not fail due to missing `.git` in the workspace.

**Tech Stack:** GitHub Actions, npm, Husky

### Task 1: Verify the failure and capture evidence

**Files:**
- Modify: none

**Step 1: Inspect the failed publish run**

Run: `gh run view 21439935724 --log | rg -n "husky|postinstall|Command failed" | head -n 40`
Expected: failure mentions `yarn husky install` and `.git can't be found`

### Task 2: Update publish workflow to skip Husky

**Files:**
- Modify: `.github/workflows/sf-plugin-npm-release.yml`

**Step 1: Add HUSKY=0 for dependency install**

Update the `Install dependencies` step to:

```yaml
      - name: Install dependencies
        working-directory: apps/sf-plugin-apex-log-viewer
        env:
          HUSKY: 0
        run: npm ci --workspaces=false
```

**Step 2: Commit**

```bash
git add .github/workflows/sf-plugin-npm-release.yml
git commit -m "ci: skip husky during npm publish"
```

### Task 3: Re-tag and trigger publish

**Files:**
- Modify: none

**Step 1: Move tag to new commit on main**

```bash
git fetch origin main
git tag -f sf-plugin-v0.1.0 origin/main
git push origin :refs/tags/sf-plugin-v0.1.0
git push origin sf-plugin-v0.1.0
```

**Step 2: Watch workflow**

Run: `gh run watch --workflow sf-plugin-npm-release.yml`
Expected: publish job succeeds
