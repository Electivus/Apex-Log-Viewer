# CLI Logs Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a rich Rust CLI for local-first Apex log workflows by introducing `logs sync`, `logs status`, and `logs search`, backed by a shared org-first `apexlogs/` storage layer with incremental sync state and legacy flat-layout read compatibility.

**Architecture:** Keep `app-server --stdio` intact while moving local log layout and sync logic into shared `alv-core` modules. Use a new org-first storage layer plus a dedicated sync engine so the CLI becomes the first surface for the capability while the extension remains compatible by reading the new layout and still tolerating legacy flat files during the transition.

**Tech Stack:** Rust (`clap`, `serde`, `serde_json`), Cargo integration tests, existing `sf` fixture env vars, Node/TypeScript workspace helpers for extension-side local file discovery, Markdown docs.

---

## File Structure (what changes where)

**Create**
- `crates/alv-core/src/log_store.rs`
- `crates/alv-core/src/logs_sync.rs`
- `crates/alv-core/tests/log_store_layout.rs`
- `crates/alv-core/tests/logs_sync_smoke.rs`
- `crates/alv-cli/src/cli.rs`
- `crates/alv-cli/src/commands/mod.rs`
- `crates/alv-cli/src/commands/logs.rs`
- `docs/superpowers/plans/2026-03-30-cli-logs-sync.md`

**Modify**
- `crates/alv-core/src/lib.rs`
- `crates/alv-core/src/logs.rs`
- `crates/alv-core/src/search.rs`
- `crates/alv-core/src/triage.rs`
- `crates/alv-core/tests/logs_runtime_smoke.rs`
- `crates/alv-cli/Cargo.toml`
- `crates/alv-cli/src/main.rs`
- `crates/alv-cli/tests/cli_smoke.rs`
- `src/utils/workspace.ts`
- `apps/vscode-extension/src/test/findExistingLogFile.test.ts`
- `README.md`
- `docs/ARCHITECTURE.md`
- `CHANGELOG.md`

**Existing files that anchor the work**
- `crates/alv-core/src/logs.rs`: current log list/download/cancel helpers and flat `apexlogs/` cache writes.
- `crates/alv-core/src/search.rs`: current local-first search implementation that already uses cached files.
- `crates/alv-core/src/triage.rs`: current local triage path with on-demand cache fill.
- `crates/alv-cli/src/main.rs`: current two-branch CLI entrypoint (`app-server --stdio` vs banner).
- `crates/alv-cli/tests/cli_smoke.rs`: current smoke coverage for banner and app-server.
- `src/utils/workspace.ts`: extension-side `apexlogs/` path and lookup helpers that must learn the new layout.

---

### Task 1: Add the shared org-first log store and layout/state tests

**Files:**
- Create: `crates/alv-core/src/log_store.rs`
- Create: `crates/alv-core/tests/log_store_layout.rs`
- Modify: `crates/alv-core/src/lib.rs`

- [ ] **Step 1: Write the failing storage-layout tests**

Create `crates/alv-core/tests/log_store_layout.rs` with these exact tests first:

```rust
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

use alv_core::log_store::{
    find_cached_log_path, log_file_path_for_start_time, read_sync_state, read_version_file,
    safe_target_org, sync_state_path, version_file_path, write_org_metadata, write_sync_state,
    write_version_file, OrgMetadata, SyncState, SyncStateOrgEntry,
};

fn make_temp_workspace(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("alv-log-store-{label}-{nonce}"));
    fs::create_dir_all(&root).expect("temp workspace should be creatable");
    root
}

#[test]
fn log_store_places_logs_under_org_and_day_directory() {
    let workspace_root = make_temp_workspace("org-first");
    let file_path = log_file_path_for_start_time(
        Some(workspace_root.to_str().expect("workspace path should be utf8")),
        "Default Org@example.com",
        "2026-03-30T18:39:58.000Z",
        "07L000000000003AA",
    );

    assert_eq!(
        file_path,
        workspace_root
            .join("apexlogs")
            .join("orgs")
            .join("Default_Org@example.com")
            .join("logs")
            .join("2026-03-30")
            .join("07L000000000003AA.log")
    );

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_finds_new_layout_before_legacy_flat_files() {
    let workspace_root = make_temp_workspace("find-cache");
    let new_path = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com")
        .join("logs")
        .join("2026-03-30")
        .join("07L000000000001AA.log");
    fs::create_dir_all(new_path.parent().expect("log parent should exist"))
        .expect("new layout dir should be creatable");
    fs::write(&new_path, "new-layout").expect("new layout log should be writable");

    let legacy_path = workspace_root
        .join("apexlogs")
        .join("default_07L000000000001AA.log");
    fs::write(&legacy_path, "legacy-layout").expect("legacy log should be writable");

    let found = find_cached_log_path(
        Some(workspace_root.to_str().expect("workspace path should be utf8")),
        "07L000000000001AA",
        Some("default@example.com"),
    )
    .expect("cache lookup should return a path");

    assert_eq!(found, new_path);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_round_trips_version_state_and_org_metadata() {
    let workspace_root = make_temp_workspace("state");
    let workspace_text = workspace_root.to_str().expect("workspace path should be utf8");

    write_version_file(Some(workspace_text), 1).expect("version file should write");
    write_sync_state(
        Some(workspace_text),
        &SyncState {
            version: 1,
            orgs: [(
                "default@example.com".to_string(),
                SyncStateOrgEntry {
                    target_org: "default@example.com".to_string(),
                    safe_target_org: safe_target_org("default@example.com"),
                    org_dir: "apexlogs/orgs/default@example.com".to_string(),
                    last_sync_started_at: Some("2026-03-30T18:40:00.000Z".to_string()),
                    last_sync_completed_at: Some("2026-03-30T18:40:04.000Z".to_string()),
                    last_synced_log_id: Some("07L000000000003AA".to_string()),
                    last_synced_start_time: Some("2026-03-30T18:39:58.000Z".to_string()),
                    downloaded_count: 3,
                    cached_count: 12,
                    last_error: None,
                },
            )]
            .into_iter()
            .collect(),
        },
    )
    .expect("sync state should write");
    write_org_metadata(
        Some(workspace_text),
        &OrgMetadata {
            target_org: "default@example.com".to_string(),
            safe_target_org: safe_target_org("default@example.com"),
            resolved_username: "default@example.com".to_string(),
            alias: Some("Default".to_string()),
            instance_url: Some("https://default.example.com".to_string()),
            updated_at: "2026-03-30T18:40:04.000Z".to_string(),
        },
    )
    .expect("org metadata should write");

    assert_eq!(read_version_file(Some(workspace_text)).expect("version should load"), 1);
    let state = read_sync_state(Some(workspace_text)).expect("sync state should load");
    assert_eq!(state.orgs["default@example.com"].downloaded_count, 3);
    assert!(version_file_path(Some(workspace_text)).is_file());
    assert!(sync_state_path(Some(workspace_text)).is_file());

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}
```

