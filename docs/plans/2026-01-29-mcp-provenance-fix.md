# MCP Provenance Publish Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix npm provenance validation by setting the MCP package repository metadata and re-run the `mcp-v0.1.0` release tag.

**Architecture:** Add a `repository` field to `apps/sf-plugin-apex-log-viewer-mcp/package.json` that matches the GitHub repo, then merge to `main` and recreate the `mcp-v0.1.0` tag so the release workflow can publish successfully.

**Tech Stack:** npm, GitHub Actions, git tags.

### Task 1: Add repository metadata to MCP package

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/package.json`

**Step 1: Write the failing test**

No automated test for package metadata; skip.

**Step 2: Add repository metadata**

```json
  "repository": {
    "type": "git",
    "url": "https://github.com/Electivus/Apex-Log-Viewer",
    "directory": "apps/sf-plugin-apex-log-viewer-mcp"
  }
```

Place it near `publishConfig` or after `engines`.

**Step 3: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/package.json
git commit -m "chore(mcp): add repository metadata"
```

### Task 2: Re-run the 0.1.0 release tag

**Files:**
- None (tag operations)

**Step 1: Ensure branch is merged to main**

Merge the PR with the metadata change into `main` before tagging.

**Step 2: Delete the old tag and re-tag**

```bash
git tag -d mcp-v0.1.0
git push origin :refs/tags/mcp-v0.1.0
git tag mcp-v0.1.0
git push origin mcp-v0.1.0
```

Expected: `MCP NPM Release` workflow re-runs and publishes `@electivus/sf-plugin-apex-log-viewer-mcp@0.1.0`.
