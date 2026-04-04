# Issue 692 Runtime Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the extension’s repeated recursive cached-log lookup with a runtime-backed shared resolver, while tightening the shared Rust lookup so repeated local log opens no longer rescan arbitrary `apexlogs/` subtrees.

**Architecture:** Keep `alv-core` as the source of truth for lookup semantics, add a narrow `logs/resolveCachedPath` RPC in `alv-app-server`, and make `src/utils/workspace.ts` call that RPC before a bounded local fallback. Cache only successful runtime lookups in the app-server process so the extension benefits from repeated hits without keeping stale negative entries after new files are written locally.

**Tech Stack:** TypeScript, VS Code extension host tests, JSON-RPC runtime client, Rust (`alv-core`, `alv-app-server`), Cargo tests

---

## File Map

- `packages/app-server-client-ts/src/index.ts`
  Adds the TypeScript request/response types for `logs/resolveCachedPath`.
- `apps/vscode-extension/src/runtime/runtimeClient.ts`
  Adds the typed `resolveCachedLogPath()` wrapper over the new RPC method.
- `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts`
  Verifies the runtime client sends the new method and returns the typed payload.
- `crates/alv-core/src/log_store.rs`
  Replaces the arbitrary recursive walk with a bounded org-first traversal that only inspects `logs/<day>/`.
- `crates/alv-core/tests/log_store_layout.rs`
  Proves the shared lookup ignores matching files outside the supported org-first layout and still preserves legacy fallbacks.
- `crates/alv-app-server/src/log_lookup_cache.rs`
  New process-lifetime cache module for resolved hit paths.
- `crates/alv-app-server/src/lib.rs`
  Registers the cache module.
- `crates/alv-app-server/src/handlers/logs.rs`
  Adds the handler that serializes `logs/resolveCachedPath`.
- `crates/alv-app-server/src/server.rs`
  Parses the new method and dispatches it to the logs handler.
- `crates/alv-app-server/tests/app_server_smoke.rs`
  Covers the new JSON-RPC route.
- `src/utils/workspace.ts`
  Makes `findExistingLogFile()` runtime-first, with a bounded local fallback.
- `apps/vscode-extension/src/test/findExistingLogFile.runtime.test.ts`
  New focused extension-host unit tests for runtime preference and local fallback.
- `apps/vscode-extension/src/test/findExistingLogFile.test.ts`
  Existing integration suite that continues to exercise the helper under the real extension test runner.
- `CHANGELOG.md`
  Adds the user-facing note under `Unreleased`.

### Task 1: Add the Typed Runtime Client Contract

**Files:**
- Modify: `packages/app-server-client-ts/src/index.ts`
- Modify: `apps/vscode-extension/src/runtime/runtimeClient.ts`
- Test: `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts`

- [ ] **Step 1: Write the failing runtime-client test**

```ts
  test('resolveCachedLogPath uses the runtime request method', async () => {
    const methods: string[] = [];
    const client = new RuntimeClient({
      requestHandler: async (method, params) => {
        methods.push(method);
        assert.deepEqual(params, {
          logId: '07L000000000001AA',
          username: 'demo@example.com',
          workspaceRoot: '/tmp/alv-workspace'
        });
        return {
          path: '/tmp/alv-workspace/apexlogs/orgs/demo@example.com/logs/2026-03-30/07L000000000001AA.log'
        } as never;
      }
    });

    const result = await client.resolveCachedLogPath({
      logId: '07L000000000001AA',
      username: 'demo@example.com',
      workspaceRoot: '/tmp/alv-workspace'
    });

    assert.deepEqual(methods, ['logs/resolveCachedPath']);
    assert.equal(
      result.path,
      '/tmp/alv-workspace/apexlogs/orgs/demo@example.com/logs/2026-03-30/07L000000000001AA.log'
    );
  });
```

- [ ] **Step 2: Run the extension-host unit suite to confirm the new API is missing**

Run:

```bash
npm run pretest
node scripts/run-tests-cli.js --scope=unit --vscode=stable
```

Expected:

```text
FAIL runtime client
TypeError: client.resolveCachedLogPath is not a function
```

- [ ] **Step 3: Add the shared TypeScript RPC types**

```ts
export type ResolveCachedLogPathParams = {
  logId: string;
  username?: string;
  workspaceRoot?: string;
};

export type ResolveCachedLogPathResult = {
  path?: string;
};
```