- [ ] **Step 2: Run the new test file to verify the red phase**

Run:

```bash
cargo test -p alv-core --test log_store_layout
```

Expected: FAIL because `alv_core::log_store` does not exist yet.

- [ ] **Step 3: Add the minimal shared storage module**

Create `crates/alv-core/src/log_store.rs` with these exact entry points and types:

```rust
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

pub const LOG_STORE_LAYOUT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SyncState {
    pub version: u32,
    pub orgs: BTreeMap<String, SyncStateOrgEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateOrgEntry {
    pub target_org: String,
    pub safe_target_org: String,
    pub org_dir: String,
    pub last_sync_started_at: Option<String>,
    pub last_sync_completed_at: Option<String>,
    pub last_synced_log_id: Option<String>,
    pub last_synced_start_time: Option<String>,
    pub downloaded_count: usize,
    pub cached_count: usize,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgMetadata {
    pub target_org: String,
    pub safe_target_org: String,
    pub resolved_username: String,
    pub alias: Option<String>,
    pub instance_url: Option<String>,
    pub updated_at: String,
}

pub fn resolve_apexlogs_root(workspace_root: Option<&str>) -> PathBuf {
    match workspace_root.map(str::trim).filter(|value| !value.is_empty()) {
        Some(root) => Path::new(root).join("apexlogs"),
        None => env::temp_dir().join("apexlogs"),
    }
}

pub fn safe_target_org(value: &str) -> String {
    let trimmed = value.trim();
    let safe = trimmed
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '.' | '@' | '-' => character,
            _ => '_',
        })
        .collect::<String>();
    if safe.is_empty() { "default".to_string() } else { safe }
}

pub fn version_file_path(workspace_root: Option<&str>) -> PathBuf {
    resolve_apexlogs_root(workspace_root).join(".alv").join("version.json")
}

pub fn sync_state_path(workspace_root: Option<&str>) -> PathBuf {
    resolve_apexlogs_root(workspace_root).join(".alv").join("sync-state.json")
}

pub fn org_dir(workspace_root: Option<&str>, resolved_username: &str) -> PathBuf {
    resolve_apexlogs_root(workspace_root)
        .join("orgs")
        .join(safe_target_org(resolved_username))
}

pub fn org_metadata_path(workspace_root: Option<&str>, resolved_username: &str) -> PathBuf {
    org_dir(workspace_root, resolved_username).join("org.json")
}

pub fn log_file_path_for_start_time(
    workspace_root: Option<&str>,
    resolved_username: &str,
    start_time: &str,
    log_id: &str,
) -> PathBuf {
    let day = start_time
        .get(0..10)
        .filter(|value| value.len() == 10)
        .unwrap_or("unknown-date");
    org_dir(workspace_root, resolved_username)
        .join("logs")
        .join(day)
        .join(format!("{log_id}.log"))
}

pub fn unknown_date_log_path(
    workspace_root: Option<&str>,
    resolved_username: &str,
    log_id: &str,
) -> PathBuf {
    org_dir(workspace_root, resolved_username)
        .join("logs")
        .join("unknown-date")
        .join(format!("{log_id}.log"))
}

pub fn write_version_file(workspace_root: Option<&str>, version: u32) -> Result<(), String> {
    let path = version_file_path(workspace_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    fs::write(&path, serde_json::to_vec_pretty(&version).map_err(|error| error.to_string())?)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

pub fn read_version_file(workspace_root: Option<&str>) -> Result<u32, String> {
    let path = version_file_path(workspace_root);
    if !path.is_file() {
        return Ok(LOG_STORE_LAYOUT_VERSION);
    }
    serde_json::from_slice::<u32>(&fs::read(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))?)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

pub fn write_sync_state(workspace_root: Option<&str>, state: &SyncState) -> Result<(), String> {
    let path = sync_state_path(workspace_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    fs::write(&path, serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

pub fn read_sync_state(workspace_root: Option<&str>) -> Result<SyncState, String> {
    let path = sync_state_path(workspace_root);
    if !path.is_file() {
        return Ok(SyncState {
            version: LOG_STORE_LAYOUT_VERSION,
            orgs: BTreeMap::new(),
        });
    }
    serde_json::from_slice::<SyncState>(&fs::read(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))?)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

pub fn write_org_metadata(workspace_root: Option<&str>, metadata: &OrgMetadata) -> Result<(), String> {
    let path = org_metadata_path(workspace_root, &metadata.resolved_username);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    fs::write(&path, serde_json::to_vec_pretty(metadata).map_err(|error| error.to_string())?)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

pub fn find_cached_log_path(
    workspace_root: Option<&str>,
    log_id: &str,
    resolved_username: Option<&str>,
) -> Option<PathBuf> {
    let root = resolve_apexlogs_root(workspace_root);
    if let Some(username) = resolved_username.filter(|value| !value.trim().is_empty()) {
        let scoped_root = org_dir(workspace_root, username).join("logs");
        if let Some(found) = find_log_in_tree(&scoped_root, log_id) {
            return Some(found);
        }
    }

    let orgs_root = root.join("orgs");
    if let Some(found) = find_log_in_tree(&orgs_root, log_id) {
        return Some(found);
    }

    let entries = fs::read_dir(&root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name()?.to_string_lossy();
        if file_name == format!("{log_id}.log") || file_name.ends_with(&format!("_{log_id}.log")) {
            return Some(path);
        }
    }

    None
}

fn find_log_in_tree(root: &Path, log_id: &str) -> Option<PathBuf> {
    if !root.exists() {
        return None;
    }
    for entry in fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_log_in_tree(&path, log_id) {
                return Some(found);
            }
            continue;
        }
        if path.file_name()?.to_string_lossy() == format!("{log_id}.log") {
            return Some(path);
        }
    }
    None
}
```

Export the new module in `crates/alv-core/src/lib.rs`:

```rust
pub mod log_store;
pub mod logs_sync;
```

