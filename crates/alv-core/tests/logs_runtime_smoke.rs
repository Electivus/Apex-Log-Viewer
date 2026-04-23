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
    auth::TEST_ORG_DISPLAY_JSON_ENV,
    logs::{
        ensure_log_file_cached, extract_code_unit_started, find_cached_log_path,
        list_logs_detailed_with_cancel, list_logs_with_cancel, CancellationToken, LogsListParams,
        TEST_APEX_LOG_FIXTURE_DIR_ENV, TEST_SF_LOG_LIST_JSON_ENV,
    },
    search::{search_query, search_query_with_cancel, SearchQueryParams},
    triage::{triage_logs, triage_logs_with_cancel, LogsTriageParams},
};
use tiny_http::{Header, Response, Server, StatusCode};

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

fn org_display_fixture(instance_url: &str) -> String {
    format!(
        r#"{{"result":{{"username":"demo@example.com","accessToken":"token","instanceUrl":"{instance_url}"}}}}"#
    )
}

#[derive(Clone)]
struct ScriptedHttpResponse {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

fn spawn_scripted_http_server(
    responses: Vec<ScriptedHttpResponse>,
) -> (String, thread::JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").expect("test server should bind");
    let base_url = format!("http://{}", server.server_addr());
    let handle = thread::spawn(move || {
        for item in responses {
            let request = server.recv().expect("server should receive request");
            let response = Response::from_data(item.body)
                .with_status_code(StatusCode(item.status))
                .with_header(
                    Header::from_bytes(&b"Content-Type"[..], item.content_type.as_bytes())
                        .expect("header should be valid"),
                );
            request
                .respond(response)
                .expect("server should send response");
        }
    });
    (base_url, handle)
}

fn org_dirs_in_iteration_order(orgs_root: &PathBuf) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(orgs_root)
        .expect("orgs root should be readable")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs
}

fn write_legacy_root_noise_logs(apexlogs_dir: &PathBuf, prefix: &str, count: usize) {
    for index in 0..count {
        fs::write(apexlogs_dir.join(format!("{prefix}_{index:05}.log")), "")
            .expect("noise log should be writable");
    }
}

#[cfg(windows)]
fn write_fake_sf_cmd(root: &PathBuf, body: &str) -> PathBuf {
    let script_path = root.join("sf.cmd");
    fs::write(&script_path, body).expect("fake sf.cmd should be writable");
    script_path
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
fn logs_runtime_smoke_lists_logs_from_warning_prefixed_fixture() {
    let _guard = lock_test_guard();

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        r#" »   Warning: @salesforce/cli update available from 2.127.2 to 2.128.5.
{
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
    .expect("warning-prefixed logs/list fixture should parse");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "07L000000000001AA");
    assert_eq!(rows[0].operation, "ExecuteAnonymous");

    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
}

#[test]
fn logs_runtime_smoke_lists_logs_over_rest_with_auth_fixture() {
    let _guard = lock_test_guard();

    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    let payload = serde_json::json!({
        "result": {
            "records": [{
                "Id": "07L000000000REST",
                "StartTime": "2026-03-27T12:00:00.000Z",
                "Operation": "ExecuteAnonymous",
                "Application": "Developer Console",
                "DurationMilliseconds": 125,
                "Status": "Success",
                "Request": "REQ-REST",
                "LogLength": 4096
            }]
        }
    });
    let (base_url, server_handle) = spawn_scripted_http_server(vec![ScriptedHttpResponse {
        status: 200,
        content_type: "application/json",
        body: serde_json::to_vec(&payload).expect("payload should serialize"),
    }]);
    std::env::set_var(TEST_ORG_DISPLAY_JSON_ENV, org_display_fixture(&base_url));

    let rows = list_logs_with_cancel(
        &LogsListParams {
            username: Some("demo@example.com".to_string()),
            limit: Some(1),
            cursor: None,
            offset: Some(0),
        },
        &CancellationToken::new(),
    )
    .expect("logs/list should use the REST runtime path");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "07L000000000REST");

    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    server_handle.join().expect("server thread should complete");
}

