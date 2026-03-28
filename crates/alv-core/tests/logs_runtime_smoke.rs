#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use alv_core::{
    logs::{
        ensure_log_file_cached, extract_code_unit_started, find_cached_log_path,
        list_logs_with_cancel, CancellationToken, LogsListParams, TEST_APEX_LOG_FIXTURE_DIR_ENV,
        TEST_SF_LOG_LIST_JSON_ENV,
    },
    search::{search_query, search_query_with_cancel, SearchQueryParams},
    triage::{triage_logs, triage_logs_with_cancel, LogsTriageParams},
};

fn test_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}

fn lock_test_guard() -> std::sync::MutexGuard<'static, ()> {
    test_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn make_temp_workspace(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("alv-{name}-{nonce}"));
    fs::create_dir_all(&root).expect("temp workspace should be creatable");
    root
}

#[cfg(unix)]
fn write_fake_sf_command(root: &PathBuf, body: &str) {
    let script_path = root.join("sf");
    fs::write(&script_path, body).expect("fake sf script should be writable");
    let mut permissions = fs::metadata(&script_path)
        .expect("fake sf script metadata should exist")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&script_path, permissions).expect("fake sf script should be executable");
}

#[test]
fn logs_runtime_smoke_lists_logs_from_sf_fixture() {
    let _guard = lock_test_guard();

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        r#"{
          "result": {
            "records": [
              {
                "Id": "07L000000000001AA",
                "StartTime": "2026-03-27T12:00:00.000Z",
                "Operation": "ExecuteAnonymous",
                "Application": "Developer Console",
                "DurationMilliseconds": 125,
                "Status": "Success",
                "Request": "REQ-1",
                "LogLength": 4096,
                "LogUser": { "Name": "Ada" }
              }
            ]
          }
        }"#,
    );

    let rows = list_logs_with_cancel(
        &LogsListParams {
            username: Some("demo@example.com".to_string()),
            limit: Some(50),
            cursor: None,
            offset: Some(0),
        },
        &CancellationToken::new(),
    )
    .expect("logs/list should parse fixture");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "07L000000000001AA");
    assert_eq!(rows[0].operation, "ExecuteAnonymous");
    assert_eq!(
        rows[0]
            .log_user
            .as_ref()
            .and_then(|user| user.name.as_deref()),
        Some("Ada")
    );

    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
}

#[test]
fn logs_runtime_smoke_cancels_logs_list_before_fixture_returns() {
    let _guard = lock_test_guard();

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        r#"{
          "result": {
            "records": [
              {
                "Id": "07L000000000001AA",
                "StartTime": "2026-03-27T12:00:00.000Z",
                "Operation": "ExecuteAnonymous",
                "Application": "Developer Console",
                "DurationMilliseconds": 125,
                "Status": "Success",
                "Request": "REQ-1",
                "LogLength": 4096
              }
            ]
          }
        }"#,
    );
    std::env::set_var("ALV_TEST_LOGS_CANCEL_DELAY_MS", "250");

    let cancelled = Arc::new(AtomicBool::new(false));
    let token = CancellationToken::new();
    let cancel_handle = token.clone();
    let cancelled_flag = Arc::clone(&cancelled);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        cancel_handle.cancel();
        cancelled_flag.store(true, Ordering::SeqCst);
    });

    let result = list_logs_with_cancel(
        &LogsListParams {
            username: Some("demo@example.com".to_string()),
            limit: Some(50),
            cursor: None,
            offset: Some(0),
        },
        &token,
    );

    assert!(cancelled.load(Ordering::SeqCst));
    assert!(result
        .expect_err("logs/list should notice cancellation")
        .contains("cancel"));

    std::env::remove_var("ALV_TEST_LOGS_CANCEL_DELAY_MS");
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
}