- [ ] **Step 4: Run the storage tests to verify the green phase**

Run:

```bash
cargo test -p alv-core --test log_store_layout
```

Expected: PASS.

- [ ] **Step 5: Commit the storage layer**

Run:

```bash
git add crates/alv-core/src/lib.rs crates/alv-core/src/log_store.rs crates/alv-core/tests/log_store_layout.rs
git commit -m "feat(logs): add org-first log store"
```

Expected: commit succeeds.

---

### Task 2: Add the shared incremental sync engine and refactor direct downloads to target explicit paths

**Files:**
- Create: `crates/alv-core/src/logs_sync.rs`
- Create: `crates/alv-core/tests/logs_sync_smoke.rs`
- Modify: `crates/alv-core/src/logs.rs`

- [ ] **Step 1: Write the failing sync-engine tests**

Create `crates/alv-core/tests/logs_sync_smoke.rs` with these exact tests:

```rust
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

use alv_core::{
    log_store::{read_sync_state, resolve_apexlogs_root},
    logs::{TEST_APEX_LOG_FIXTURE_DIR_ENV, TEST_SF_LOG_LIST_JSON_ENV},
    logs_sync::{sync_logs_with_cancel, LogsSyncParams},
};

fn make_temp_workspace(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("alv-logs-sync-{label}-{nonce}"));
    fs::create_dir_all(&root).expect("temp workspace should be creatable");
    root
}

fn make_fixture_dir(label: &str) -> PathBuf {
    let root = make_temp_workspace(label);
    fs::create_dir_all(&root).expect("fixture dir should be creatable");
    root
}

#[test]
fn logs_sync_smoke_writes_new_layout_and_updates_checkpoint() {
    let workspace_root = make_temp_workspace("writes-layout");
    let fixture_dir = make_fixture_dir("fixture");
    fs::write(
        fixture_dir.join("07L000000000003AA.log"),
        "09:00:00.0|USER_INFO|synced body\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        r#"{"result":{"records":[{"Id":"07L000000000003AA","StartTime":"2026-03-30T18:39:58.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-1","LogLength":4096,"LogUser":{"Name":"Ada"}}]}}"#,
    );
    std::env::set_var("ALV_TEST_SF_ORG_DISPLAY_JSON", r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#);
    std::env::set_var(TEST_APEX_LOG_FIXTURE_DIR_ENV, fixture_dir.display().to_string());

    let result = sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: None,
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect("sync should succeed");

    assert_eq!(result.status, "success");
    assert_eq!(result.downloaded, 1);
    assert!(
        resolve_apexlogs_root(Some(workspace_root.to_str().expect("workspace path should be utf8")))
            .join("orgs")
            .join("default@example.com")
            .join("logs")
            .join("2026-03-30")
            .join("07L000000000003AA.log")
            .is_file()
    );

    let state = read_sync_state(Some(workspace_root.to_str().expect("workspace path should be utf8")))
        .expect("sync state should load");
    assert_eq!(
        state.orgs["default@example.com"].last_synced_log_id.as_deref(),
        Some("07L000000000003AA")
    );

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}

#[test]
fn logs_sync_smoke_second_run_is_incremental() {
    let workspace_root = make_temp_workspace("incremental");
    let fixture_dir = make_fixture_dir("fixture-incremental");
    fs::write(
        fixture_dir.join("07L000000000003AA.log"),
        "09:00:00.0|USER_INFO|synced body\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        r#"{"result":{"records":[{"Id":"07L000000000003AA","StartTime":"2026-03-30T18:39:58.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-1","LogLength":4096}]}}"#,
    );
    std::env::set_var("ALV_TEST_SF_ORG_DISPLAY_JSON", r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#);
    std::env::set_var(TEST_APEX_LOG_FIXTURE_DIR_ENV, fixture_dir.display().to_string());

    let first = sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: None,
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect("first sync should succeed");
    let second = sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: None,
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect("second sync should succeed");

    assert_eq!(first.downloaded, 1);
    assert_eq!(second.downloaded, 0);
    assert_eq!(second.cached, 1);

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}

#[test]
fn logs_sync_smoke_keeps_previous_checkpoint_on_partial_failure() {
    let workspace_root = make_temp_workspace("partial");
    let fixture_dir = make_fixture_dir("fixture-partial");
    fs::write(
        fixture_dir.join("07L000000000003AA.log"),
        "09:00:00.0|USER_INFO|first body\n",
    )
    .expect("first fixture log should be writable");

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        r#"{"result":{"records":[
          {"Id":"07L000000000004AA","StartTime":"2026-03-30T18:40:58.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-2","LogLength":4096},
          {"Id":"07L000000000003AA","StartTime":"2026-03-30T18:39:58.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-1","LogLength":4096}
        ]}}"#,
    );
    std::env::set_var("ALV_TEST_SF_ORG_DISPLAY_JSON", r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#);
    std::env::set_var(TEST_APEX_LOG_FIXTURE_DIR_ENV, fixture_dir.display().to_string());

    let first = sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: None,
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect("first sync should succeed");

    assert_eq!(first.status, "partial");
    let state = read_sync_state(Some(workspace_root.to_str().expect("workspace path should be utf8")))
        .expect("sync state should load");
    assert!(
        state.orgs.get("default@example.com").is_none(),
        "partial sync must not advance the checkpoint"
    );

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}
```

- [ ] **Step 2: Run the sync test file to verify the red phase**

Run:

```bash
cargo test -p alv-core --test logs_sync_smoke
```

Expected: FAIL because `alv_core::logs_sync` does not exist yet.

- [ ] **Step 3: Add a path-targeted download helper in `logs.rs`**

In `crates/alv-core/src/logs.rs`, replace the hard-coded flat write path with an explicit reusable helper and keep `ensure_log_file_cached_with_cancel()` as the public wrapper:

```rust
pub fn download_log_to_path_with_cancel(
    log_id: &str,
    username: Option<&str>,
    target_path: &Path,
    cancellation: &CancellationToken,
) -> Result<PathBuf, String> {
    cancellation.check_cancelled()?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("failed to create {}: {error}", parent.display())
        })?;
    }

    if let Ok(fixture_dir) = env::var(TEST_APEX_LOG_FIXTURE_DIR_ENV) {
        cancellation.check_cancelled()?;
        let source_path = Path::new(&fixture_dir).join(format!("{log_id}.log"));
        if !source_path.is_file() {
            return Err(format!(
                "fixture log file not found for {log_id}: {}",
                source_path.display()
            ));
        }
        fs::copy(&source_path, target_path).map_err(|error| {
            format!(
                "failed to copy fixture log {} into cache {}: {error}",
                source_path.display(),
                target_path.display()
            )
        })?;
        return Ok(target_path.to_path_buf());
    }

    with_temp_staging_dir(|staging_dir| {
        let mut args = vec![
            "apex".to_string(),
            "get".to_string(),
            "log".to_string(),
            "--json".to_string(),
            "--log-id".to_string(),
            log_id.to_string(),
            "--output-dir".to_string(),
            staging_dir.display().to_string(),
        ];
        if let Some(value) = username.map(str::trim).filter(|value| !value.is_empty()) {
            args.push("--target-org".to_string());
            args.push(value.to_string());
        }
        run_command_with_cancel("sf", &args, cancellation)?;
        cancellation.check_cancelled()?;
        let downloaded_path = find_downloaded_log(staging_dir, log_id).ok_or_else(|| {
            format!(
                "sf apex get log did not write a .log file for {log_id} in {}",
                staging_dir.display()
            )
        })?;
        fs::copy(&downloaded_path, target_path).map_err(|error| {
            format!(
                "failed to copy downloaded log {} into cache {}: {error}",
                downloaded_path.display(),
                target_path.display()
            )
        })?;
        Ok(target_path.to_path_buf())
    })
}
```

- [ ] **Step 4: Implement the sync engine using the new store**

Create `crates/alv-core/src/logs_sync.rs` with this exact structure:

```rust
use crate::{
    auth,
    log_store::{
        log_file_path_for_start_time, read_sync_state, safe_target_org, write_org_metadata,
        write_sync_state, write_version_file, OrgMetadata, SyncState, SyncStateOrgEntry,
        LOG_STORE_LAYOUT_VERSION,
    },
    logs::{download_log_to_path_with_cancel, list_logs_with_cancel, CancellationToken, LogsListParams},
    orgs::list_orgs,
};
use serde::{Deserialize, Serialize};

const SYNC_PAGE_SIZE: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogsSyncParams {
    pub target_org: Option<String>,
    pub workspace_root: Option<String>,
    pub force_full: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogsSyncResult {
    pub status: String,
    pub target_org: String,
    pub safe_target_org: String,
    pub downloaded: usize,
    pub cached: usize,
    pub failed: usize,
    pub checkpoint_advanced: bool,
    pub state_file: String,
    pub last_synced_log_id: Option<String>,
}

pub fn sync_logs_with_cancel(
    params: &LogsSyncParams,
    cancellation: &CancellationToken,
) -> Result<LogsSyncResult, String> {
    cancellation.check_cancelled()?;
    write_version_file(params.workspace_root.as_deref(), LOG_STORE_LAYOUT_VERSION)?;
    let started_at = timestamp_now();

    let auth = auth::resolve_org_auth(params.target_org.as_deref())?;
    let resolved_username = auth.username.clone().unwrap_or_else(|| "default".to_string());
    let safe_org = safe_target_org(&resolved_username);
    let alias = list_orgs(false)
        .ok()
        .and_then(|orgs| orgs.into_iter().find(|org| org.username == resolved_username))
        .and_then(|org| org.alias);
    let previous = read_sync_state(params.workspace_root.as_deref())?
        .orgs
        .get(&resolved_username)
        .cloned();

    let mut state = read_sync_state(params.workspace_root.as_deref())?;
    let mut downloaded = 0usize;
    let mut cached = 0usize;
    let mut failed = 0usize;
    let mut rows = list_logs_with_cancel(
        &LogsListParams {
            username: params.target_org.clone(),
            limit: Some(SYNC_PAGE_SIZE),
            cursor: None,
            offset: Some(0),
        },
        cancellation,
    )?;
    rows.sort_by(|left, right| right.start_time.cmp(&left.start_time).then_with(|| right.id.cmp(&left.id)));

    let mut newest: Option<(String, String)> = None;
    for row in rows {
        let hit_checkpoint = !params.force_full
            && previous.as_ref().is_some_and(|entry| {
                entry.last_synced_log_id.as_deref() == Some(row.id.as_str())
                    || entry.last_synced_start_time.as_deref() == Some(row.start_time.as_str())
            });
        if hit_checkpoint {
            break;
        }

        let target_path = log_file_path_for_start_time(
            params.workspace_root.as_deref(),
            &resolved_username,
            &row.start_time,
            &row.id,
        );
        if target_path.is_file() {
            cached += 1;
        } else if download_log_to_path_with_cancel(&row.id, Some(&resolved_username), &target_path, cancellation).is_ok() {
            downloaded += 1;
        } else {
            failed += 1;
            continue;
        }

        if newest.is_none() {
            newest = Some((row.id.clone(), row.start_time.clone()));
        }
    }

    let partial = failed > 0 || cancellation.is_cancelled();
    let status = if cancellation.is_cancelled() {
        "cancelled".to_string()
    } else if partial {
        "partial".to_string()
    } else {
        "success".to_string()
    };
    let finished_at = timestamp_now();

    if status == "success" {
        let (last_synced_log_id, last_synced_start_time) = newest.clone().unwrap_or_else(|| {
            (
                previous
                    .as_ref()
                    .and_then(|entry| entry.last_synced_log_id.clone())
                    .unwrap_or_default(),
                previous
                    .as_ref()
                    .and_then(|entry| entry.last_synced_start_time.clone())
                    .unwrap_or_default(),
            )
        });
        state.orgs.insert(
            resolved_username.clone(),
            SyncStateOrgEntry {
                target_org: resolved_username.clone(),
                safe_target_org: safe_org.clone(),
                org_dir: format!("apexlogs/orgs/{safe_org}"),
                last_sync_started_at: Some(started_at.clone()),
                last_sync_completed_at: Some(finished_at.clone()),
                last_synced_log_id: if last_synced_log_id.is_empty() { None } else { Some(last_synced_log_id.clone()) },
                last_synced_start_time: if last_synced_start_time.is_empty() { None } else { Some(last_synced_start_time.clone()) },
                downloaded_count: downloaded,
                cached_count: cached,
                last_error: None,
            },
        );
        write_sync_state(params.workspace_root.as_deref(), &state)?;
    }

    write_org_metadata(
        params.workspace_root.as_deref(),
        &OrgMetadata {
            target_org: params.target_org.clone().unwrap_or_else(|| resolved_username.clone()),
            safe_target_org: safe_org.clone(),
            resolved_username: resolved_username.clone(),
            alias,
            instance_url: Some(auth.instance_url),
            updated_at: finished_at.clone(),
        },
    )?;

    Ok(LogsSyncResult {
        status,
        target_org: resolved_username.clone(),
        safe_target_org: safe_org,
        downloaded,
        cached,
        failed,
        checkpoint_advanced: failed == 0 && !cancellation.is_cancelled(),
        state_file: crate::log_store::sync_state_path(params.workspace_root.as_deref())
            .display()
            .to_string(),
        last_synced_log_id: newest.map(|(log_id, _)| log_id),
    })
}

fn timestamp_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{seconds}Z")
}
```

