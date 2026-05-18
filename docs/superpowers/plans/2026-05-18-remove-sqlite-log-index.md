# Remove SQLite Log Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the SQLite log index from the shared runtime while keeping local log search file-based and cleaning old SQLite files during `logs sync`.

**Architecture:** The shared Rust runtime will stop writing or querying `log_index`, and `search_query` will always scan synced `.log` files with the existing grep matcher. `logs sync` will perform silent best-effort deletion of `log-index.sqlite`, `log-index.sqlite-wal`, and `log-index.sqlite-shm`, while CLI, app-server, and TypeScript contracts remove all index-specific fields and commands.

**Tech Stack:** Rust workspace (`alv-core`, `alv-cli`, `alv-app-server`), Clap, serde JSON contracts, TypeScript runtime client types, VS Code extension tests, npm scripts, Cargo lockfile.

---

## File Structure

- Modify: `crates/alv-core/src/logs_sync.rs`
  - Owns sync result shape, sync cleanup, and removal of indexing work during sync.
- Modify: `crates/alv-core/src/search.rs`
  - Owns search flow; remove SQLite fast path so only saved log files are searched.
- Modify: `crates/alv-core/src/lib.rs`
  - Remove public `log_index` module export.
- Delete: `crates/alv-core/src/log_index.rs`
  - SQLite implementation is removed completely.
- Modify: `crates/alv-core/Cargo.toml`
  - Remove `rusqlite`.
- Modify: `Cargo.lock`
  - Refresh after dependency removal.
- Modify: `crates/alv-core/tests/logs_sync_smoke.rs`
  - Assert sync does not create SQLite files and does clean old SQLite files.
- Modify: `crates/alv-core/tests/logs_runtime_smoke.rs`
  - Remove partial-index setup and keep a file-only search regression.
- Modify: `crates/alv-cli/src/cli.rs`
  - Remove `logs index rebuild` subcommand types.
- Modify: `crates/alv-cli/src/commands/logs.rs`
  - Remove index command implementation and index fields from status/sync output.
- Modify: `crates/alv-cli/tests/cli_smoke.rs`
  - Assert sync JSON omits index fields and `logs index` is rejected.
- Modify: `packages/app-server-client-ts/src/index.ts`
  - Remove index fields from `LogsSyncResult`.
- Modify: `apps/vscode-extension/src/provider/SfLogsViewProvider.ts`
  - Stop reading/logging `indexed` and `index_error`.
- Modify: `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts`
  - Update runtime sync contract expectations.
- Modify: `apps/vscode-extension/src/test/provider.logs.behavior.test.ts`
  - Update sync stubs to the new result shape.
- Modify: `docs/ARCHITECTURE.md`
  - Remove SQLite/index storage description.
- Modify: `apps/vscode-extension/README.md`
  - Remove `logs index rebuild` documentation and SQLite wording.
- Modify: `apps/vscode-extension/CHANGELOG.md`
  - Add a user-facing Unreleased entry.

---

## Task 1: Rust Sync Tests For No SQLite Index And Cleanup

**Files:**
- Modify: `crates/alv-core/tests/logs_sync_smoke.rs:1-167`

- [ ] **Step 1: Update imports for direct index path checks**

Replace the `std` import at the top of `crates/alv-core/tests/logs_sync_smoke.rs` with:

```rust
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
```

- [ ] **Step 2: Add a local helper for the old SQLite file names**

Add this helper after `make_fixture_dir`:

```rust
fn legacy_index_paths(workspace_root: &Path) -> Vec<PathBuf> {
    let alv_dir = workspace_root.join("apexlogs").join(".alv");
    vec![
        alv_dir.join("log-index.sqlite"),
        alv_dir.join("log-index.sqlite-wal"),
        alv_dir.join("log-index.sqlite-shm"),
    ]
}
```

- [ ] **Step 3: Rewrite the first sync smoke assertions**

In `logs_sync_smoke_writes_new_layout_and_updates_checkpoint`, replace the index assertions:

```rust
assert_eq!(result.indexed, 1);
assert!(
    PathBuf::from(&result.index_file).is_file(),
    "sync should create the shared SQLite search index"
);
```

with:

```rust
for path in legacy_index_paths(&workspace_root) {
    assert!(
        !path.exists(),
        "sync should not create legacy SQLite index file {}",
        path.display()
    );
}
```

Also change the search expectation text from:

```rust
.expect("search should read synced bodies through the shared index");
```

to:

```rust
.expect("search should read synced bodies from local log files");
```

- [ ] **Step 4: Add a failing cleanup test**