#[test]
fn logs_runtime_smoke_search_respects_cancellation_mid_scan() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-cancel");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    fs::write(
        apexlogs_dir.join("default_07L000000000001AA.log"),
        (0..200)
            .map(|index| format!("09:00:{index:02}.0|USER_INFO|line {index}\n"))
            .collect::<String>(),
    )
    .expect("cached log should be writable");
    std::env::set_var("ALV_TEST_SEARCH_LINE_DELAY_MS", "5");

    let token = CancellationToken::new();
    let cancel_handle = token.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(40));
        cancel_handle.cancel();
    });

    let result = search_query_with_cancel(
        &SearchQueryParams {
            query: "line 199".to_string(),
            log_ids: vec!["07L000000000001AA".to_string()],
            workspace_root: Some(workspace_root.display().to_string()),
        },
        &token,
    );

    assert!(result
        .expect_err("search/query should stop when cancelled")
        .contains("cancel"));

    std::env::remove_var("ALV_TEST_SEARCH_LINE_DELAY_MS");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_triage_respects_cancellation_mid_file() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("triage-cancel");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    fs::write(
        apexlogs_dir.join("default_07L000000000001AA.log"),
        (0..200)
            .map(|index| format!("09:00:{index:02}.0|USER_INFO|line {index}\n"))
            .collect::<String>(),
    )
    .expect("cached log should be writable");
    std::env::set_var("ALV_TEST_TRIAGE_LINE_DELAY_MS", "5");

    let token = CancellationToken::new();
    let cancel_handle = token.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(40));
        cancel_handle.cancel();
    });

    let result = triage_logs_with_cancel(
        &LogsTriageParams {
            log_ids: vec!["07L000000000001AA".to_string()],
            username: None,
            workspace_root: Some(workspace_root.display().to_string()),
        },
        &token,
    );

    assert!(result
        .expect_err("logs/triage should stop when cancelled")
        .contains("cancel"));

    std::env::remove_var("ALV_TEST_TRIAGE_LINE_DELAY_MS");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_searches_cached_logs_with_pending_ids() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    fs::write(
        apexlogs_dir.join("default_07L000000000001AA.log"),
        "09:00:00.0|USER_INFO|NullPointerException happened here\n",
    )
    .expect("cached log should be writable");

    let result = search_query(&SearchQueryParams {
        query: "nullpointerexception".to_string(),
        log_ids: vec![
            "07L000000000001AA".to_string(),
            "07L000000000002AA".to_string(),
        ],
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should succeed");

    assert_eq!(result.log_ids, vec!["07L000000000001AA".to_string()]);
    assert_eq!(
        result.pending_log_ids,
        vec!["07L000000000002AA".to_string()]
    );
    let snippet = result
        .snippets
        .get("07L000000000001AA")
        .expect("matched log should include snippet");
    assert!(snippet.text.contains("NullPointerException"));
    assert_eq!(snippet.ranges.len(), 1);

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_triages_logs_and_caches_fixture_downloads() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("triage");
    let fixture_root = make_temp_workspace("triage-fixture");
    let log_id = "07L00000000000TRI";
    fs::write(
        fixture_root.join(format!("{log_id}.log")),
        "\
09:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|AccountService.handle\n\
09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_root.display().to_string(),
    );

    let items = triage_logs(&LogsTriageParams {
        log_ids: vec![log_id.to_string()],
        username: Some("demo@example.com".to_string()),
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("logs/triage should succeed");

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].log_id, log_id);
    assert_eq!(
        items[0].code_unit_started.as_deref(),
        Some("AccountService.handle")
    );
    assert!(items[0].summary.has_errors);
    assert_eq!(
        items[0].summary.primary_reason.as_deref(),
        Some("Fatal exception")
    );
    assert_eq!(items[0].summary.reasons[0].code, "fatal_exception");

    let cached = find_cached_log_path(Some(&workspace_root.display().to_string()), log_id)
        .expect("triage should cache downloaded fixture log");
    assert!(cached
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .contains("demo@example.com"));

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_root).expect("fixture workspace should be removable");
}

