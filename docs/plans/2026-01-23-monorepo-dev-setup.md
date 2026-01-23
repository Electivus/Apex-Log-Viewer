# Monorepo Dev Setup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan.

**Goal:** Move dev tooling/CI to the repo root and roll back the VS Code extension’s dependency on the Rust CLI to avoid user impact.

**Architecture:** Root becomes the primary workspace with a lightweight `package.json` (workspaces + scripts). GitHub workflows and VS Code debug/tasks move to the root and target `apps/vscode-extension`. The extension returns to the original HTTP log-fetch flow; the CLI remains standalone in `crates/cli`.

**Tech Stack:** Node/npm (workspaces, scripts), VS Code launch/tasks, GitHub Actions, Rust (Cargo workspace).

---

### Task 1: Root package.json orchestration

**Files:**
- Create: `package.json`

**Step 1: Write the failing test**
- N/A (config-only task).

**Step 2: Run test to verify it fails**
- N/A.

**Step 3: Write minimal implementation**
Create root `package.json` with workspaces and scripts (example):

```json
{
  "name": "apex-log-viewer-monorepo",
  "private": true,
  "workspaces": ["apps/*"],
  "scripts": {
    "ext:install": "npm --prefix apps/vscode-extension ci",
    "ext:build": "npm --prefix apps/vscode-extension run build",
    "ext:watch": "npm --prefix apps/vscode-extension run watch",
    "ext:watch-tests": "npm --prefix apps/vscode-extension run watch-tests",
    "ext:lint": "npm --prefix apps/vscode-extension run lint",
    "ext:test": "npm --prefix apps/vscode-extension test",
    "ext:test:unit": "npm --prefix apps/vscode-extension run test:unit",
    "ext:test:integration": "npm --prefix apps/vscode-extension run test:integration",
    "ext:package": "npm --prefix apps/vscode-extension run package"
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npm run ext:build` (expects successful build output from `apps/vscode-extension`).

**Step 5: Commit**
```bash
git add package.json
git commit -m "chore: add root npm scripts"
```

---

### Task 2: Move VS Code debug/tasks to root

**Files:**
- Create: `.vscode/launch.json`
- Create: `.vscode/tasks.json`
- Delete: `apps/vscode-extension/.vscode/launch.json`
- Delete: `apps/vscode-extension/.vscode/tasks.json`
- Delete: `apps/vscode-extension/.vscode/settings.json`
- Delete: `apps/vscode-extension/.vscode/extensions.json`

**Step 1: Write the failing test**
- N/A (config-only task).

**Step 2: Run test to verify it fails**
- N/A.

**Step 3: Write minimal implementation**
Create root `.vscode/launch.json` with workspace-relative paths:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "runtimeExecutable": "${execPath}",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}/apps/vscode-extension"],
      "outFiles": ["${workspaceFolder}/apps/vscode-extension/dist/**/*.js"],
      "preLaunchTask": "ext:watch"
    },
    {
      "name": "Extension Tests",
      "type": "extensionHost",
      "request": "launch",
      "runtimeExecutable": "${execPath}",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}/apps/vscode-extension",
        "--extensionTestsPath=${workspaceFolder}/apps/vscode-extension/out/test/runner.js"
      ],
      "outFiles": ["${workspaceFolder}/apps/vscode-extension/out/test/**/*.js"],
      "preLaunchTask": "ext:watch-tests"
    }
  ]
}
```

Create root `.vscode/tasks.json` delegating to root scripts:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "ext:watch",
      "type": "npm",
      "script": "ext:watch",
      "isBackground": true,
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": [
        "$tsc-watch",
        {
          "owner": "esbuild",
          "fileLocation": ["relative", "${workspaceFolder}/apps/vscode-extension"],
          "pattern": { "regexp": "^✘ \\u005bERROR\\u005d (.*)$", "message": 1 },
          "background": {
            "activeOnStart": true,
            "beginsPattern": "^\\[watch\\] build started$",
            "endsPattern": "^\\[watch\\] build finished$"
          }
        }
      ]
    },
    {
      "label": "ext:watch-tests",
      "type": "npm",
      "script": "ext:watch-tests",
      "isBackground": true,
      "group": "test",
      "problemMatcher": ["$tsc-watch"]
    },
    {
      "label": "ext:compile",
      "type": "npm",
      "script": "ext:build",
      "group": "build",
      "problemMatcher": []
    }
  ]
}
```