- [ ] **Step 4: Add the `RuntimeClient.resolveCachedLogPath()` method**

```ts
  async resolveCachedLogPath(
    params: ResolveCachedLogPathParams,
    signal?: AbortSignal
  ): Promise<ResolveCachedLogPathResult> {
    if (!this.requestHandler) {
      await this.initialize();
    }
    return this.request<ResolveCachedLogPathResult>('logs/resolveCachedPath', params, signal);
  }
```

- [ ] **Step 5: Re-run typecheck and the unit suite**

Run:

```bash
npm run check-types
node scripts/run-tests-cli.js --scope=unit --vscode=stable
```

Expected:

```text
TypeScript compilation succeeds
unit suite passes, including "runtime client"
```

- [ ] **Step 6: Commit the contract and client wrapper**

```bash
git add packages/app-server-client-ts/src/index.ts \
  apps/vscode-extension/src/runtime/runtimeClient.ts \
  apps/vscode-extension/src/test/runtime/runtimeClient.test.ts
git commit -m "feat(runtime): add cached log path client method"
```

### Task 2: Tighten the Shared `alv-core` Lookup

**Files:**
- Modify: `crates/alv-core/src/log_store.rs`
- Test: `crates/alv-core/tests/log_store_layout.rs`

- [ ] **Step 1: Add failing Rust tests for bounded org-first traversal**

```rust
#[test]
fn log_store_ignores_matching_files_outside_logs_day_directories() {
    let workspace_root = make_temp_workspace("bounded-layout");
    let off_layout = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com")
        .join("archive")
        .join("2026-03-30");
    fs::create_dir_all(&off_layout).expect("archive dir should be creatable");
    fs::write(
        off_layout.join("07L0000000000BAD.log"),
        "off-layout",
    )
    .expect("off-layout file should be writable");

    let found = find_cached_log_path(
        Some(workspace_root.to_str().expect("workspace path should be utf8")),
        "07L0000000000BAD",
        Some("default@example.com"),
    );

    assert!(found.is_none(), "lookup should ignore files outside logs/<day>/");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_unscoped_lookup_ignores_matching_files_outside_logs_day_directories() {
    let workspace_root = make_temp_workspace("bounded-unscoped");
    let off_layout = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("other@example.com")
        .join("tmp")
        .join("2026-03-30");
    fs::create_dir_all(&off_layout).expect("tmp dir should be creatable");
    fs::write(
        off_layout.join("07L0000000000OFF.log"),
        "off-layout",
    )
    .expect("off-layout file should be writable");

    let found = find_cached_log_path(
        Some(workspace_root.to_str().expect("workspace path should be utf8")),
        "07L0000000000OFF",
        None,
    );

    assert!(found.is_none(), "unscoped lookup should still respect the supported layout");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}
```

- [ ] **Step 2: Run the focused Rust test to verify the current recursive lookup fails**

Run:

```bash
cargo test -p alv-core --test log_store_layout
```

Expected:

```text
FAILED log_store_ignores_matching_files_outside_logs_day_directories
FAILED log_store_unscoped_lookup_ignores_matching_files_outside_logs_day_directories
```

- [ ] **Step 3: Replace the recursive tree walk with bounded helpers**

```rust
fn find_log_in_logs_dir(logs_root: &Path, log_id: &str) -> Option<PathBuf> {
    if !logs_root.is_dir() {
        return None;
    }

    for entry in fs::read_dir(logs_root).ok()?.flatten() {
        let day_dir = entry.path();
        if !day_dir.is_dir() {
            continue;
        }

        let candidate = day_dir.join(format!("{log_id}.log"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn find_log_in_orgs_root(orgs_root: &Path, log_id: &str) -> Option<PathBuf> {
    if !orgs_root.is_dir() {
        return None;
    }

    for entry in fs::read_dir(orgs_root).ok()?.flatten() {
        let found = find_log_in_logs_dir(&entry.path().join("logs"), log_id);
        if found.is_some() {
            return found;
        }
    }

    None
}
```

- [ ] **Step 4: Wire the new helpers into `find_cached_log_path()`**

```rust
    if let Some(username) = resolved_username.filter(|value| !value.trim().is_empty()) {
        let scoped_root = org_dir(workspace_root, username).join("logs");
        if let Some(found) = find_log_in_logs_dir(&scoped_root, log_id) {
            return Some(found);
        }
        // legacy fallback stays unchanged
    }

    let orgs_root = root.join("orgs");
    if let Some(found) = find_log_in_orgs_root(&orgs_root, log_id) {
        return Some(found);
    }
```

