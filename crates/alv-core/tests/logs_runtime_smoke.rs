use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use alv_core::{
    logs::{
        ensure_log_file_cached, extract_code_unit_started, find_cached_log_path, list_logs,
        LogsListParams, TEST_APEX_LOG_FIXTURE_DIR_ENV, TEST_SF_LOG_LIST_JSON_ENV,
    },
    search::{search_query, SearchQueryParams},
    triage::{triage_logs, LogsTriageParams},
};

fn test_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
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

#[test]
fn logs_runtime_smoke_lists_logs_from_sf_fixture() {
    let _guard = test_guard().lock().expect("test guard should lock");

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

    let rows = list_logs(&LogsListParams {
        username: Some("demo@example.com".to_string()),
        page_size: Some(50),
        offset: Some(0),
        before_start_time: None,
        before_id: None,
    })
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
fn logs_runtime_smoke_searches_cached_logs_with_pending_ids() {
    let _guard = test_guard().lock().expect("test guard should lock");

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
    let _guard = test_guard().lock().expect("test guard should lock");

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
    let _guard = test_guard().lock().expect("test guard should lock");

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