Implementation notes for the real code while typing the module:
- keep the `status` strings exactly `success`, `partial`, `cancelled`
- if a later red/green cycle shows pagination is required beyond one page to find the checkpoint, extend the loop immediately instead of widening scope elsewhere

- [ ] **Step 5: Run the sync tests to verify the green phase**

Run:

```bash
cargo test -p alv-core --test logs_sync_smoke
```

Expected: PASS.

- [ ] **Step 6: Commit the sync engine**

Run:

```bash
git add crates/alv-core/src/logs.rs crates/alv-core/src/logs_sync.rs crates/alv-core/tests/logs_sync_smoke.rs
git commit -m "feat(logs): add incremental sync engine"
```

Expected: commit succeeds.

---

### Task 3: Teach Rust search/triage and extension-side file discovery to read the new layout

**Files:**
- Modify: `crates/alv-core/src/search.rs`
- Modify: `crates/alv-core/src/triage.rs`
- Modify: `crates/alv-core/tests/logs_runtime_smoke.rs`
- Modify: `src/utils/workspace.ts`
- Modify: `apps/vscode-extension/src/test/findExistingLogFile.test.ts`

- [ ] **Step 1: Write the failing compatibility tests**

Add these Rust assertions to `crates/alv-core/tests/logs_runtime_smoke.rs`:

```rust
#[test]
fn logs_runtime_smoke_search_reads_org_first_cache_layout() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-new-layout");
    let org_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&org_dir).expect("new layout log dir should exist");
    fs::write(
        org_dir.join("07L000000000001AA.log"),
        "09:00:00.0|FATAL_ERROR|System.NullPointerException\n",
    )
    .expect("cached log should be writable");

    let result = search_query(
        &SearchQueryParams {
            query: "NullPointerException".to_string(),
            log_ids: vec!["07L000000000001AA".to_string()],
            workspace_root: Some(workspace_root.display().to_string()),
        },
    )
    .expect("search/query should succeed");

    assert_eq!(result.log_ids, vec!["07L000000000001AA".to_string()]);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_ensure_log_file_cached_uses_unknown_date_directory() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("ensure-new-layout");
    let fixture_dir = make_temp_workspace("ensure-fixture");
    let log_id = "07L000000000001AA";
    fs::write(
        fixture_dir.join(format!("{log_id}.log")),
        "09:00:00.0|USER_INFO|fixture body\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(TEST_APEX_LOG_FIXTURE_DIR_ENV, fixture_dir.display().to_string());
    let cached = ensure_log_file_cached(log_id, Some("default@example.com"), Some(&workspace_root.display().to_string()))
        .expect("ensure_log_file_cached should copy fixture into workspace cache");

    assert!(cached.ends_with("apexlogs/orgs/default@example.com/logs/unknown-date/07L000000000001AA.log"));

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("temp workspace should be removable");
}
```

Add these TypeScript assertions to `apps/vscode-extension/src/test/findExistingLogFile.test.ts`:

```ts
test('findExistingLogFile resolves a nested org-first path for the matching username', async () => {
  const dir = getApexLogsDir();
  const logId = '07L000000000001AA';
  const nested = path.join(dir, 'orgs', 'target@example.com', 'logs', '2026-03-30', `${logId}.log`);
  await fs.mkdir(path.dirname(nested), { recursive: true });
  await fs.writeFile(nested, 'body', 'utf8');

  try {
    const result = await findExistingLogFile(logId, 'target@example.com');
    assert.equal(result, nested);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findExistingLogFile can fall back to any org-first match when no username is provided', async () => {
  const dir = getApexLogsDir();
  const logId = '07L000000000002AA';
  const nested = path.join(dir, 'orgs', 'default@example.com', 'logs', '2026-03-30', `${logId}.log`);
  await fs.mkdir(path.dirname(nested), { recursive: true });
  await fs.writeFile(nested, 'body', 'utf8');

  try {
    const result = await findExistingLogFile(logId);
    assert.equal(result, nested);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the affected tests to verify the red phase**

Run:

```bash
cargo test -p alv-core --test logs_runtime_smoke
npm run test:extension:node
```

Expected: FAIL because Rust search/triage still only know the flat cache helpers and `src/utils/workspace.ts` only scans the `apexlogs/` root.

- [ ] **Step 3: Refactor Rust and TypeScript readers to use the new layout**

In `crates/alv-core/src/search.rs`, swap to the shared store lookup:

```rust
use crate::{log_store, logs::CancellationToken};

let Some(path) = log_store::find_cached_log_path(
    params.workspace_root.as_deref(),
    &log_id,
    None,
) else {
    result.pending_log_ids.push(log_id);
    continue;
};
```

In `crates/alv-core/src/triage.rs`, use the shared lookup and write on-demand fetches into `unknown-date`:

```rust
use crate::{
    log_store,
    logs::{download_log_to_path_with_cancel, extract_code_unit_started, CancellationToken},
};

let path = match log_store::find_cached_log_path(
    params.workspace_root.as_deref(),
    log_id,
    params.username.as_deref(),
) {
    Some(existing) => existing,
    None => {
        let resolved_username = params
            .username
            .as_deref()
            .unwrap_or("default");
        let target_path = log_store::unknown_date_log_path(
            params.workspace_root.as_deref(),
            resolved_username,
            log_id,
        );
        download_log_to_path_with_cancel(
            log_id,
            params.username.as_deref(),
            &target_path,
            cancellation,
        )?
    }
};
```

In `src/utils/workspace.ts`, keep writes backward-compatible for now, but teach reads to discover the new layout recursively:

```ts
async function findExistingLogFileInTree(rootDir: string, logId: string): Promise<string | undefined> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const filePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExistingLogFileInTree(filePath, logId);
      if (nested) {
        return nested;
      }
      continue;
    }
    if (entry.isFile() && entry.name === `${logId}.log`) {
      return filePath;
    }
  }

  return undefined;
}

