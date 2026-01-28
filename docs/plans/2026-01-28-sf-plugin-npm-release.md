# sf Plugin NPM Release CI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add CI that publishes the `@electivus/sf-plugin-apex-log-viewer` npm package on tags `sf-plugin-v*` following best practices.

**Architecture:** Introduce a dedicated GitHub Actions workflow that validates tag/version match, runs plugin tests, and publishes with npm provenance. Update docs to describe the new release flow and required secrets.

**Tech Stack:** GitHub Actions, npm CLI, Node.js.

---

### Task 1: Add npm publish workflow

**Files:**
- Create: `.github/workflows/sf-plugin-npm-release.yml`

**Step 1: Create workflow**
Create `.github/workflows/sf-plugin-npm-release.yml` with:
```yaml
name: sf Plugin NPM Release

on:
  push:
    tags:
      - 'sf-plugin-v*'

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 22.x
          cache: npm
          cache-dependency-path: apps/sf-plugin-apex-log-viewer/package-lock.json

      - name: Verify tag matches package version
        working-directory: apps/sf-plugin-apex-log-viewer
        run: |
          TAG="${GITHUB_REF_NAME#sf-plugin-v}"
          PKG_VERSION=$(node -p "require('./package.json').version")
          if [ "$TAG" != "$PKG_VERSION" ]; then
            echo "Tag version ($TAG) does not match package.json version ($PKG_VERSION)"
            exit 1
          fi

      - name: Install dependencies
        working-directory: apps/sf-plugin-apex-log-viewer
        run: npm ci --workspaces=false

      - name: Run tests
        run: npm --prefix apps/sf-plugin-apex-log-viewer test

      - name: Publish
        working-directory: apps/sf-plugin-apex-log-viewer
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: npm publish --provenance
```

**Step 2: Commit**
```
git add .github/workflows/sf-plugin-npm-release.yml
 git commit -m "ci: add sf plugin npm release workflow"
```

---

### Task 2: Update docs for npm publish flow

**Files:**
- Modify: `docs/PUBLISHING.md`
- Modify: `docs/CI.md`

**Step 1: Update PUBLISHING.md**
Add a section describing `sf-plugin-v*` tag releases, matching `apps/sf-plugin-apex-log-viewer/package.json` version, and required `NPM_TOKEN` secret.

**Step 2: Update CI.md**
Add the new workflow to the workflow list and summarize what it does.

**Step 3: Commit**
```
git add docs/PUBLISHING.md docs/CI.md
 git commit -m "docs: add sf plugin npm release flow"
```

---

### Task 3: Verify

**Step 1: Lint/format not required**
No code changes to lint.

**Step 2: Dry check workflow assumptions**
Ensure `apps/sf-plugin-apex-log-viewer/package-lock.json` exists. If missing, run `npm --prefix apps/sf-plugin-apex-log-viewer install --package-lock-only` and add it.

**Step 3: Commit (if lockfile added)**
```
git add apps/sf-plugin-apex-log-viewer/package-lock.json
 git commit -m "chore(sf-plugin): add npm lockfile"
```