#[test]
fn logs_runtime_smoke_includes_http_status_url_and_body_in_list_failures() {
    let _guard = lock_test_guard();

    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    let (base_url, server_handle) = spawn_scripted_http_server(vec![ScriptedHttpResponse {
        status: 403,
        content_type: "application/json",
        body: br#"[{"message":"Session expired or invalid","errorCode":"INVALID_SESSION_ID"}]"#
            .to_vec(),
    }]);
    std::env::set_var(TEST_ORG_DISPLAY_JSON_ENV, org_display_fixture(&base_url));

    let error = list_logs_with_cancel(
        &LogsListParams {
            username: Some("demo@example.com".to_string()),
            limit: Some(1),
            cursor: None,
            offset: Some(0),
        },
        &CancellationToken::new(),
    )
    .expect_err("logs/list should surface the REST failure details");

    assert!(
        error.contains("HTTP 403 Forbidden"),
        "expected status in error, got: {error}"
    );
    assert!(
        error.contains("/services/data/v64.0/tooling/query"),
        "expected request URL in error, got: {error}"
    );
    assert!(
        error.contains("INVALID_SESSION_ID") && error.contains("Session expired or invalid"),
        "expected response body in error, got: {error}"
    );

    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    server_handle.join().expect("server thread should complete");
}

#[test]
fn logs_runtime_smoke_exposes_structured_http_error_data() {
    let _guard = lock_test_guard();

    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    let (base_url, server_handle) = spawn_scripted_http_server(vec![ScriptedHttpResponse {
        status: 403,
        content_type: "application/json",
        body: br#"[{"message":"Session expired or invalid","errorCode":"INVALID_SESSION_ID"}]"#
            .to_vec(),
    }]);
    std::env::set_var(TEST_ORG_DISPLAY_JSON_ENV, org_display_fixture(&base_url));

    let error = list_logs_detailed_with_cancel(
        &LogsListParams {
            username: Some("demo@example.com".to_string()),
            limit: Some(1),
            cursor: None,
            offset: Some(0),
        },
        &CancellationToken::new(),
    )
    .expect_err("logs/list should expose structured REST failure details");

    let data = error
        .data()
        .expect("HTTP list failures should include structured data");
    assert_eq!(data.status, Some(403));
    assert!(
        data.url
            .as_deref()
            .is_some_and(|url| url.contains("/services/data/v") && url.contains("/tooling/query")),
        "expected request URL in data, got: {data:?}"
    );
    assert!(
        data.response_body
            .as_deref()
            .is_some_and(|body| body.contains("INVALID_SESSION_ID")),
        "expected response body in data, got: {data:?}"
    );

    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    server_handle.join().expect("server thread should complete");
}