export async function findExistingLogFile(logId: string, username?: string): Promise<string | undefined> {
  const dir = getApexLogsDir();
  try {
    if (username) {
      const orgFirst = await findExistingLogFileInTree(
        path.join(dir, 'orgs', toSafeLogUserName(username), 'logs'),
        logId
      );
      if (orgFirst) {
        return orgFirst;
      }
    } else {
      const orgFirst = await findExistingLogFileInTree(path.join(dir, 'orgs'), logId);
      if (orgFirst) {
        return orgFirst;
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
  } catch {
    return undefined;
  }
  return undefined;
}
```

- [ ] **Step 4: Run the compatibility tests to verify the green phase**

Run:

```bash
cargo test -p alv-core --test logs_runtime_smoke
npm run test:extension:node
```

Expected: PASS.

- [ ] **Step 5: Commit the compatibility changes**

Run:

```bash
git add crates/alv-core/src/search.rs crates/alv-core/src/triage.rs crates/alv-core/tests/logs_runtime_smoke.rs src/utils/workspace.ts apps/vscode-extension/src/test/findExistingLogFile.test.ts
git commit -m "feat(logs): read org-first cache layout"
```

Expected: commit succeeds.

---

### Task 4: Replace the banner CLI with a `clap`-based command surface and wire `logs sync`, `logs status`, and `logs search`

**Files:**
- Modify: `crates/alv-cli/Cargo.toml`
- Create: `crates/alv-cli/src/cli.rs`
- Create: `crates/alv-cli/src/commands/mod.rs`
- Create: `crates/alv-cli/src/commands/logs.rs`
- Modify: `crates/alv-cli/src/main.rs`
- Modify: `crates/alv-cli/tests/cli_smoke.rs`

- [ ] **Step 1: Write the failing CLI smoke tests**

In `crates/alv-cli/tests/cli_smoke.rs`, replace the current `cli_smoke_prints_banner_for_standalone_invocation()` assertion with this help-based assertion and then add the remaining tests below:

```rust
#[test]
fn cli_smoke_prints_help_for_standalone_invocation() {
    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .output()
        .expect("help should execute");

    assert!(output.status.success(), "help should exit successfully");
    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("Local-first Apex log sync and analysis CLI"));
    assert!(stdout.contains("logs"));
    assert!(stdout.contains("app-server"));
}

#[test]
fn cli_smoke_shows_logs_subcommands_in_help() {
    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .args(["logs", "--help"])
        .output()
        .expect("help should execute");

    assert!(output.status.success(), "help should exit successfully");
    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("sync"));
    assert!(stdout.contains("status"));
    assert!(stdout.contains("search"));
    assert!(stdout.contains("--target-org"));
}

#[test]
fn cli_smoke_logs_sync_json_emits_structured_result_and_writes_state() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-sync-{unique}"));
    let fixture_dir = std::env::temp_dir().join(format!("alv-cli-sync-fixture-{unique}"));
    fs::create_dir_all(&workspace_root).expect("workspace should exist");
    fs::create_dir_all(&fixture_dir).expect("fixture dir should exist");
    fs::write(
        fixture_dir.join("07L000000000003AA.log"),
        "09:00:00.0|USER_INFO|synced body\n",
    )
    .expect("fixture log should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .env(
            "ALV_TEST_SF_LOG_LIST_JSON",
            r#"{"result":{"records":[{"Id":"07L000000000003AA","StartTime":"2026-03-30T18:39:58.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-1","LogLength":4096}]}}"#,
        )
        .env(
            "ALV_TEST_SF_ORG_DISPLAY_JSON",
            r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#,
        )
        .env("ALV_TEST_APEX_LOG_FIXTURE_DIR", &fixture_dir)
        .args(["logs", "sync", "--json"])
        .output()
        .expect("sync should execute");

    assert!(output.status.success(), "sync should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["status"], "success");
    assert_eq!(json["target_org"], "default@example.com");
    assert_eq!(json["downloaded"], 1);
    assert!(workspace_root.join("apexlogs").join(".alv").join("sync-state.json").is_file());

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}

#[test]
fn cli_smoke_logs_status_json_reads_existing_sync_state() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-status-{unique}"));
    let state_dir = workspace_root.join("apexlogs").join(".alv");
    fs::create_dir_all(&state_dir).expect("state dir should exist");
    fs::write(
        state_dir.join("sync-state.json"),
        r#"{"version":1,"orgs":{"default@example.com":{"targetOrg":"default@example.com","safeTargetOrg":"default@example.com","orgDir":"apexlogs/orgs/default@example.com","lastSyncStartedAt":"2026-03-30T18:40:00.000Z","lastSyncCompletedAt":"2026-03-30T18:40:04.000Z","lastSyncedLogId":"07L000000000003AA","lastSyncedStartTime":"2026-03-30T18:39:58.000Z","downloadedCount":3,"cachedCount":12,"lastError":null}}}"#,
    )
    .expect("sync state should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .args(["logs", "status", "--json", "--target-org", "default@example.com"])
        .output()
        .expect("status should execute");

    assert!(output.status.success(), "status should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["target_org"], "default@example.com");
    assert_eq!(json["last_synced_log_id"], "07L000000000003AA");

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_logs_search_json_stays_local_first() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-search-{unique}"));
    let log_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&log_dir).expect("log dir should exist");
    fs::write(
        log_dir.join("07L000000000003AA.log"),
        "09:00:00.0|FATAL_ERROR|System.NullPointerException\n",
    )
    .expect("cached log should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .args([
            "logs",
            "search",
            "NullPointerException",
            "--json",
            "--target-org",
            "default@example.com",
        ])
        .output()
        .expect("search should execute");

    assert!(output.status.success(), "search should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["target_org"], "default@example.com");
    assert_eq!(json["matches"][0]["log_id"], "07L000000000003AA");

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}
```

- [ ] **Step 2: Run the CLI smoke tests to verify the red phase**

Run:

```bash
cargo test -p apex-log-viewer-cli --test cli_smoke
```

Expected: FAIL because the CLI still prints a banner and does not know `logs` subcommands.

- [ ] **Step 3: Add `clap`, the CLI parser, and the command handlers**

Update `crates/alv-cli/Cargo.toml` dependencies:

```toml
[dependencies]
alv-app-server = { version = "0.1.1", path = "../alv-app-server" }
alv-core = { version = "0.1.1", path = "../alv-core" }
clap = { version = "4.5", features = ["derive"] }
serde_json = "1.0"
```

Create `crates/alv-cli/src/cli.rs`:

```rust
use clap::{Args, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "apex-log-viewer", version, about = "Local-first Apex log sync and analysis CLI")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    AppServer(AppServerArgs),
    Logs(LogsArgs),
}