Add this test after `logs_sync_smoke_writes_new_layout_and_updates_checkpoint`:

```rust
#[test]
fn logs_sync_smoke_deletes_legacy_sqlite_index_files() {
    let _guard = lock_env_mutex();
    let workspace_root = make_temp_workspace("cleanup-sqlite-index");
    let fixture_dir = make_fixture_dir("fixture-cleanup-sqlite-index");
    fs::write(
        fixture_dir.join("07L000000000004AA.log"),
        "09:00:00.0|USER_INFO|cleanup body\n",
    )
    .expect("fixture log should be writable");

    let legacy_paths = legacy_index_paths(&workspace_root);
    fs::create_dir_all(
        legacy_paths[0]
            .parent()
            .expect("legacy index path should have a parent"),
    )
    .expect("legacy index dir should be writable");
    for path in &legacy_paths {
        fs::write(path, "legacy sqlite bytes").expect("legacy index file should be writable");
    }

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        r#"{"result":{"records":[{"Id":"07L000000000004AA","StartTime":"2026-03-30T18:40:58.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-2","LogLength":4096}]}}"#,
    );
    std::env::set_var(
        "ALV_TEST_SF_ORG_DISPLAY_JSON",
        r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#,
    );
    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );

    let result = sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: None,
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
            concurrency: None,
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect("sync should succeed while deleting legacy SQLite index files");

    assert_eq!(result.status, "success");
    for path in &legacy_paths {
        assert!(
            !path.exists(),
            "sync should delete legacy SQLite index file {}",
            path.display()
        );
    }

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}
```

- [ ] **Step 5: Run the focused Rust test and verify it fails**

Run:

```bash
cargo test -p alv-core --test logs_sync_smoke logs_sync_smoke_deletes_legacy_sqlite_index_files -- --exact
```

Expected: FAIL because `logs sync` does not delete `log-index.sqlite`, `log-index.sqlite-wal`, and `log-index.sqlite-shm` yet.

- [ ] **Step 6: Commit the failing tests**

```bash
git add crates/alv-core/tests/logs_sync_smoke.rs
git commit -m "test(runtime): cover sqlite index removal during sync"
```

---

## Task 2: Runtime Sync Removes Indexing And Cleans Old Files

**Files:**
- Modify: `crates/alv-core/src/logs_sync.rs:1-449`
- Modify: `crates/alv-core/tests/logs_sync_smoke.rs:85-170`

- [ ] **Step 1: Remove `log_index` imports and add cleanup imports**

In `crates/alv-core/src/logs_sync.rs`, replace the top import block with:

```rust
use crate::{
    auth,
    auth::OrgAuth,
    log_store::{
        log_file_path_for_start_time, read_sync_state, safe_target_org, write_org_metadata,
        write_sync_state, write_version_file, OrgMetadata, SyncStateOrgEntry,
        LOG_STORE_LAYOUT_VERSION,
    },
    logs::{
        download_log_to_path_for_auth_with_cancel, list_logs_for_auth_detailed_with_cancel,
        CancellationToken, LogRow, LogsCursor, LogsListParams, LogsRuntimeError,
    },
    orgs::find_alias_for_username,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, VecDeque},
    fs, io,
    sync::{mpsc, Arc, Mutex},
    thread,
};
```

- [ ] **Step 2: Add legacy SQLite file names**

Add this constant after `MAX_SYNC_CONCURRENCY`:

```rust
const LEGACY_LOG_INDEX_FILES: &[&str] = &[
    "log-index.sqlite",
    "log-index.sqlite-wal",
    "log-index.sqlite-shm",
];
```

- [ ] **Step 3: Shrink `LogsSyncResult`**

Replace the `LogsSyncResult` struct with:

```rust
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
```

- [ ] **Step 4: Call cleanup during sync startup**

In `sync_logs_detailed_with_cancel`, immediately after the initial cancellation check and before `write_version_file`, add:

```rust
    cleanup_legacy_log_index_files(params.workspace_root.as_deref());
```

The top of the function should read:

```rust
pub fn sync_logs_detailed_with_cancel(
    params: &LogsSyncParams,
    cancellation: &CancellationToken,
) -> Result<LogsSyncResult, LogsRuntimeError> {
    cancellation
        .check_cancelled()
        .map_err(LogsRuntimeError::from_message)?;
    cleanup_legacy_log_index_files(params.workspace_root.as_deref());
    write_version_file(params.workspace_root.as_deref(), LOG_STORE_LAYOUT_VERSION)
        .map_err(LogsRuntimeError::from_message)?;
    let started_at = timestamp_now();
```

- [ ] **Step 5: Remove indexing counters and index rebuild logic**