- [ ] **Step 5: Re-run the focused Rust test**

Run:

```bash
cargo test -p alv-core --test log_store_layout
```

Expected:

```text
test result: ok.
10 passed; 0 failed
```

- [ ] **Step 6: Commit the shared lookup optimization**

```bash
git add crates/alv-core/src/log_store.rs crates/alv-core/tests/log_store_layout.rs
git commit -m "perf(logs): bound shared cached log lookup"
```

### Task 3: Add `logs/resolveCachedPath` to the App Server

**Files:**
- Create: `crates/alv-app-server/src/log_lookup_cache.rs`
- Modify: `crates/alv-app-server/src/lib.rs`
- Modify: `crates/alv-app-server/src/handlers/logs.rs`
- Modify: `crates/alv-app-server/src/server.rs`
- Test: `crates/alv-app-server/tests/app_server_smoke.rs`

- [ ] **Step 1: Add the failing app-server smoke test for the new RPC route**

```rust
#[test]
fn app_server_smoke_resolves_cached_log_paths() {
    let workspace_root = make_temp_dir("resolve-cache");
    let cached_path = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("demo@example.com")
        .join("logs")
        .join("2026-03-30")
        .join("07L000000000001AA.log");
    fs::create_dir_all(cached_path.parent().expect("cached log parent should exist"))
        .expect("cached log dir should be creatable");
    fs::write(&cached_path, "body").expect("cached log should be writable");

    let response = handle_request_line(&format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"resolve:1\",\"method\":\"logs/resolveCachedPath\",\"params\":{{\"logId\":\"07L000000000001AA\",\"username\":\"demo@example.com\",\"workspaceRoot\":\"{}\"}}}}",
        workspace_root.display()
    ))
    .expect("resolve request should succeed")
    .expect("resolve request should emit a response");

    assert!(response.contains("\"id\":\"resolve:1\""));
    assert!(response.contains("\"path\":\""));
    assert!(response.contains("07L000000000001AA.log"));

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}
```

- [ ] **Step 2: Run the focused app-server smoke test and confirm the route does not exist yet**

Run:

```bash
cargo test -p alv-app-server app_server_smoke_resolves_cached_log_paths -- --exact
```

Expected:

```text
FAILED app_server_smoke_resolves_cached_log_paths
method not found: logs/resolveCachedPath
```

- [ ] **Step 3: Create the hit-cache module**

```rust
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
    workspace_root: Option<String>,
    username: Option<String>,
    log_id: String,
}

static LOG_PATH_CACHE: OnceLock<Mutex<HashMap<CacheKey, String>>> = OnceLock::new();

pub fn resolve_cached_log_path(
    workspace_root: Option<&str>,
    log_id: &str,
    username: Option<&str>,
) -> Option<String> {
    let key = CacheKey {
        workspace_root: workspace_root.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string),
        username: username.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string),
        log_id: log_id.trim().to_string(),
    };

    if key.log_id.is_empty() {
        return None;
    }

    let cache = LOG_PATH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(existing) = guard.get(&key) {
            return Some(existing.clone());
        }
    }

    let resolved = alv_core::log_store::find_cached_log_path(
        key.workspace_root.as_deref(),
        &key.log_id,
        key.username.as_deref(),
    )?
    .to_string_lossy()
    .into_owned();

    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, resolved.clone());
    }

    Some(resolved)
}
```

- [ ] **Step 4: Add the new request parsing and handler dispatch**

