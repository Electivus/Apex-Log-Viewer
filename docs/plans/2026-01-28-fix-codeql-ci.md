# Fix CodeQL Rust CI Failure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop CodeQL from running a Rust analysis job now that Rust code was removed, so CI passes.

**Architecture:** Add an explicit CodeQL workflow that limits the language matrix to `javascript` and `actions`, which prevents the auto-configured Rust job from being scheduled. Keep triggers aligned with current CI usage (PRs and main).

**Tech Stack:** GitHub Actions, CodeQL, YAML

### Task 1: Capture current failure context

**Files:**
- Modify: none

**Step 1: Inspect failing PR checks**

Run: `gh pr checks https://github.com/Electivus/Apex-Log-Viewer/pull/462`
Expected: `Analyze (rust)` failing, other checks passing

**Step 2: Pull failing run log**

Run: `gh run view 21438456078 --log | rg -n "Analyze \(rust\)|no rust|No Rust|error|failed|Failure|fatal" | head -n 80`
Expected: log mentions Rust analysis with no Rust source present

### Task 2: Add explicit CodeQL workflow

**Files:**
- Create: `.github/workflows/codeql.yml`

**Step 1: Write the workflow**

```yaml
name: "CodeQL"

on:
  push:
    branches: ["main"]
  pull_request:
    paths:
      - "**/*.ts"
      - "**/*.tsx"
      - "**/*.js"
      - "**/*.jsx"
      - ".github/workflows/**"
  schedule:
    - cron: "30 2 * * 6"

permissions:
  contents: read
  security-events: write

jobs:
  analyze:
    name: Analyze (${{ matrix.language }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        language: ["javascript", "actions"]
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v4
        with:
          languages: ${{ matrix.language }}

      - name: Autobuild
        uses: github/codeql-action/autobuild@v4

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v4
        with:
          category: "/language:${{ matrix.language }}"
```

**Step 2: Commit**

```bash
git add .github/workflows/codeql.yml
git commit -m "ci: configure codeql languages"
```

### Task 3: Push and recheck CI

**Files:**
- Modify: none

**Step 1: Push the branch**

Run: `git push`
Expected: remote branch updated

**Step 2: Recheck checks**

Run: `gh pr checks https://github.com/Electivus/Apex-Log-Viewer/pull/462`
Expected: no `Analyze (rust)` job; CodeQL jobs pass

### Task 4: Disable default CodeQL setup (remove Rust analysis)

**Files:**
- Modify: none

**Step 1: Disable default setup**

Run: `gh api -X PATCH /repos/Electivus/Apex-Log-Viewer/code-scanning/default-setup -f state=disabled`
Expected: JSON response with `state` set to `disabled`

**Step 2: Confirm default setup is disabled**

Run: `gh api /repos/Electivus/Apex-Log-Viewer/code-scanning/default-setup`
Expected: `state` is `disabled`