Delete these local variables:

```rust
let mut indexed = 0usize;
let mut index_error: Option<String> = None;
```

Delete this block:

```rust
let index_count_before =
    log_index::count_indexed_logs(params.workspace_root.as_deref(), &resolved_username)
        .unwrap_or(0);
```

Delete the block that starts with:

```rust
if !outcome.synced.is_empty() {
```

and ends with the matching closing brace after `index_synced_logs`.

Delete the post-loop rebuild block:

```rust
if indexed == 0 && index_count_before == 0 && !cancellation.is_cancelled() {
    match log_index::rebuild_org_index(
        params.workspace_root.as_deref(),
        &resolved_username,
        cancellation,
    ) {
        Ok(count) => indexed += count,
        Err(error) => {
            if index_error.is_none() {
                index_error = Some(error);
            }
        }
    }
}
```

- [ ] **Step 6: Keep sync-state last error empty**

In the `SyncStateOrgEntry` construction, replace:

```rust
last_error: index_error.clone(),
```

with:

```rust
last_error: None,
```

- [ ] **Step 7: Return the new sync result shape**

Replace the final `Ok(LogsSyncResult { ... })` with:

```rust
    Ok(LogsSyncResult {
        status: status.clone(),
        target_org: resolved_username.clone(),
        safe_target_org: safe_org,
        downloaded,
        cached,
        failed,
        checkpoint_advanced: status == "success",
        state_file: crate::log_store::sync_state_path(params.workspace_root.as_deref())
            .display()
            .to_string(),
        last_synced_log_id: if status == "success" {
            checkpoint.map(|(log_id, _)| log_id)
        } else {
            newest.map(|(log_id, _)| log_id)
        },
    })
```

- [ ] **Step 8: Remove synced index records from page outcomes**

Replace `PageSyncOutcome` with:

```rust
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PageSyncOutcome {
    downloaded: usize,
    cached: usize,
    failed: usize,
    newest_synced: Option<(String, String)>,
}
```

Replace the channel type:

```rust
let (tx, rx) = mpsc::channel::<(usize, LogRow, std::path::PathBuf, SyncItemStatus)>();
```

with:

```rust
let (tx, rx) = mpsc::channel::<(usize, LogRow, SyncItemStatus)>();
```

Replace the send call:

```rust
let _ = tx.send((index, row, target_path, status));
```

with:

```rust
let _ = tx.send((index, row, status));
```

Replace the receive loop header:

```rust
for (index, row, path, item) in rx {
```

with:

```rust
for (index, row, item) in rx {
```

Delete:

```rust
outcome.synced.push(LogIndexRecord { row, path });
```

- [ ] **Step 9: Add silent cleanup helper**

Add this helper before `normalize_sync_concurrency`:

```rust
fn cleanup_legacy_log_index_files(workspace_root: Option<&str>) {
    let alv_dir = crate::log_store::resolve_apexlogs_root(workspace_root).join(".alv");
    for file_name in LEGACY_LOG_INDEX_FILES {
        let path = alv_dir.join(file_name);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => {}
        }
    }
}
```

- [ ] **Step 10: Run focused Rust sync tests**

Run:

```bash
cargo test -p alv-core --test logs_sync_smoke logs_sync_smoke_deletes_legacy_sqlite_index_files -- --exact
cargo test -p alv-core --test logs_sync_smoke logs_sync_smoke_writes_new_layout_and_updates_checkpoint -- --exact
```

Expected: both PASS.

- [ ] **Step 11: Commit runtime sync implementation**

```bash
git add crates/alv-core/src/logs_sync.rs crates/alv-core/tests/logs_sync_smoke.rs
git commit -m "fix(runtime): remove sqlite indexing from log sync"
```

---

## Task 3: Search Uses Files Only And SQLite Module Is Removed

**Files:**
- Modify: `crates/alv-core/src/search.rs:1-165`
- Modify: `crates/alv-core/src/lib.rs:1-12`
- Delete: `crates/alv-core/src/log_index.rs`
- Modify: `crates/alv-core/tests/logs_runtime_smoke.rs:1-690`

- [ ] **Step 1: Rewrite the partial-index search test to file-only search**

In `crates/alv-core/tests/logs_runtime_smoke.rs`, remove `log_index::{self, LogIndexRecord},` from the `use alv_core::{ ... }` import.

Replace the whole test `logs_runtime_smoke_search_falls_back_to_files_for_unindexed_local_logs` with:

```rust
#[test]
fn logs_runtime_smoke_search_reads_local_files_without_sqlite_index() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-file-only");
    let target_org = "selected@example.com";
    let log_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join(target_org)
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&log_dir).expect("selected org log dir should exist");
    fs::write(
        log_dir.join("07L000000000001AA.log"),
        "09:00:00.0|USER_INFO|body without the searched token\n",
    )
    .expect("first log should be writable");
    fs::write(
        log_dir.join("07L000000000002AA.log"),
        "09:00:00.0|FATAL_ERROR|FileOnlyNeedle\n",
    )
    .expect("second log should be writable");

    let result = search_query(&SearchQueryParams {
        query: "FileOnlyNeedle".to_string(),
        log_ids: vec![
            "07L000000000001AA".to_string(),
            "07L000000000002AA".to_string(),
        ],
        username: Some(target_org.to_string()),
        raw_username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should read local log files");

    assert_eq!(result.log_ids, vec!["07L000000000002AA".to_string()]);
    assert!(result.pending_log_ids.is_empty());

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}
```

- [ ] **Step 2: Run the rewritten search test as a file-scan regression guard**

Run:

```bash
cargo test -p alv-core --test logs_runtime_smoke logs_runtime_smoke_search_reads_local_files_without_sqlite_index -- --exact
```

Expected: PASS. This confirms the file-scan behavior works before deleting the SQLite fast path.

- [ ] **Step 3: Run the source-removal RED check**

Run:

```bash
if rg -n "log_index|pub mod log_index" crates/alv-core/src crates/alv-core/tests/logs_runtime_smoke.rs; then
  echo "SQLite index references remain"
  exit 1
fi
```

Expected: FAIL with matches in `crates/alv-core/src/search.rs`, `crates/alv-core/src/lib.rs`, `crates/alv-core/src/log_index.rs`, or `crates/alv-core/tests/logs_runtime_smoke.rs`.

- [ ] **Step 4: Remove the SQLite fast path from search**

In `crates/alv-core/src/search.rs`, replace:

```rust
use crate::{auth, log_index, log_store, logs::CancellationToken};
```

with:

```rust
use crate::{auth, log_store, logs::CancellationToken};
```

Inside `search_query_with_cancel`, delete the `target_org_for_index` and `scan_log_ids` block:

```rust
let target_org_for_index = canonical_username
    .as_deref()
    .or(raw_username_hint)
    .map(str::trim)
    .filter(|value| !value.is_empty());
let mut scan_log_ids = log_ids.clone();
if let Some(target_org) = target_org_for_index {
    if let Some(index_result) = log_index::search_index_lines(
        params.workspace_root.as_deref(),
        target_org,
        query,
        &log_ids,
        cancellation,
    )
    .unwrap_or(None)
    {
        scan_log_ids.clear();
        for log_id in &log_ids {
            cancellation.check_cancelled()?;
            if !index_result.indexed_log_ids.contains(log_id) {
                scan_log_ids.push(log_id.clone());
                continue;
            }
            let Some(line) = index_result.matched_lines.get(log_id) else {
                continue;
            };
            result.log_ids.push(log_id.clone());
            if let Some(snippet) = build_snippet(&matcher, line) {
                result.snippets.insert(log_id.clone(), snippet);
            }
        }
        if scan_log_ids.is_empty() {
            return Ok(result);
        }
    }
}
```

Then replace:

```rust
for log_id in scan_log_ids {
```

with:

```rust
for log_id in log_ids {
```

- [ ] **Step 5: Remove the public module export**

In `crates/alv-core/src/lib.rs`, delete:

```rust
pub mod log_index;
```

- [ ] **Step 6: Delete the SQLite implementation file**

Delete:

```bash
crates/alv-core/src/log_index.rs
```

- [ ] **Step 7: Run focused search tests and the source-removal check**

Run:

```bash
cargo test -p alv-core --test logs_runtime_smoke logs_runtime_smoke_search_reads_local_files_without_sqlite_index -- --exact
cargo test -p alv-core --test logs_runtime_smoke logs_runtime_smoke_search_checks_duplicate_log_ids_across_org_trees -- --exact
if rg -n "log_index|pub mod log_index" crates/alv-core/src crates/alv-core/tests/logs_runtime_smoke.rs; then
  echo "SQLite index references remain"
  exit 1
fi
```

Expected: both tests PASS and the source-removal check prints no matches.

- [ ] **Step 8: Commit file-only search removal**

```bash
git add crates/alv-core/src/search.rs crates/alv-core/src/lib.rs crates/alv-core/tests/logs_runtime_smoke.rs
git rm crates/alv-core/src/log_index.rs
git commit -m "fix(runtime): search synced log files without sqlite"
```

---