```rust
"logs/resolveCachedPath" => ServerOperation::ResolveCachedPath(logs_handler::ResolveCachedLogPathParams {
    log_id: params
        .get("logId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string(),
    username: params.get("username").and_then(Value::as_str).map(str::to_string),
    workspace_root: params
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .or_else(|| params.get("workspace_root").and_then(Value::as_str))
        .map(str::to_string),
}),
```

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveCachedLogPathParams {
    pub log_id: String,
    pub username: Option<String>,
    pub workspace_root: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveCachedLogPathResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

pub fn handle_resolve_cached_path(params: ResolveCachedLogPathParams) -> Result<String, String> {
    let path = crate::log_lookup_cache::resolve_cached_log_path(
        params.workspace_root.as_deref(),
        &params.log_id,
        params.username.as_deref(),
    );

    serde_json::to_string(&ResolveCachedLogPathResult { path })
        .map_err(|error| format!("failed to serialize logs/resolveCachedPath response: {error}"))
}
```

```rust
enum ServerOperation {
    // ...
    ResolveCachedPath(logs_handler::ResolveCachedLogPathParams),
}
```

- [ ] **Step 5: Re-run the focused app-server tests**

Run:

```bash
cargo test -p alv-app-server app_server_smoke_resolves_cached_log_paths -- --exact
cargo test -p alv-app-server app_server_smoke_routes_logs_search_and_triage_requests -- --exact
```

Expected:

```text
test app_server_smoke_resolves_cached_log_paths ... ok
test app_server_smoke_routes_logs_search_and_triage_requests ... ok
```

- [ ] **Step 6: Commit the runtime route**

```bash
git add crates/alv-app-server/src/log_lookup_cache.rs \
  crates/alv-app-server/src/lib.rs \
  crates/alv-app-server/src/handlers/logs.rs \
  crates/alv-app-server/src/server.rs \
  crates/alv-app-server/tests/app_server_smoke.rs
git commit -m "feat(runtime): add cached log path resolver route"
```

### Task 4: Make `findExistingLogFile()` Runtime-First with Bounded Fallback

**Files:**
- Modify: `src/utils/workspace.ts`
- Create: `apps/vscode-extension/src/test/findExistingLogFile.runtime.test.ts`
- Test: `apps/vscode-extension/src/test/findExistingLogFile.test.ts`

- [ ] **Step 1: Add failing extension-host unit tests for runtime preference and fallback**

```ts
import assert from 'assert/strict';
import * as path from 'path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

suite('findExistingLogFile runtime lookup', () => {
  test('prefers the runtime-resolved cached path', async () => {
    const resolveCalls: any[] = [];
    const workspaceModule: typeof import('../../../../src/utils/workspace') = proxyquireStrict('../../../../src/utils/workspace', {
      vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: '/tmp/alv-workspace' } }] } },
      '../../apps/vscode-extension/src/runtime/runtimeClient': {
        runtimeClient: {
          resolveCachedLogPath: async (params: any) => {
            resolveCalls.push(params);
            return { path: '/tmp/alv-workspace/apexlogs/orgs/demo@example.com/logs/2026-03-30/07L000000000001AA.log' };
          }
        }
      },
      './logger': { logInfo: () => undefined, logWarn: () => undefined }
    });

    const result = await workspaceModule.findExistingLogFile('07L000000000001AA', 'demo@example.com');

    assert.equal(result, '/tmp/alv-workspace/apexlogs/orgs/demo@example.com/logs/2026-03-30/07L000000000001AA.log');
    assert.deepEqual(resolveCalls, [{
      logId: '07L000000000001AA',
      username: 'demo@example.com',
      workspaceRoot: '/tmp/alv-workspace'
    }]);
  });

  test('falls back to local lookup when the runtime request fails', async () => {
    const localPath = path.join('/tmp/alv-workspace', 'apexlogs', 'demo_07L000000000002AA.log');
    const workspaceModule: typeof import('../../../../src/utils/workspace') = proxyquireStrict('../../../../src/utils/workspace', {
      vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: '/tmp/alv-workspace' } }] } },
      '../../apps/vscode-extension/src/runtime/runtimeClient': {
        runtimeClient: {
          resolveCachedLogPath: async () => {
            throw new Error('daemon unavailable');
          }
        }
      },
      fs: {
        promises: {
          readdir: async (target: string, options?: { withFileTypes?: boolean }) => {
            if (target.endsWith(path.join('orgs', 'demo', 'logs'))) {
              return [];
            }
            if (options?.withFileTypes) {
              return [];
            }
            return ['demo_07L000000000002AA.log'];
          }
        }
      },
      './logger': { logInfo: () => undefined, logWarn: () => undefined }
    });

    const result = await workspaceModule.findExistingLogFile('07L000000000002AA', 'demo');
    assert.equal(result, localPath);
  });
});
```

- [ ] **Step 2: Run the unit suite to verify the helper still uses only local filesystem logic**

Run:

```bash
npm run pretest
node scripts/run-tests-cli.js --scope=unit --vscode=stable
```

Expected:

```text
FAIL findExistingLogFile runtime lookup
AssertionError or TypeError because workspace.ts never calls runtimeClient.resolveCachedLogPath
```

- [ ] **Step 3: Add a bounded local fallback helper and runtime-first lookup**

```ts
import { runtimeClient } from '../../apps/vscode-extension/src/runtime/runtimeClient';