#[derive(Args, Debug)]
pub struct AppServerArgs {
    #[arg(long = "stdio", default_value_t = false)]
    pub stdio: bool,
}

#[derive(Args, Debug)]
pub struct LogsArgs {
    #[command(subcommand)]
    pub command: LogsCommand,
}

#[derive(Subcommand, Debug)]
pub enum LogsCommand {
    Sync(LogSyncArgs),
    Status(LogStatusArgs),
    Search(LogSearchArgs),
}

#[derive(Args, Debug)]
pub struct LogScopeArgs {
    #[arg(short = 'o', long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long = "json", default_value_t = false)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct LogSyncArgs {
    #[command(flatten)]
    pub scope: LogScopeArgs,
    #[arg(long = "force-full", default_value_t = false)]
    pub force_full: bool,
}

#[derive(Args, Debug)]
pub struct LogStatusArgs {
    #[command(flatten)]
    pub scope: LogScopeArgs,
}

#[derive(Args, Debug)]
pub struct LogSearchArgs {
    pub query: String,
    #[command(flatten)]
    pub scope: LogScopeArgs,
}
```

Create `crates/alv-cli/src/commands/logs.rs` with these handlers:

```rust
use alv_core::{
    log_store::{read_sync_state, resolve_apexlogs_root, safe_target_org},
    logs::CancellationToken,
    logs_sync::{sync_logs_with_cancel, LogsSyncParams},
    search::{search_query, SearchQueryParams},
};
use serde_json::json;

use crate::cli::{LogSearchArgs, LogStatusArgs, LogSyncArgs};

pub fn run_sync(args: &LogSyncArgs, workspace_root: Option<String>) -> Result<i32, String> {
    let result = sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: args.scope.target_org.clone(),
            workspace_root,
            force_full: args.force_full,
        },
        &CancellationToken::new(),
    )?;

    if args.scope.json {
        println!("{}", serde_json::to_string(&result).map_err(|error| error.to_string())?);
    } else if result.status == "success" {
        println!("Synced Apex logs for {}", result.target_org);
        println!("New logs downloaded: {}", result.downloaded);
        println!("Already cached: {}", result.cached);
        if let Some(log_id) = result.last_synced_log_id.as_deref() {
            println!("Last synced log: {log_id}");
        }
        println!("State file: {}", result.state_file);
    } else {
        println!("Sync finished with partial results for {}", result.target_org);
        println!("Downloaded: {}", result.downloaded);
        println!("Already cached: {}", result.cached);
        println!("Failed: {}", result.failed);
        println!("Checkpoint not advanced");
        println!("State file: {}", result.state_file);
    }

    Ok(match result.status.as_str() {
        "success" => 0,
        "partial" => 2,
        "cancelled" => 130,
        _ => 1,
    })
}

pub fn run_status(args: &LogStatusArgs, workspace_root: Option<String>) -> Result<i32, String> {
    let state = read_sync_state(workspace_root.as_deref())?;
    let target_org = args
        .scope
        .target_org
        .clone()
        .or_else(|| state.orgs.keys().next().cloned())
        .unwrap_or_else(|| "default".to_string());
    let entry = state.orgs.get(&target_org);
    let apexlogs_root = resolve_apexlogs_root(workspace_root.as_deref());

    let payload = json!({
        "target_org": target_org,
        "apexlogs_root": apexlogs_root.display().to_string(),
        "state_file": apexlogs_root.join(".alv").join("sync-state.json").display().to_string(),
        "last_synced_log_id": entry.and_then(|value| value.last_synced_log_id.clone()),
        "last_sync_completed_at": entry.and_then(|value| value.last_sync_completed_at.clone()),
        "cached_count": entry.map(|value| value.cached_count).unwrap_or(0),
    });

    if args.scope.json {
        println!("{}", serde_json::to_string(&payload).map_err(|error| error.to_string())?);
    } else {
        println!("Target org: {}", payload["target_org"].as_str().unwrap_or("default"));
        println!("Apexlogs root: {}", payload["apexlogs_root"].as_str().unwrap_or(""));
        println!("State file: {}", payload["state_file"].as_str().unwrap_or(""));
        println!(
            "Last synced log: {}",
            payload["last_synced_log_id"].as_str().unwrap_or("<none>")
        );
        println!(
            "Last sync completed: {}",
            payload["last_sync_completed_at"].as_str().unwrap_or("<none>")
        );
        println!("Cached count: {}", payload["cached_count"].as_u64().unwrap_or(0));
    }

    Ok(0)
}

pub fn run_search(args: &LogSearchArgs, workspace_root: Option<String>) -> Result<i32, String> {
    let root = resolve_apexlogs_root(workspace_root.as_deref());
    let scoped_root = args
        .scope
        .target_org
        .as_deref()
        .map(|target_org| root.join("orgs").join(safe_target_org(target_org)).join("logs"));
    let search_root = scoped_root.unwrap_or_else(|| root.join("orgs"));
    let mut log_ids = Vec::<String>::new();
    collect_log_ids(&search_root, &mut log_ids)?;

    let result = search_query(&SearchQueryParams {
        query: args.query.clone(),
        log_ids: log_ids.clone(),
        workspace_root,
    })?;

    let matches = result
        .log_ids
        .iter()
        .map(|log_id| {
            json!({
                "log_id": log_id,
                "snippet": result.snippets.get(log_id).map(|snippet| snippet.text.clone()),
            })
        })
        .collect::<Vec<_>>();

    let payload = json!({
        "target_org": args.scope.target_org.clone().unwrap_or_else(|| "default".to_string()),
        "query": args.query,
        "matches": matches,
        "searched_log_count": log_ids.len(),
    });

    if args.scope.json {
        println!("{}", serde_json::to_string(&payload).map_err(|error| error.to_string())?);
    } else {
        let empty = Vec::new();
        println!("Search query: {}", payload["query"].as_str().unwrap_or(""));
        println!("Target org: {}", payload["target_org"].as_str().unwrap_or("default"));
        println!("Searched logs: {}", payload["searched_log_count"].as_u64().unwrap_or(0));
        for item in payload["matches"].as_array().unwrap_or(&empty) {
            println!(
                "- {} {}",
                item["log_id"].as_str().unwrap_or(""),
                item["snippet"].as_str().unwrap_or("")
            );
        }
    }

    Ok(0)
}