## Task 4: CLI Removes Index Command And Index Fields

**Files:**
- Modify: `crates/alv-cli/src/cli.rs:33-87`
- Modify: `crates/alv-cli/src/commands/logs.rs:1-355`
- Modify: `crates/alv-cli/tests/cli_smoke.rs:220-318`

- [ ] **Step 1: Update CLI smoke sync assertions**

In `crates/alv-cli/tests/cli_smoke.rs`, rename `cli_smoke_logs_sync_json_emits_structured_result_and_writes_state` to:

```rust
fn cli_smoke_logs_sync_json_omits_index_fields()
```

In that test, replace:

```rust
assert_eq!(json["indexed"], 1);
assert!(json["index_file"]
    .as_str()
    .is_some_and(|value| value.ends_with("apexlogs/.alv/log-index.sqlite")));
```

with:

```rust
assert!(
    json.get("indexed").is_none(),
    "sync JSON should not expose indexed"
);
assert!(
    json.get("index_file").is_none(),
    "sync JSON should not expose index_file"
);
assert!(
    json.get("index_error").is_none(),
    "sync JSON should not expose index_error"
);
```

Replace the SQLite file assertion:

```rust
assert!(workspace_root
    .join("apexlogs")
    .join(".alv")
    .join("log-index.sqlite")
    .is_file());
```

with:

```rust
assert!(!workspace_root
    .join("apexlogs")
    .join(".alv")
    .join("log-index.sqlite")
    .exists());
```

- [ ] **Step 2: Replace the index rebuild CLI test**

Replace `cli_smoke_logs_index_rebuild_json_indexes_existing_org_logs` with:

```rust
#[test]
fn cli_smoke_logs_index_subcommand_is_removed() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-index-removed-{unique}"));
    fs::create_dir_all(&workspace_root).expect("workspace should exist");

    let output = apex_log_viewer_command()
        .current_dir(&workspace_root)
        .args([
            "logs",
            "index",
            "rebuild",
            "--target-org",
            "default",
            "--json",
        ])
        .output()
        .expect("removed index command should execute and fail");

    assert!(
        !output.status.success(),
        "removed index command should not exit successfully"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unrecognized subcommand")
            || stderr.contains("invalid subcommand")
            || stderr.contains("unexpected argument"),
        "stderr should explain that logs index is no longer accepted: {stderr}"
    );

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}
```

- [ ] **Step 3: Run CLI tests and verify they fail**

Run:

```bash
cargo test -p apex-log-viewer-cli --test cli_smoke cli_smoke_logs_sync_json_omits_index_fields -- --exact
cargo test -p apex-log-viewer-cli --test cli_smoke cli_smoke_logs_index_subcommand_is_removed -- --exact
```

Expected: first FAIL because sync JSON still has index fields, second FAIL because `logs index rebuild` still succeeds.

- [ ] **Step 4: Remove index types from Clap CLI**

In `crates/alv-cli/src/cli.rs`, replace `LogsCommand` with:

```rust
#[derive(Debug, Subcommand)]
pub enum LogsCommand {
    Sync(LogSyncArgs),
    Status(LogStatusArgs),
    Search(LogSearchArgs),
}
```

Delete these types:

```rust
#[derive(Debug, Args)]
pub struct LogIndexArgs {
    #[command(subcommand)]
    pub command: LogIndexCommand,
}

#[derive(Debug, Subcommand)]
pub enum LogIndexCommand {
    Rebuild(LogIndexRebuildArgs),
}

#[derive(Debug, Args)]
pub struct LogIndexRebuildArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub json: bool,
}
```

- [ ] **Step 5: Remove index command implementation from logs command handler**

In `crates/alv-cli/src/commands/logs.rs`, replace the first import block with:

```rust
use crate::cli::{LogSearchArgs, LogStatusArgs, LogSyncArgs, LogsArgs, LogsCommand};
use alv_core::{
    auth,
    log_store::{self, OrgMetadata, SyncState},
    logs::{CancellationToken, LogsRuntimeError, RuntimeErrorData},
    logs_sync::{sync_logs_detailed_with_cancel, LogsSyncParams, LogsSyncResult},
    search::{search_query, SearchQueryParams, SearchQueryResult, SearchSnippet},
};
use serde::Serialize;
use std::{collections::BTreeSet, env, fs, path::Path};
```

Replace `StatusResult` with:

```rust
#[derive(Debug, Clone, Serialize)]
struct StatusResult {
    target_org: String,
    safe_target_org: String,
    workspace_root: String,
    apexlogs_root: String,
    state_file: String,
    log_count: usize,
    has_state: bool,
    last_sync_started_at: Option<String>,
    last_sync_completed_at: Option<String>,
    last_synced_log_id: Option<String>,
    last_synced_start_time: Option<String>,
    downloaded_count: usize,
    cached_count: usize,
    last_error: Option<String>,
}
```

Delete `IndexRebuildResult`.

Replace `run` with:

```rust
pub fn run(args: LogsArgs) -> Result<i32, String> {
    match args.command {
        LogsCommand::Sync(sync) => run_sync(sync),
        LogsCommand::Status(status) => run_status(status),
        LogsCommand::Search(search) => run_search(search),
    }
}
```

Delete `run_index` and `run_index_rebuild`.

In `run_status`, delete:

```rust
let indexed_count =
    log_index::count_indexed_logs(Some(&workspace_root), &resolved_username).unwrap_or(0);
```

Remove `indexed_count` and `index_file` from the `StatusResult` construction.

- [ ] **Step 6: Remove index lines from human CLI output**

In `print_sync_summary`, replace the body with:

```rust
fn print_sync_summary(result: &LogsSyncResult) {
    println!("Synced Apex logs");
    println!("Status: {}", result.status);
    println!("Downloaded: {}", result.downloaded);
    println!("Cached: {}", result.cached);
    println!("Failed: {}", result.failed);
    println!("Checkpoint advanced: {}", result.checkpoint_advanced);
    println!("State file: {}", result.state_file);
}
```

In `print_status_summary`, remove:

```rust
println!("Index file: {}", result.index_file);
println!("Indexed logs: {}", result.indexed_count);
```

- [ ] **Step 7: Run CLI tests**

Run:

```bash
cargo test -p apex-log-viewer-cli --test cli_smoke cli_smoke_logs_sync_json_omits_index_fields -- --exact
cargo test -p apex-log-viewer-cli --test cli_smoke cli_smoke_logs_index_subcommand_is_removed -- --exact
```

Expected: both PASS.

- [ ] **Step 8: Commit CLI contract removal**

```bash
git add crates/alv-cli/src/cli.rs crates/alv-cli/src/commands/logs.rs crates/alv-cli/tests/cli_smoke.rs
git commit -m "fix(cli): remove log index command and fields"
```

---

## Task 5: TypeScript Client And Extension Stop Using Index Fields

**Files:**
- Modify: `packages/app-server-client-ts/src/index.ts:58-70`
- Modify: `apps/vscode-extension/src/provider/SfLogsViewProvider.ts:581-590,1322-1324`
- Modify: `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts:761-844`
- Modify: `apps/vscode-extension/src/test/provider.logs.behavior.test.ts`

- [ ] **Step 1: Update the TypeScript sync result type**

In `packages/app-server-client-ts/src/index.ts`, replace `LogsSyncResult` with:

```ts
export type LogsSyncResult = {
  status: string;
  target_org: string;
  safe_target_org: string;
  downloaded: number;
  cached: number;
  failed: number;
  checkpoint_advanced: boolean;
  state_file: string;
  last_synced_log_id?: string;
};
```

- [ ] **Step 2: Update runtime client test fixture and assertion**

In `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts`, replace the `logs/sync` fake response with:

```ts
return {
  status: 'success',
  target_org: 'demo@example.com',
  safe_target_org: 'demo@example.com',
  downloaded: 12,
  cached: 5,
  failed: 0,
  checkpoint_advanced: true,
  state_file: '/workspace/project/apexlogs/.alv/sync-state.json',
  last_synced_log_id: '07L000000000001AA'
} as never;
```

Replace:

```ts
assert.equal(syncResult.indexed, 17);
```

with:

```ts
assert.equal(syncResult.downloaded + syncResult.cached, 17);
```

- [ ] **Step 3: Update provider sync stubs**

In `apps/vscode-extension/src/test/provider.logs.behavior.test.ts`, remove `indexed` and `index_file` properties from every object returned by `logsSync`. The default stub near the top should become:

```ts
logsSync: async () => ({
  status: 'success',
  downloaded: 0,
  cached: 0,
  failed: 0,
  checkpoint_advanced: false,
  state_file: '/tmp/alv-workspace/apexlogs/.alv/sync-state.json'
})
```

Apply the same shape to every test-local `cli.logsSync` return object: keep `status`, `target_org` and `safe_target_org` when the test already uses them; keep `downloaded`, `cached`, `failed`, `checkpoint_advanced`, and `state_file`; remove `indexed`, `index_file`, and `index_error`.

- [ ] **Step 4: Verify TypeScript fails before provider code is fixed**

Run:

```bash
npm run check-types
```