async function findExistingOrgFirstLogFile(logsRoot: string, logId: string): Promise<string | undefined> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(logsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(logsRoot, entry.name, `${logId}.log`);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }

  return undefined;
}

async function findExistingLogFileLocally(logId: string, username?: string): Promise<string | undefined> {
  const dir = getApexLogsDir();
  if (username) {
    const orgFirst = await findExistingOrgFirstLogFile(
      path.join(dir, 'orgs', toSafeLogUserName(username), 'logs'),
      logId
    );
    if (orgFirst) {
      return orgFirst;
    }
  } else {
    const orgsDir = path.join(dir, 'orgs');
    let orgEntries: import('fs').Dirent[];
    try {
      orgEntries = await fs.readdir(orgsDir, { withFileTypes: true });
    } catch {
      orgEntries = [];
    }
  for (const entry of orgEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const orgFirst = await findExistingOrgFirstLogFile(path.join(orgsDir, entry.name, 'logs'), logId);
      if (orgFirst) {
        return orgFirst;
      }
    }
  }

  const entries = await fs.readdir(dir);
  if (username) {
    const exact = `${toSafeLogUserName(username)}_${logId}.log`;
    if (entries.includes(exact)) {
      return path.join(dir, exact);
    }
  }
  const legacy = entries.find(name => name === `${logId}.log`);
  if (legacy) {
    return path.join(dir, legacy);
  }
  if (!username) {
    const preferred = entries.find(name => name.endsWith(`_${logId}.log`));
    if (preferred) {
      return path.join(dir, preferred);
    }
  }

  return undefined;
}

export async function findExistingLogFile(logId: string, username?: string): Promise<string | undefined> {
  const workspaceRoot = getWorkspaceRoot();
  try {
    const result = await runtimeClient.resolveCachedLogPath({ logId, username, workspaceRoot });
    if (typeof result.path === 'string' && result.path.trim().length > 0) {
      return result.path;
    }
  } catch (error) {
    logWarn('Could not resolve cached log path via runtime ->', getErrorMessage(error));
  }

  return findExistingLogFileLocally(logId, username);
}
```

- [ ] **Step 4: Re-run the unit and integration suites**

Run:

```bash
node scripts/run-tests-cli.js --scope=unit --vscode=stable
node scripts/run-tests-cli.js --scope=integration --vscode=stable
```

Expected:

```text
unit suite passes, including "findExistingLogFile runtime lookup"
integration suite passes, including "integration: findExistingLogFile"
```

- [ ] **Step 5: Commit the extension helper switch**

```bash
git add src/utils/workspace.ts \
  apps/vscode-extension/src/test/findExistingLogFile.runtime.test.ts \
  apps/vscode-extension/src/test/findExistingLogFile.test.ts
git commit -m "fix(logs): resolve cached log paths through runtime"
```

### Task 5: Update Changelog and Run Final Verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-04-04-issue-692-runtime-lookup-design.md`

- [ ] **Step 1: Add the unreleased changelog note**

```md
### Bug Fixes

- Runtime/Logs: route extension cached-log lookup through the shared runtime, bound org-first cache traversal to the supported `logs/<day>/` layout, and avoid repeated full-tree scans when reopening locally cached logs.
```

- [ ] **Step 2: Keep the approved spec aligned with the safe cache behavior**

```md
- The app server caches resolved hits for the daemon session.
- Misses stay uncached so the extension can create a new file locally without leaving a stale negative cache entry behind.
```

- [ ] **Step 3: Install Linux Electron dependencies if this environment does not already have them**

Run:

```bash
INSTALL_LINUX_DEPS=true npm run test:linux-deps
```

Expected:

```text
[deps] Libraries installed successfully.
```

- [ ] **Step 4: Run the final verification sweep**

Run:

```bash
cargo test -p alv-core --test log_store_layout
cargo test -p alv-app-server
npm run compile
node scripts/run-tests-cli.js --scope=unit --vscode=stable
node scripts/run-tests-cli.js --scope=integration --vscode=stable
```

Expected:

```text
All Rust tests pass
npm run compile exits 0
unit suite passes
integration suite passes
```

- [ ] **Step 5: Commit the docs and verification-ready state**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-04-04-issue-692-runtime-lookup-design.md
git commit -m "docs(changelog): note runtime cached log lookup"
```
