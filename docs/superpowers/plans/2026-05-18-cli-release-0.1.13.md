# CLI Release 0.1.13 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare a pull request that bumps the standalone Rust CLI/runtime release train from `0.1.12` to `0.1.13`.

**Architecture:** The Rust CLI release workflow validates the pushed `rust-vX.Y.Z` tag against `crates/alv-cli/Cargo.toml`, then packages all runtime crates and npm native/meta packages with that version. The extension packaging path reads `config/runtime-bundle.json`, so the release prep must keep crate versions, internal dependency constraints, lockfile metadata, runtime bundle metadata, and packaging guard tests aligned.

**Tech Stack:** Rust Cargo workspace, GitHub Actions Rust CLI release workflow, Node.js 24, `node:test` packaging guard tests.

---

### Task 1: Bump Release Metadata

**Files:**
- Modify: `crates/alv-cli/Cargo.toml`
- Modify: `crates/alv-core/Cargo.toml`
- Modify: `crates/alv-app-server/Cargo.toml`
- Modify: `crates/alv-protocol/Cargo.toml`
- Modify: `crates/alv-mcp/Cargo.toml`
- Modify: `config/runtime-bundle.json`
- Modify: `CHANGELOG.md`
- Modify: `scripts/packaging-ci.test.js`
- Modify: `Cargo.lock`
- Create: `docs/superpowers/plans/2026-05-18-cli-release-0.1.13.md`

- [ ] **Step 1: Update Rust crate package versions**

Change every first-party runtime crate package version from `0.1.12` to `0.1.13` in:

```toml
version = "0.1.13"
```

- [ ] **Step 2: Update internal Rust dependency constraints**

In `crates/alv-cli/Cargo.toml`, set:

```toml
alv-app-server = { version = "0.1.13", path = "../alv-app-server" }
alv-core = { version = "0.1.13", path = "../alv-core" }
```

In `crates/alv-app-server/Cargo.toml`, set:

```toml
alv-core = { version = "0.1.13", path = "../alv-core" }
alv-protocol = { version = "0.1.13", path = "../alv-protocol" }
```

- [ ] **Step 3: Update extension runtime bundle metadata**

In `config/runtime-bundle.json`, replace the version and tag with:

```json
{
  "cliVersion": "0.1.13",
  "tag": "rust-v0.1.13",
  "channel": "stable",
  "protocolVersion": "1"
}
```

- [ ] **Step 4: Update the changelog release-prep bullet**

Under `CHANGELOG.md` `Unreleased` chores, replace the existing `0.1.12` CLI/runtime bump bullet with:

```markdown
- CLI/Runtime: bump the standalone runtime train to `0.1.13` so the CLI release packages the SQLite index removal and shared runtime fixes.
```

- [ ] **Step 5: Update packaging guard expectations**

In `scripts/packaging-ci.test.js`, update the expected pinned runtime bundle object to:

```js
{
  cliVersion: '0.1.13',
  tag: 'rust-v0.1.13',
  channel: 'stable',
  protocolVersion: '1'
}
```

- [ ] **Step 6: Refresh Cargo lock metadata**

Run:

```bash
cargo check -p apex-log-viewer-cli
```

Expected: command exits `0` and updates first-party package versions in `Cargo.lock` to `0.1.13`.

- [ ] **Step 7: Commit release metadata**

Run:

```bash
git add Cargo.lock CHANGELOG.md config/runtime-bundle.json crates/alv-cli/Cargo.toml crates/alv-core/Cargo.toml crates/alv-app-server/Cargo.toml crates/alv-protocol/Cargo.toml crates/alv-mcp/Cargo.toml scripts/packaging-ci.test.js docs/superpowers/plans/2026-05-18-cli-release-0.1.13.md
git commit -m "chore(cli): prepare 0.1.13 release"
```

Expected: commit succeeds on branch `chore/cli-release-0.1.13`.

### Task 2: Verify And Open PR

**Files:**
- Read: `Cargo.lock`
- Read: `config/runtime-bundle.json`
- Read: `scripts/packaging-ci.test.js`

- [ ] **Step 1: Run focused release guard tests**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24.15.0 >/dev/null && node --test scripts/packaging-ci.test.js scripts/fetch-runtime-release.test.js scripts/build-cli-npm-packages.test.js
```

Expected: all listed `node:test` suites pass with exit `0`.

- [ ] **Step 2: Run Rust smoke tests**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24.15.0 >/dev/null && npm run test:rust:smoke
```

Expected: Rust smoke tests pass with exit `0`.

- [ ] **Step 3: Check worktree status**

Run:

```bash
git status --short --branch
```

Expected: branch `chore/cli-release-0.1.13` is clean after the release commit.

- [ ] **Step 4: Push and open the PR**

Run:

```bash
git push -u origin chore/cli-release-0.1.13
gh pr create --base main --head chore/cli-release-0.1.13 --title "chore(cli): prepare 0.1.13 release" --body-file /tmp/alv-cli-release-0.1.13-pr.md
```

Expected: GitHub returns a PR URL.