Expected: FAIL because `SfLogsViewProvider.ts` still reads `result.indexed` or `result.index_error`.

- [ ] **Step 5: Remove index usage from the provider**

In `apps/vscode-extension/src/provider/SfLogsViewProvider.ts`, replace the background sync log block:

```ts
logInfo('Logs: background sync finished', {
  status: result.status,
  downloaded: result.downloaded,
  cached: result.cached,
  indexed: result.indexed,
  failed: result.failed
});
if (result.index_error) {
  logWarn('Logs: background sync index warning ->', result.index_error);
}
```

with:

```ts
logInfo('Logs: background sync finished', {
  status: result.status,
  downloaded: result.downloaded,
  cached: result.cached,
  failed: result.failed
});
```

In `downloadAllLogs`, delete:

```ts
if (result.index_error) {
  logWarn('Logs: downloadAllLogs index warning ->', result.index_error);
}
```

- [ ] **Step 6: Run focused TypeScript checks and Node tests**

Run:

```bash
npm run check-types
npm run compile-tests
VSCODE_TEST_GREP="runtime client|background sync|download all" npm run test:extension:node
```

Expected: all PASS. If the grep runs zero tests, run:

```bash
npm run test:extension:node
```

Expected: PASS.

- [ ] **Step 7: Commit TypeScript contract update**

```bash
git add packages/app-server-client-ts/src/index.ts apps/vscode-extension/src/provider/SfLogsViewProvider.ts apps/vscode-extension/src/test/runtime/runtimeClient.test.ts apps/vscode-extension/src/test/provider.logs.behavior.test.ts
git commit -m "fix(extension): remove log index sync fields"
```

---

## Task 6: Remove SQLite Dependency And Refresh Lockfile

**Files:**
- Modify: `crates/alv-core/Cargo.toml:12-24`
- Modify: `Cargo.lock`

- [ ] **Step 1: Remove `rusqlite` dependency**

In `crates/alv-core/Cargo.toml`, delete:

```toml
rusqlite = { version = "0.39", features = ["bundled"] }
```

- [ ] **Step 2: Refresh Cargo dependency resolution**

Run:

```bash
cargo check -p alv-core
```

Expected: PASS and `Cargo.lock` is updated.

- [ ] **Step 3: Confirm `rusqlite` is gone**

Run:

```bash
cargo tree -p alv-core -i rusqlite
```

Expected: command exits non-zero and stderr contains:

```text
package ID specification `rusqlite` did not match any packages
```

- [ ] **Step 4: Confirm there are no runtime source references**

Run:

```bash
rg -n "rusqlite|libsqlite3|sqlite-wasm-rs|pub mod log_index|crate::log_index|log_index::|indexed_count|index_file|index_error|\\bindexed\\b" crates packages/app-server-client-ts/src apps/vscode-extension/src --glob '!**/media/**'
```

Expected: no matches except test names or changelog/spec text outside the searched source paths.

- [ ] **Step 5: Commit dependency removal**

```bash
git add crates/alv-core/Cargo.toml Cargo.lock
git commit -m "build(runtime): remove sqlite dependency"
```

---

## Task 7: Documentation And Changelog

**Files:**
- Modify: `docs/ARCHITECTURE.md:46-67`
- Modify: `apps/vscode-extension/README.md:60-75`
- Modify: `apps/vscode-extension/CHANGELOG.md:1-35`

- [ ] **Step 1: Update architecture storage bullets**

In `docs/ARCHITECTURE.md`, replace the shared local log storage bullets with:

```markdown
- `apexlogs/.alv/version.json` stores the local layout version.
- `apexlogs/.alv/sync-state.json` stores incremental sync checkpoints by org.
- `apexlogs/orgs/<safe-target-org>/org.json` stores resolved org metadata.
- `apexlogs/orgs/<safe-target-org>/logs/<YYYY-MM-DD>/<logId>.log` stores full log bodies.
```

Replace the paragraph that mentions `logs index rebuild` with:

```markdown
The Rust CLI exposes that shared storage through `apex-log-viewer logs sync`, `logs status`, and `logs search`. The VS Code Logs panel uses the same app-server contract for `logs/list`, starts `logs/sync` in the background after refresh/load-more, and reruns triage/search after synced bodies are available locally. For `logs sync`, the runtime still reuses `sf org display` for org auth, but the actual list/body fetches go straight to the Salesforce Tooling REST API and can download bodies concurrently per page.
```

Replace data-flow step 3 and 5 with:

```markdown
3. The runtime syncs full log bodies in the background.
5. Search and error triage reuse synced bodies through the shared runtime instead of re-downloading rows already present locally.
```

