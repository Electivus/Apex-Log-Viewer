# MCP First Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a GitHub Actions workflow and documentation needed to publish `@electivus/sf-plugin-apex-log-viewer-mcp` version `0.1.0` via `mcp-v*` tags.

**Architecture:** Add a dedicated `mcp-npm-release.yml` workflow that validates tag/version, ensures tag commit is on `main`, builds/tests the MCP package, and publishes to npm with provenance. Update docs and package metadata for public scoped publishing safety.

**Tech Stack:** GitHub Actions, Node.js 22, npm.

### Task 1: Add MCP npm release workflow

**Files:**
- Create: `.github/workflows/mcp-npm-release.yml`

**Step 1: Write the failing test**

No automated test for workflow structure; skip.

**Step 2: Create the workflow**

```yaml
name: MCP NPM Release

on:
  push:
    tags:
      - 'mcp-v*'

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    environment: marketplace
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 22.x
          registry-url: https://registry.npmjs.org
          scope: '@electivus'
          cache: npm
          cache-dependency-path: apps/sf-plugin-apex-log-viewer-mcp/package-lock.json

      - name: Verify tag matches package version
        working-directory: apps/sf-plugin-apex-log-viewer-mcp
        run: |
          TAG="${GITHUB_REF_NAME#mcp-v}"
          PKG_VERSION=$(node -p "require('./package.json').version")
          if [ "$TAG" != "$PKG_VERSION" ]; then
            echo "Tag version ($TAG) does not match package.json version ($PKG_VERSION)"
            exit 1
          fi

      - name: Ensure tag commit is on main
        run: |
          git fetch origin main
          if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then
            echo "Tag commit is not on origin/main"
            exit 1
          fi

      - name: Install dependencies
        working-directory: apps/sf-plugin-apex-log-viewer-mcp
        env:
          NPM_CONFIG_LEGACY_PEER_DEPS: true
        run: npm ci --workspaces=false

      - name: Build
        working-directory: apps/sf-plugin-apex-log-viewer-mcp
        run: npm run build

      - name: Run tests
        run: npm --prefix apps/sf-plugin-apex-log-viewer-mcp test

      - name: Publish
        working-directory: apps/sf-plugin-apex-log-viewer-mcp
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: npm publish --provenance --access public
```

**Step 3: Run tests to verify**

No local test for workflow; skip.

**Step 4: Commit**

```bash
git add .github/workflows/mcp-npm-release.yml
git commit -m "ci(mcp): add npm release workflow"
```

### Task 2: Mark MCP package as public for scoped publish

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/package.json`

**Step 1: Write the failing test**

No automated test; skip.

**Step 2: Add publishConfig**

```json
  "publishConfig": {
    "access": "public"
  }
```

Place it near `engines` or after it.

**Step 3: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/package.json
git commit -m "chore(mcp): set publish access public"
```

### Task 3: Document MCP release flow

**Files:**
- Modify: `docs/PUBLISHING.md`
- Modify: `docs/CI.md`

**Step 1: Update PUBLISHING**

Add a section describing `mcp-v*` tags for `@electivus/sf-plugin-apex-log-viewer-mcp`, required `NPM_TOKEN`, and the tag/version matching rule.

**Step 2: Update CI doc**

Add a bullet for `mcp-npm-release.yml` describing trigger and scope.

**Step 3: Commit**

```bash
git add docs/PUBLISHING.md docs/CI.md
git commit -m "docs(mcp): add npm release docs"
```

### Task 4: Prepare and push the first release tag

**Files:**
- None (tagging)

**Step 1: Verify package version**

Run: `node -p "require('./apps/sf-plugin-apex-log-viewer-mcp/package.json').version"`
Expected: `0.1.0`

**Step 2: Create and push the tag**

```bash
git tag mcp-v0.1.0
git push origin mcp-v0.1.0
```