fn collect_log_ids(root: &std::path::Path, log_ids: &mut Vec<String>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(root).map_err(|error| format!("failed to read {}: {error}", root.display()))? {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", root.display()))?;
        let path = entry.path();
        if path.is_dir() {
            collect_log_ids(&path, log_ids)?;
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) == Some("log") {
            if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
                log_ids.push(stem.to_string());
            }
        }
    }
    log_ids.sort();
    log_ids.dedup();
    Ok(())
}
```

Update `crates/alv-cli/src/main.rs` to dispatch through `clap`:

```rust
mod cli;
mod commands;

use clap::Parser;
use cli::{Cli, Command, LogsCommand};

fn main() {
    let cli = Cli::parse();
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|path| path.to_str().map(str::to_string));

    let exit_code = match cli.command {
        Command::AppServer(args) if args.stdio => {
            alv_app_server::server::run_stdio().expect("app-server failed");
            0
        }
        Command::AppServer(_) => {
            eprintln!("app-server requires --stdio");
            1
        }
        Command::Logs(logs) => match logs.command {
            LogsCommand::Sync(args) => commands::logs::run_sync(&args, cwd),
            LogsCommand::Status(args) => commands::logs::run_status(&args, cwd),
            LogsCommand::Search(args) => commands::logs::run_search(&args, cwd),
        }
        .unwrap_or_else(|error| {
            eprintln!("{error}");
            1
        }),
    };

    std::process::exit(exit_code);
}
```

- [ ] **Step 4: Run the CLI smoke tests to verify the green phase**

Run:

```bash
cargo test -p apex-log-viewer-cli --test cli_smoke
```

Expected: PASS.

- [ ] **Step 5: Commit the CLI surface**

Run:

```bash
git add crates/alv-cli/Cargo.toml crates/alv-cli/src/main.rs crates/alv-cli/src/cli.rs crates/alv-cli/src/commands/mod.rs crates/alv-cli/src/commands/logs.rs crates/alv-cli/tests/cli_smoke.rs
git commit -m "feat(cli): add local-first logs commands"
```

Expected: commit succeeds.

---

### Task 5: Update user-facing docs and run the end-to-end verification sweep

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add failing documentation assertions with simple grep-based checks**

Add these exact verification commands to your scratch notes and run them before editing docs:

```bash
rg -n "logs sync|logs status|logs search|apexlogs/.alv|org-first" README.md docs/ARCHITECTURE.md CHANGELOG.md
```

Expected: FAIL to find at least one of the new strings because the docs do not yet mention the new CLI commands or the org-first local layout.

- [ ] **Step 2: Update the README, architecture doc, and changelog**

In `README.md`, add a short CLI section under Usage:

```md
### CLI local-first workflow

The standalone Rust CLI now supports a local-first log workflow that is useful for humans and AI agents:

```bash
apex-log-viewer logs sync --target-org my-org
apex-log-viewer logs status --target-org my-org
apex-log-viewer logs search "NullPointerException" --target-org my-org
```

`logs sync` materializes new log bodies under `apexlogs/` and keeps incremental state under `apexlogs/.alv/`.
```

In `docs/ARCHITECTURE.md`, add a short paragraph near the runtime section:

```md
The standalone CLI and the VS Code extension are separate surfaces over the same shared runtime architecture. Local log storage is evolving toward an org-first `apexlogs/` layout with metadata under `apexlogs/.alv/`, while the runtime remains responsible for compatibility with the legacy flat cache layout during the transition.
```

In `CHANGELOG.md`, add one user-facing bullet under `Unreleased`:

```md
- Added a local-first Rust CLI logs workflow with `logs sync`, `logs status`, and `logs search`, backed by an org-first `apexlogs/` layout and incremental sync state.
```

- [ ] **Step 3: Run the focused verification sweep**

Run:

```bash
cargo test -p alv-core --test log_store_layout
cargo test -p alv-core --test logs_sync_smoke
cargo test -p alv-core --test logs_runtime_smoke
cargo test -p apex-log-viewer-cli --test cli_smoke
npm run test:extension:node
rg -n "logs sync|logs status|logs search|apexlogs/.alv|org-first" README.md docs/ARCHITECTURE.md CHANGELOG.md
```

Expected: all Rust/Node tests PASS and `rg` finds the new documentation text in all three files.

- [ ] **Step 4: Commit the docs and verification**

Run:

```bash
git add README.md docs/ARCHITECTURE.md CHANGELOG.md
git commit -m "docs(logs): document local-first cli workflow"
```

Expected: commit succeeds.

---

## Spec coverage check

- CLI-rich human and AI-agent surface: covered by Task 4.
- `logs sync` as first-class incremental command: covered by Task 2 and Task 4.
- `logs status`: covered by Task 4.
- `logs search` as local-first and no remote fetch: covered by Task 4 with smoke coverage from Task 4 and Rust read compatibility from Task 3.
- Shared runtime/core capability rather than CLI-only behavior: covered by Tasks 1-3.
- New org-first `apexlogs/` layout plus `apexlogs/.alv/`: covered by Tasks 1-2.
- Legacy flat-layout read compatibility: covered by Tasks 1 and 3.
- Extension remains compatible with the new layout: covered by Task 3.
- `app-server --stdio` preserved: covered by Task 4 smoke tests.
- Docs/changelog for user-facing change: covered by Task 5.

## Placeholder scan

- No `TODO`, `TBD`, or "implement later" markers remain.
- Every code-changing task includes exact file paths, code, and commands.
- Later tasks reuse the same names introduced earlier: `log_store`, `logs_sync`, `sync_logs_with_cancel`, `download_log_to_path_with_cancel`, `safe_target_org`.

## Type consistency check

- Shared layout types live under `log_store.rs`: `SyncState`, `SyncStateOrgEntry`, `OrgMetadata`.
- Shared sync entrypoint stays `sync_logs_with_cancel()` with `LogsSyncParams` and `LogsSyncResult`.
- CLI wiring consistently uses `--target-org` and `--json`.
- Search stays local-first by collecting cached log ids and calling `search_query()` rather than inventing a second search path.