- [ ] **Step 2: Update README CLI section**

In `apps/vscode-extension/README.md`, replace the CLI command block with:

````markdown
```bash
apex-log-viewer logs sync --target-org my-org --concurrency 6
apex-log-viewer logs status --target-org my-org
apex-log-viewer logs search "NullPointerException" --target-org my-org
```
````

Replace the following paragraph with:

```markdown
`logs sync` reuses `sf org display` for auth, then lists `ApexLog` rows and downloads raw log bodies over the Salesforce Tooling REST API. It materializes those bodies under `apexlogs/`, keeps incremental state in `apexlogs/.alv/sync-state.json`, writes the canonical org-first layout at `apexlogs/orgs/<safe-target-org>/logs/YYYY-MM-DD/<logId>.log`, and removes the legacy SQLite search index files from older runtime versions. Use `--concurrency` when you want to tune how many log bodies are downloaded in parallel; the default is `6` and `1` keeps the old serial-style troubleshooting mode. The VS Code extension and the CLI remain separate surfaces over the same shared Rust runtime architecture, and both can reuse the same local bodies and sync checkpoints.
```

- [ ] **Step 3: Add changelog entry**

In `apps/vscode-extension/CHANGELOG.md`, add this bullet under `Unreleased`:

```markdown
- Runtime/Logs: remove the SQLite/FTS log index and `logs index rebuild`; local search now scans synced log files directly, and `logs sync` removes legacy `log-index.sqlite` files from older runtime versions.
```

- [ ] **Step 4: Run docs/source reference check**

Run:

```bash
rg -n "logs index rebuild|log-index.sqlite|SQLite/FTS|indexed_count|index_file|index_error" docs apps/vscode-extension/README.md apps/vscode-extension/CHANGELOG.md crates packages/app-server-client-ts/src apps/vscode-extension/src --glob '!**/media/**'
```

Expected: only the new changelog bullet and the approved spec/plan documents mention removed terms.

- [ ] **Step 5: Commit docs**

```bash
git add docs/ARCHITECTURE.md apps/vscode-extension/README.md apps/vscode-extension/CHANGELOG.md
git commit -m "docs: update log search storage without sqlite"
```

---

## Task 8: Full Verification Sweep

**Files:**
- Read-only verification across the repository.

- [ ] **Step 1: Run Rust focused and smoke tests**

Run:

```bash
cargo test -p alv-core --test logs_sync_smoke
cargo test -p alv-core --test logs_runtime_smoke
cargo test -p apex-log-viewer-cli --test cli_smoke
```

Expected: all PASS.

- [ ] **Step 2: Run workspace Rust smoke suite**

Run:

```bash
npm run test:rust:smoke
```

Expected: PASS.

- [ ] **Step 3: Run TypeScript checks and Node extension tests**

Run:

```bash
npm run check-types
npm run compile-tests
npm run test:extension:node
```

Expected: all PASS.

- [ ] **Step 4: Run source-level removal checks**

Run:

```bash
rg -n "rusqlite|libsqlite3|sqlite-wasm-rs|pub mod log_index|crate::log_index|log_index::|logs index rebuild|indexed_count|index_file|index_error|\\bindexed\\b" crates packages/app-server-client-ts/src apps/vscode-extension/src docs/ARCHITECTURE.md apps/vscode-extension/README.md --glob '!**/media/**'
cargo tree -p alv-core -i rusqlite
```

Expected: the `rg` command prints no active source/docs matches, and `cargo tree` reports that `rusqlite` does not match any packages.

- [ ] **Step 5: Review final diff**

Run:

```bash
git status --short
git diff --stat HEAD~7..HEAD
```

Expected: only planned files changed, and there are commits for tests, runtime sync, file-only search, CLI contract, TypeScript contract, dependency removal, and docs.

---

## Self-Review

- Spec coverage: Tasks 1-2 cover sync cleanup and removed sync fields, Task 3 covers file-only search and `log_index` deletion, Task 4 covers CLI command/field removal, Task 5 covers TypeScript and VS Code extension consumers, Task 6 covers dependency and lockfile removal, Task 7 covers docs/changelog, and Task 8 covers final verification.
- Placeholder scan: the plan contains no red-flag placeholder text, incomplete implementation steps, generic error-handling instructions, or unspecified file targets.
- Type consistency: `LogsSyncResult` consistently keeps `status`, `target_org`, `safe_target_org`, `downloaded`, `cached`, `failed`, `checkpoint_advanced`, `state_file`, and `last_synced_log_id`, and consistently removes `indexed`, `index_file`, and `index_error`.