**Step 4: Run test to verify it passes**
Run: `npm run ext:watch` (ensure watch starts without error, then stop).

**Step 5: Commit**
```bash
git add .vscode apps/vscode-extension/.vscode
git commit -m "chore: move vscode tasks to root"
```

---

### Task 3: Move GitHub config to root and update workflows

**Files:**
- Move: `apps/vscode-extension/.github/*` → `.github/*`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/prerelease.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/commitlint.yml`
- Modify: `.github/workflows/forbid-sensitive-files.yml`
- Modify: `.github/workflows/codex-review-auto-comment.yml`
- Modify: `.github/workflows/semantic-pr.yml`
- Modify: `.github/dependabot.yml`

**Step 1: Write the failing test**
- N/A (CI config).

**Step 2: Run test to verify it fails**
- N/A.

**Step 3: Write minimal implementation**
- Move `.github/` to root.
- Update workflow steps that run npm to use:
  - `working-directory: apps/vscode-extension`
  - or explicit `npm --prefix apps/vscode-extension ...`.
- Add `paths` filters to extension workflows (e.g., `apps/vscode-extension/**`, `.github/**`, `package.json`).
- Add CLI job in `ci.yml` (or separate workflow) to run:
  ```bash
  cargo test -p apex-log-viewer-cli
  ```
  with `paths` filter for `crates/cli/**`, `Cargo.toml`, `Cargo.lock`.
- Update `dependabot.yml`:
  - npm ecosystem directory → `/apps/vscode-extension`
  - optionally add a `cargo` ecosystem entry for `/`.

**Step 4: Run test to verify it passes**
- N/A locally; rely on CI.

**Step 5: Commit**
```bash
git add .github
git commit -m "chore: move github workflows to root"
```

---

### Task 4: Roll back CLI usage in the VS Code extension

**Files:**
- Delete: `apps/vscode-extension/src/utils/cliClient.ts`
- Modify: `apps/vscode-extension/src/services/logService.ts`
- Modify: `apps/vscode-extension/src/test/logService.test.ts`
- Modify: `apps/vscode-extension/src/test/provider.logs.behavior.test.ts`
- Delete: `apps/vscode-extension/src/test/cli.sync.test.ts`
- Modify: `apps/vscode-extension/package.json`
- Modify: `apps/vscode-extension/package.nls.json`
- Modify: `apps/vscode-extension/package.nls.pt-br.json`
- Modify: `apps/vscode-extension/README.md`
- Modify: `apps/vscode-extension/docs/ARCHITECTURE.md`
- Modify: `apps/vscode-extension/docs/SETTINGS.md`

**Step 1: Write the failing test**
Update tests to expect HTTP flow again:
- In `logService.test.ts`, assert `fetchApexLogs` is called in `fetchLogs`.
- In `provider.logs.behavior.test.ts`, remove stubs for `cliClient.syncLogs` and restore stubs for `fetchApexLogs`.
Run: `npm test -- --runInBand src/test/logService.test.ts` (should fail until code is reverted).

**Step 2: Run test to verify it fails**
Expected: tests fail due to missing HTTP call or leftover CLI behavior.

**Step 3: Write minimal implementation**
- Restore `LogService.fetchLogs` to call `fetchApexLogs` directly.
- Remove `cliClient` usage and file.
- Remove `electivus.apexLogs.cliPath` from `package.json` and both `package.nls*.json` files.
- Remove CLI docs from README and docs.
- Delete `cli.sync.test.ts`.

**Step 4: Run test to verify it passes**
Run: `npm test -- --runInBand src/test/logService.test.ts`
Expected: PASS.

**Step 5: Commit**
```bash
git add apps/vscode-extension
git commit -m "revert: decouple extension from rust cli"
```

---

### Task 5: Final verification

**Files:**
- N/A

**Step 1: Run full test suites**
```bash
cargo test -p apex-log-viewer-cli
npm run ext:test
```
Expected: all tests pass.

**Step 2: Commit (if needed)**
Only if verification required additional fixes.

---

Plan complete and saved to `docs/plans/2026-01-23-monorepo-dev-setup.md`.

Two execution options:

1. Subagent-Driven (this session) – I’ll execute task-by-task with review checkpoints.
2. Parallel Session (separate) – Open a new session and run via executing-plans.

Which approach?