#[test]
fn logs_runtime_smoke_falls_back_to_org_max_api_version_for_logs_list() {
    let _guard = lock_test_guard();

    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    let payload = serde_json::json!({
        "result": {
            "records": [{
                "Id": "07L000000000FALL",
                "StartTime": "2026-03-27T12:00:00.000Z",
                "Operation": "ExecuteAnonymous",
                "Application": "Developer Console",
                "DurationMilliseconds": 125,
                "Status": "Success",
                "Request": "REQ-FALL",
                "LogLength": 4096
            }]
        }
    });
    let services_data = serde_json::json!([
        { "version": "60.0" },
        { "version": "61.0" }
    ]);
    let (base_url, server_handle) = spawn_scripted_http_server(vec![
        ScriptedHttpResponse {
            status: 404,
            content_type: "application/json",
            body: br#"{"message":"The requested resource does not exist"}"#.to_vec(),
        },
        ScriptedHttpResponse {
            status: 200,
            content_type: "application/json",
            body: serde_json::to_vec(&services_data).expect("services/data should serialize"),
        },
        ScriptedHttpResponse {
            status: 200,
            content_type: "application/json",
            body: serde_json::to_vec(&payload).expect("payload should serialize"),
        },
    ]);
    std::env::set_var(TEST_ORG_DISPLAY_JSON_ENV, org_display_fixture(&base_url));

    let rows = list_logs_with_cancel(
        &LogsListParams {
            username: Some("demo@example.com".to_string()),
            limit: Some(1),
            cursor: None,
            offset: Some(0),
        },
        &CancellationToken::new(),
    )
    .expect("logs/list should retry with the org max API version");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "07L000000000FALL");

    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    server_handle.join().expect("server thread should complete");
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
            username: None,
            raw_username: None,
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

    let result = search_query(&SearchQueryParams {
        query: "NullPointerException".to_string(),
        log_ids: vec!["07L000000000001AA".to_string()],
        username: None,
        raw_username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should succeed");

    assert_eq!(result.log_ids, vec!["07L000000000001AA".to_string()]);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_search_with_blank_log_ids_short_circuits_before_cache_indexing() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-empty-log-ids");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    write_legacy_root_noise_logs(&apexlogs_dir, "noise", 64);
    std::env::set_var("ALV_TEST_SEARCH_ROOT_INDEX_DELAY_MS", "2");

    let token = CancellationToken::new();
    let cancel_handle = token.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        cancel_handle.cancel();
    });

    let result = search_query_with_cancel(
        &SearchQueryParams {
            query: "needle".to_string(),
            log_ids: vec!["   ".to_string()],
            username: None,
            raw_username: None,
            workspace_root: Some(workspace_root.display().to_string()),
        },
        &token,
    )
    .expect("blank log ids should return before indexing cache paths");

    assert!(result.log_ids.is_empty());
    assert!(result.pending_log_ids.is_empty());
    assert!(result.snippets.is_empty());

    std::env::remove_var("ALV_TEST_SEARCH_ROOT_INDEX_DELAY_MS");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_search_checks_duplicate_log_ids_across_org_trees() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-duplicate-orgs");
    let orgs_root = workspace_root.join("apexlogs").join("orgs");
    let first_org_dir = orgs_root
        .join("aaa@example.com")
        .join("logs")
        .join("2026-03-30");
    let second_org_dir = orgs_root
        .join("zzz@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&first_org_dir).expect("first org log dir should exist");
    fs::create_dir_all(&second_org_dir).expect("second org log dir should exist");

    let ordered_org_dirs = org_dirs_in_iteration_order(&orgs_root);
    assert_eq!(
        ordered_org_dirs.len(),
        2,
        "expected the two org trees we just created"
    );
    let first_scanned_log_dir = ordered_org_dirs[0].join("logs").join("2026-03-30");
    let later_log_dir = ordered_org_dirs[1].join("logs").join("2026-03-30");

    // The legacy implementation stops at the first cached path for the log id.
    // Keep the first-scanned copy wrong and the later copy correct so this test
    // only passes when search continues beyond the first org-tree match.
    fs::write(
        first_scanned_log_dir.join("07L000000000009AA.log"),
        "09:00:00.0|USER_INFO|no matching content here\n",
    )
    .expect("first org cached log should be writable");
    fs::write(
        later_log_dir.join("07L000000000009AA.log"),
        "09:00:00.0|FATAL_ERROR|NeedleFromSecondOrg\n",
    )
    .expect("later org cached log should be writable");

    let result = search_query(&SearchQueryParams {
        query: "NeedleFromSecondOrg".to_string(),
        log_ids: vec!["07L000000000009AA".to_string()],
        username: None,
        raw_username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should succeed");

    assert_eq!(result.log_ids, vec!["07L000000000009AA".to_string()]);
    let snippet = result
        .snippets
        .get("07L000000000009AA")
        .expect("matched log should include snippet");
    assert!(snippet.text.contains("NeedleFromSecondOrg"));

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_search_scoped_to_selected_org_ignores_other_org_duplicate_match() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-scoped-ignore-other-org");
    let selected_org_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("selected@example.com")
        .join("logs")
        .join("2026-03-30");
    let other_org_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("other@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&selected_org_dir).expect("selected org log dir should exist");
    fs::create_dir_all(&other_org_dir).expect("other org log dir should exist");
    fs::write(
        selected_org_dir.join("07L00000000000SC1.log"),
        "09:00:00.0|USER_INFO|selected org does not contain the needle\n",
    )
    .expect("selected org cached log should be writable");
    fs::write(
        other_org_dir.join("07L00000000000SC1.log"),
        "09:00:00.0|FATAL_ERROR|ScopedNeedleFromOtherOrg\n",
    )
    .expect("other org cached log should be writable");

    let result = search_query(&SearchQueryParams {
        query: "ScopedNeedleFromOtherOrg".to_string(),
        log_ids: vec!["07L00000000000SC1".to_string()],
        username: Some("selected@example.com".to_string()),
        raw_username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should succeed");

    assert!(result.log_ids.is_empty());
    assert!(result.pending_log_ids.is_empty());
    assert!(!result.snippets.contains_key("07L00000000000SC1"));

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_search_scoped_to_selected_org_ignores_other_legacy_root_match() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-scoped-ignore-other-legacy-root");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    let log_id = "07L00000000000SR1";
    fs::write(
        apexlogs_dir.join(format!("selected@example.com_{log_id}.log")),
        "09:00:00.0|USER_INFO|selected root cache does not contain the needle\n",
    )
    .expect("selected-org legacy root log should be writable");
    fs::write(
        apexlogs_dir.join(format!("other@example.com_{log_id}.log")),
        "09:00:00.0|FATAL_ERROR|ScopedLegacyRootNeedle\n",
    )
    .expect("other-org legacy root log should be writable");

    let result = search_query(&SearchQueryParams {
        query: "ScopedLegacyRootNeedle".to_string(),
        log_ids: vec![log_id.to_string()],
        username: Some("selected@example.com".to_string()),
        raw_username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should ignore other-org legacy flat cache files");

    assert!(result.log_ids.is_empty());
    assert!(result.pending_log_ids.is_empty());
    assert!(!result.snippets.contains_key(log_id));

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_search_scoped_to_selected_org_uses_legacy_bare_log_fallback() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-scoped-legacy-bare");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    fs::write(
        apexlogs_dir.join("07L00000000000LB1.log"),
        "09:00:00.0|FATAL_ERROR|LegacyBareNeedle\n",
    )
    .expect("legacy bare log should be writable");

    let result = search_query(&SearchQueryParams {
        query: "LegacyBareNeedle".to_string(),
        log_ids: vec!["07L00000000000LB1".to_string()],
        username: Some("selected@example.com".to_string()),
        raw_username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should honor the legacy bare-log fallback");

    assert_eq!(result.log_ids, vec!["07L00000000000LB1".to_string()]);
    assert!(result.pending_log_ids.is_empty());

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_search_scoped_hit_skips_unrelated_legacy_root_scan() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-scoped-skip-legacy-root-scan");
    let apexlogs_dir = workspace_root.join("apexlogs");
    let selected_org_dir = apexlogs_dir
        .join("orgs")
        .join("selected@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&selected_org_dir).expect("selected org log dir should exist");
    let log_id = "07L00000000000SX1";
    fs::write(
        selected_org_dir.join(format!("{log_id}.log")),
        "09:00:00.0|FATAL_ERROR|ScopedIndexedNeedle\n",
    )
    .expect("selected org cached log should be writable");
    write_legacy_root_noise_logs(&apexlogs_dir, "otherorg", 64);
    std::env::set_var("ALV_TEST_SEARCH_ROOT_INDEX_DELAY_MS", "2");

    let token = CancellationToken::new();
    let cancel_handle = token.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        cancel_handle.cancel();
    });

    let result = search_query_with_cancel(
        &SearchQueryParams {
            query: "ScopedIndexedNeedle".to_string(),
            log_ids: vec![log_id.to_string()],
            username: Some("selected@example.com".to_string()),
            raw_username: None,
            workspace_root: Some(workspace_root.display().to_string()),
        },
        &token,
    )
    .expect("scoped search should not scan unrelated legacy root entries");

    assert_eq!(result.log_ids, vec![log_id.to_string()]);
    let snippet = result
        .snippets
        .get(log_id)
        .expect("matched log should include snippet");
    assert!(snippet.text.contains("ScopedIndexedNeedle"));

    std::env::remove_var("ALV_TEST_SEARCH_ROOT_INDEX_DELAY_MS");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_search_falls_back_to_raw_alias_scoped_cache_without_auth() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-alias-offline");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    let log_id = "07L0000000000AS1";
    fs::write(
        apexlogs_dir.join(format!("Alias_Org_{log_id}.log")),
        "09:00:00.0|FATAL_ERROR|AliasScopedNeedle\n",
    )
    .expect("legacy alias-scoped log should be writable");
    let wrong_org_dir = apexlogs_dir
        .join("orgs")
        .join("other@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&wrong_org_dir).expect("wrong org log dir should exist");
    fs::write(
        wrong_org_dir.join(format!("{log_id}.log")),
        "09:00:00.0|USER_INFO|other org should not match\n",
    )
    .expect("wrong org cached log should be writable");

    let result = search_query(&SearchQueryParams {
        query: "AliasScopedNeedle".to_string(),
        log_ids: vec![log_id.to_string()],
        username: Some("Alias Org".to_string()),
        raw_username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should use the raw alias-scoped cache when auth is unavailable");

    assert_eq!(result.log_ids, vec![log_id.to_string()]);
    let snippet = result
        .snippets
        .get(log_id)
        .expect("matched log should include snippet");
    assert!(snippet.text.contains("AliasScopedNeedle"));

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_search_raw_alias_scope_ignores_other_legacy_root_match() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-alias-offline-legacy-root");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    let log_id = "07L0000000000AR1";
    fs::write(
        apexlogs_dir.join(format!("Alias_Org_{log_id}.log")),
        "09:00:00.0|USER_INFO|alias root cache does not contain the needle\n",
    )
    .expect("alias-scoped legacy root log should be writable");
    fs::write(
        apexlogs_dir.join(format!("other@example.com_{log_id}.log")),
        "09:00:00.0|FATAL_ERROR|AliasRootScopeNeedle\n",
    )
    .expect("other-org legacy root log should be writable");

    let result = search_query(&SearchQueryParams {
        query: "AliasRootScopeNeedle".to_string(),
        log_ids: vec![log_id.to_string()],
        username: Some("Alias Org".to_string()),
        raw_username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should ignore unrelated legacy root files during raw alias fallback");

    assert!(result.log_ids.is_empty());
    assert!(result.pending_log_ids.is_empty());
    assert!(!result.snippets.contains_key(log_id));

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_search_uses_legacy_alias_scoped_cache_when_alias_resolves() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("search-alias-canonical-legacy");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    let log_id = "07L0000000000AC1";
    fs::write(
        apexlogs_dir.join(format!("Alias_Org_{log_id}.log")),
        "09:00:00.0|FATAL_ERROR|AliasCanonicalLegacyNeedle\n",
    )
    .expect("legacy alias-scoped log should be writable");

    std::env::set_var(
        TEST_ORG_DISPLAY_JSON_ENV,
        r#"{
            "status": 0,
            "result": {
                "username": "canonical@example.com",
                "accessToken": "00D-token",
                "instanceUrl": "https://example.my.salesforce.com"
            }
        }"#,
    );

    let result = search_query(&SearchQueryParams {
        query: "AliasCanonicalLegacyNeedle".to_string(),
        log_ids: vec![log_id.to_string()],
        username: Some("Alias Org".to_string()),
        raw_username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("search/query should keep the alias-scoped legacy fallback after alias resolution");

    assert_eq!(result.log_ids, vec![log_id.to_string()]);
    assert!(result.pending_log_ids.is_empty());
    let snippet = result
        .snippets
        .get(log_id)
        .expect("matched log should include snippet");
    assert!(snippet.text.contains("AliasCanonicalLegacyNeedle"));

    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_triage_downloads_missing_log_into_unknown_date_directory() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("ensure-new-layout");
    let fixture_dir = make_temp_workspace("ensure-fixture");
    let log_id = "07L000000000001AA";
    fs::write(
        fixture_dir.join(format!("{log_id}.log")),
        "09:00:00.0|USER_INFO|fixture body\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );
    let items = triage_logs(&LogsTriageParams {
        log_ids: vec![log_id.to_string()],
        username: Some("default@example.com".to_string()),
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("logs/triage should download and summarize the fixture log");

    assert_eq!(items.len(), 1);
    let cached = find_cached_log_path(Some(&workspace_root.display().to_string()), log_id)
        .expect("triage should cache the downloaded fixture log");

    assert!(cached
        .ends_with("apexlogs/orgs/default@example.com/logs/unknown-date/07L000000000001AA.log"));

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_triage_uses_legacy_bare_log_fallback_for_scoped_requests() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("triage-scoped-legacy-bare");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    let log_id = "07L00000000000LB2";
    fs::write(
        apexlogs_dir.join(format!("{log_id}.log")),
        "\
09:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|LegacyBare.handle\n\
09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n",
    )
    .expect("legacy bare log should be writable");

    let items = triage_logs(&LogsTriageParams {
        log_ids: vec![log_id.to_string()],
        username: Some("selected@example.com".to_string()),
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("logs/triage should honor the legacy bare-log fallback");

    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].code_unit_started.as_deref(),
        Some("LegacyBare.handle")
    );
    assert_eq!(
        items[0].summary.primary_reason.as_deref(),
        Some("Fatal exception")
    );
    assert!(
        !workspace_root
            .join("apexlogs")
            .join("orgs")
            .join("selected@example.com")
            .join("logs")
            .join("unknown-date")
            .join(format!("{log_id}.log"))
            .exists(),
        "triage should reuse the legacy bare log instead of downloading a duplicate copy"
    );

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_triage_ignores_wrong_org_cached_copy_when_alias_resolves_canonical_user() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("triage-ignore-wrong-org");
    let fixture_dir = make_temp_workspace("triage-ignore-wrong-org-fixture");
    let log_id = "07L0000000000WR1";
    let wrong_org_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("other@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&wrong_org_dir).expect("wrong org log dir should exist");
    fs::write(
        wrong_org_dir.join(format!("{log_id}.log")),
        "09:00:00.0|USER_INFO|wrong org cached copy\n",
    )
    .expect("wrong org cached log should be writable");
    fs::write(
        fixture_dir.join(format!("{log_id}.log")),
        "\
09:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|AccountService.handle\n\
09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(
        TEST_ORG_DISPLAY_JSON_ENV,
        r#"{
          "result": {
            "accessToken": "00D-token",
            "instanceUrl": "https://example.my.salesforce.com",
            "username": "canonical@example.com"
          }
        }"#,
    );
    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );

    let items = triage_logs(&LogsTriageParams {
        log_ids: vec![log_id.to_string()],
        username: Some("Alias Org".to_string()),
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("logs/triage should ignore wrong-org cached copies and use the canonical tree");

    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].code_unit_started.as_deref(),
        Some("AccountService.handle")
    );
    assert_eq!(
        items[0].summary.primary_reason.as_deref(),
        Some("Fatal exception")
    );

    let canonical_cached = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("canonical@example.com")
        .join("logs")
        .join("unknown-date")
        .join(format!("{log_id}.log"));
    assert!(canonical_cached.is_file());

    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_triage_uses_canonical_username_tree_for_alias_input() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("triage-alias");
    let fixture_dir = make_temp_workspace("triage-alias-fixture");
    let log_id = "07L0000000000AL1";
    fs::write(
        fixture_dir.join(format!("{log_id}.log")),
        "\
09:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|AccountService.handle\n\
09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(
        TEST_ORG_DISPLAY_JSON_ENV,
        r#"{
          "result": {
            "accessToken": "00D-token",
            "instanceUrl": "https://example.my.salesforce.com",
            "username": "canonical@example.com"
          }
        }"#,
    );
    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );

    let items = triage_logs(&LogsTriageParams {
        log_ids: vec![log_id.to_string()],
        username: Some("Alias Org".to_string()),
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("logs/triage should resolve alias input and download into the canonical tree");

    assert_eq!(items.len(), 1);
    let cached = find_cached_log_path(Some(&workspace_root.display().to_string()), log_id)
        .expect("triage should cache the downloaded fixture log");
    assert!(cached
        .ends_with("apexlogs/orgs/canonical@example.com/logs/unknown-date/07L0000000000AL1.log"));
    assert!(
        !cached.to_string_lossy().contains("Alias_Org"),
        "alias should not be used as the org-first directory key"
    );

    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_triage_falls_back_to_raw_alias_scoped_cache_without_auth() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("triage-alias-offline");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    let wrong_org_dir = apexlogs_dir
        .join("orgs")
        .join("other@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&wrong_org_dir).expect("wrong org log dir should exist");
    let log_id = "07L0000000000ALO";
    fs::write(
        wrong_org_dir.join(format!("{log_id}.log")),
        "09:00:00.0|USER_INFO|wrong org cached copy\n",
    )
    .expect("wrong org cached log should be writable");
    fs::write(
        apexlogs_dir.join(format!("Alias_Org_{log_id}.log")),
        "\
09:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|AliasOffline.handle\n\
09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n",
    )
    .expect("legacy alias-scoped log should be writable");

    let items = triage_logs(&LogsTriageParams {
        log_ids: vec![log_id.to_string()],
        username: Some("Alias Org".to_string()),
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("logs/triage should reuse the raw alias-scoped cache when auth is unavailable");

    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].code_unit_started.as_deref(),
        Some("AliasOffline.handle")
    );
    assert_eq!(
        items[0].summary.primary_reason.as_deref(),
        Some("Fatal exception")
    );

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
    std::env::set_var("ALV_SF_BIN_PATH", workspace_root.join("missing-sf"));

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
    std::env::remove_var("ALV_SF_BIN_PATH");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn logs_runtime_smoke_triage_uses_default_legacy_cache_without_username() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("triage-default-legacy");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should exist");
    let log_id = "07L0000000000DEF";
    fs::write(
        apexlogs_dir.join(format!("default_{log_id}.log")),
        "\
09:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|DefaultCache.handle\n\
09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n",
    )
    .expect("default-scoped cached log should be writable");
    std::env::set_var("ALV_SF_BIN_PATH", workspace_root.join("missing-sf"));

    let items = triage_logs(&LogsTriageParams {
        log_ids: vec![log_id.to_string()],
        username: None,
        workspace_root: Some(workspace_root.display().to_string()),
    })
    .expect("logs/triage should reuse default-scoped legacy cache without calling sf");

    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].code_unit_started.as_deref(),
        Some("DefaultCache.handle")
    );
    assert_eq!(
        items[0].summary.primary_reason.as_deref(),
        Some("Fatal exception")
    );

    std::env::remove_var("ALV_SF_BIN_PATH");
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
        username: None,
        raw_username: None,
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
    assert!(
        cached.ends_with("apexlogs/orgs/demo@example.com/logs/unknown-date/07L00000000000TRI.log")
    );

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

#[test]
fn logs_runtime_smoke_downloads_log_body_over_rest_into_cache() {
    let _guard = lock_test_guard();

    let workspace_root = make_temp_workspace("ensure-cache-rest");
    let log_id = "07L000000000REST";
    let (base_url, server_handle) = spawn_scripted_http_server(vec![ScriptedHttpResponse {
        status: 200,
        content_type: "text/plain",
        body: b"09:00:00.0|USER_INFO|rest body\n".to_vec(),
    }]);
    std::env::set_var(TEST_ORG_DISPLAY_JSON_ENV, org_display_fixture(&base_url));

    let cached = ensure_log_file_cached(
        log_id,
        Some("demo@example.com"),
        Some(&workspace_root.display().to_string()),
    )
    .expect("ensure_log_file_cached should fetch the ApexLog body via REST");
    assert!(cached.exists());
    assert_eq!(
        fs::read_to_string(&cached).expect("cached log should be readable"),
        "09:00:00.0|USER_INFO|rest body\n"
    );

    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    server_handle.join().expect("server thread should complete");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[cfg(windows)]
#[test]
fn logs_runtime_smoke_uses_explicit_sf_cmd_shim_for_logs_list() {
    let _guard = lock_test_guard();

    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    let payload = serde_json::json!({
        "result": {
            "records": [{
                "Id": "07L000000000001AA",
                "StartTime": "2026-03-27T12:00:00.000Z",
                "Operation": "ExecuteAnonymous",
                "Application": "Developer Console",
                "DurationMilliseconds": 125,
                "Status": "Success",
                "Request": "REQ-1",
                "LogLength": 4096,
                "LogUser": { "Name": "Ada" }
            }]
        }
    });
    let (base_url, server_handle) = spawn_scripted_http_server(vec![ScriptedHttpResponse {
        status: 200,
        content_type: "application/json",
        body: serde_json::to_vec(&payload).expect("payload should serialize"),
    }]);

    let fake_bin_root = make_temp_workspace("sf-cmd-logs-list");
    let script_body = r#"@echo off
if /I "%*"=="org display --json --verbose -o demo@example.com" (
  echo __ORG_DISPLAY_JSON__
  exit /b 0
)
echo Unexpected sf args: %* 1>&2
exit /b 1
"#
    .replace("__ORG_DISPLAY_JSON__", &org_display_fixture(&base_url));
    let sf_cmd = write_fake_sf_cmd(&fake_bin_root, &script_body);

    std::env::set_var("ALV_SF_BIN_PATH", &sf_cmd);

    let rows = list_logs_with_cancel(
        &LogsListParams {
            username: Some("demo@example.com".to_string()),
            limit: Some(1),
            cursor: None,
            offset: Some(0),
        },
        &CancellationToken::new(),
    )
    .expect("logs/list should use explicit sf.cmd shim");

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

    std::env::remove_var("ALV_SF_BIN_PATH");
    server_handle.join().expect("server thread should complete");
    fs::remove_dir_all(fake_bin_root).expect("fake sf workspace should be removable");
}

#[test]
fn logs_runtime_smoke_reads_large_rest_json_payload_without_hanging() {
    let _guard = lock_test_guard();

    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    let payload = serde_json::json!({
        "result": {
            "records": [{
                "Id": "07L000000000001AA",
                "StartTime": "2026-03-27T12:00:00.000Z",
                "Operation": "X".repeat(200000),
                "Application": "Developer Console",
                "DurationMilliseconds": 125,
                "Status": "Success",
                "Request": "REQ-1",
                "LogLength": 4096
            }]
        }
    });
    let (base_url, server_handle) = spawn_scripted_http_server(vec![ScriptedHttpResponse {
        status: 200,
        content_type: "application/json",
        body: serde_json::to_vec(&payload).expect("payload should serialize"),
    }]);
    std::env::set_var(TEST_ORG_DISPLAY_JSON_ENV, org_display_fixture(&base_url));

    let rows = list_logs_with_cancel(
        &LogsListParams {
            username: Some("demo@example.com".to_string()),
            limit: Some(1),
            cursor: None,
            offset: Some(0),
        },
        &CancellationToken::new(),
    )
    .expect("logs/list should read large HTTP payloads");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].operation.len(), 200000);

    std::env::remove_var(TEST_ORG_DISPLAY_JSON_ENV);
    server_handle.join().expect("server thread should complete");
}