#[test]
fn logs_runtime_smoke_triage_returns_partial_results_when_one_log_is_unreadable() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("triage-partial");
    let fixture_root = make_temp_workspace("triage-partial-fixture");
    let readable_log_id = "07L00000000000OK1";
    let missing_log_id = "07L00000000000MIS";
    fs::write(
        fixture_root.join(format!("{readable_log_id}.log")),
        "\
09:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|AccountService.handle\n\
09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_root.display().to_string(),
    );

    let items = triage_logs(&LogsTriageParams {
        log_ids: vec![missing_log_id.to_string(), readable_log_id.to_string()],
        username: Some("demo@example.com".to_string()),
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("logs/triage should return partial results");

    assert_eq!(items.len(), 2, "should preserve one item per requested log");

    let unreadable = items
        .iter()
        .find(|item| item.log_id == missing_log_id)
        .expect("missing log should still produce an item");
    let expected_unreadable_reason = format!(
        "Log triage unavailable: fixture log file not found for {missing_log_id}: {}",
        fixture_root.join(format!("{missing_log_id}.log")).display()
    );
    assert!(unreadable.summary.has_errors);
    assert_eq!(
        unreadable.summary.primary_reason.as_deref(),
        Some(expected_unreadable_reason.as_str())
    );
    assert_eq!(unreadable.summary.reasons.len(), 1);
    assert_eq!(
        unreadable.summary.reasons[0].code,
        "suspicious_error_payload"
    );
    assert_eq!(unreadable.summary.reasons[0].severity, "warning");

    let readable = items
        .iter()
        .find(|item| item.log_id == readable_log_id)
        .expect("healthy log should still be triaged");
    assert_eq!(
        readable.code_unit_started.as_deref(),
        Some("AccountService.handle")
    );
    assert!(readable.summary.has_errors);
    assert_eq!(
        readable.summary.primary_reason.as_deref(),
        Some("Fatal exception")
    );

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_root).expect("fixture workspace should be removable");
}

#[test]
fn logs_runtime_smoke_extracts_code_unit_started() {
    let lines = vec![
        "09:00:00.0|EXECUTION_STARTED",
        "09:00:00.1|CODE_UNIT_STARTED|[EXTERNAL]|InvoiceService.run",
    ];

    let extracted = extract_code_unit_started(&lines);
    assert_eq!(extracted.as_deref(), Some("InvoiceService.run"));
}

#[test]
fn logs_runtime_smoke_ensure_log_cache_uses_fixture_copy() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("ensure-cache");
    let fixture_root = make_temp_workspace("ensure-cache-fixture");
    let log_id = "07L00000000000ENS";
    fs::write(
        fixture_root.join(format!("{log_id}.log")),
        "line 1\nline 2\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_root.display().to_string(),
    );

    let cached = ensure_log_file_cached(
        log_id,
        Some("cache@example.com"),
        Some(&workspace_root.display().to_string()),
    )
    .expect("ensure_log_file_cached should copy fixture into workspace cache");
    assert!(cached.exists());

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_root).expect("fixture workspace should be removable");
}

#[cfg(unix)]
#[test]
fn logs_runtime_smoke_drains_large_sf_json_output_without_hanging() {
    let _guard = lock_test_guard();

    let fake_bin_root = make_temp_workspace("sf-large-output");
    write_fake_sf_command(
        &fake_bin_root,
        r#"#!/usr/bin/env bash
python3 - <<'PY'
import json
payload = {
    "result": {
        "records": [
            {
                "Id": "07L000000000001AA",
                "StartTime": "2026-03-27T12:00:00.000Z",
                "Operation": "X" * 200000,
                "Application": "Developer Console",
                "DurationMilliseconds": 125,
                "Status": "Success",
                "Request": "REQ-1",
                "LogLength": 4096
            }
        ]
    }
}
print(json.dumps(payload))
PY
"#,
    );

    let previous_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var(
        "PATH",
        format!("{}:{}", fake_bin_root.display(), previous_path),
    );
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);

    let rows = list_logs_with_cancel(
        &LogsListParams {
            username: Some("demo@example.com".to_string()),
            limit: Some(1),
            cursor: None,
            offset: Some(0),
        },
        &CancellationToken::new(),
    )
    .expect("logs/list should read large stdout payloads");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].operation.len(), 200000);

    std::env::set_var("PATH", previous_path);
    fs::remove_dir_all(fake_bin_root).expect("fake sf workspace should be removable");
}
