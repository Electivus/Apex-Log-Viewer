use std::{
    ffi::OsString,
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use alv_core::{
    log_store::{org_metadata_path, read_sync_state, resolve_apexlogs_root, OrgMetadata},
    logs::{TEST_APEX_LOG_FIXTURE_DIR_ENV, TEST_SF_LOG_LIST_JSON_ENV},
    logs_sync::{sync_logs_with_cancel, LogsSyncParams},
};
use serde_json::{json, Value};

static ENV_MUTEX: Mutex<()> = Mutex::new(());

fn lock_env_mutex<'a>() -> MutexGuard<'a, ()> {
    ENV_MUTEX
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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

fn org_display_fixture() -> &'static str {
    r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#
}

fn write_log_list_fixture(path: &PathBuf, rows: &[(String, String)]) {
    let records = rows
        .iter()
        .map(|(id, start_time)| {
            json!({
                "Id": id,
                "StartTime": start_time,
                "Operation": "ExecuteAnonymous",
                "Application": "Developer Console",
                "DurationMilliseconds": 125,
                "Status": "Success",
                "Request": format!("REQ-{id}"),
                "LogLength": 4096
            })
        })
        .collect::<Vec<Value>>();
    fs::write(
        path,
        serde_json::to_string(&json!({ "result": { "records": records } }))
            .expect("fixture JSON should serialize"),
    )
    .expect("fixture JSON should be writable");
}

#[cfg(unix)]
fn write_script(path: &PathBuf, body: &str) {
    use std::os::unix::fs::PermissionsExt;

    fs::write(path, body).expect("script should be writable");
    let mut permissions = fs::metadata(path)
        .expect("script metadata should exist")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).expect("script should be executable");
}

#[cfg(windows)]
fn write_script(path: &PathBuf, body: &str) {
    fs::write(path, body).expect("script should be writable");
}

#[cfg(unix)]
fn write_paginated_fake_sf_command(
    root: &PathBuf,
    page_one_path: &PathBuf,
    page_two_path: &PathBuf,
    page_one_last_id: &str,
) {
    let script_path = root.join("sf");
    let body = format!(
        "#!/bin/sh\nquery=\"\"\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--query\" ]; then\n    query=\"$2\"\n    break\n  fi\n  shift\ndone\nif printf '%s' \"$query\" | grep -F \"{page_one_last_id}\" >/dev/null; then\n  cat '{}'\nelse\n  cat '{}'\nfi\n",
        page_two_path.display(),
        page_one_path.display()
    );
    write_script(&script_path, &body);
}

#[cfg(windows)]
fn write_paginated_fake_sf_command(
    root: &PathBuf,
    page_one_path: &PathBuf,
    page_two_path: &PathBuf,
    page_one_last_id: &str,
) {
    let script_path = root.join("sf.cmd");
    let body = format!(
        "@echo off\r\nsetlocal EnableExtensions\r\nset \"args=%*\"\r\necho(%args% | findstr /C:\"{page_one_last_id}\" >nul\r\nif not errorlevel 1 (\r\n  type \"{}\"\r\n) else (\r\n  type \"{}\"\r\n)\r\n",
        page_two_path.display(),
        page_one_path.display()
    );
    write_script(&script_path, &body);
}

#[cfg(unix)]
fn write_failing_fake_sf_command(root: &PathBuf, message: &str) {
    let script_path = root.join("sf");
    let body = format!("#!/bin/sh\necho \"{message}\" 1>&2\nexit 1\n");
    write_script(&script_path, &body);
}

#[cfg(windows)]
fn write_failing_fake_sf_command(root: &PathBuf, message: &str) {
    let script_path = root.join("sf.cmd");
    let body = format!("@echo off\r\necho {message} 1>&2\r\nexit /b 1\r\n");
    write_script(&script_path, &body);
}

#[cfg(unix)]
fn path_with_front(root: &PathBuf, old_path: Option<OsString>) -> OsString {
    let mut updated = OsString::from(root.as_os_str());
    if let Some(previous) = old_path.filter(|value| !value.is_empty()) {
        updated.push(":");
        updated.push(previous);
    }
    updated
}

#[cfg(windows)]
fn path_with_front(root: &PathBuf, old_path: Option<OsString>) -> OsString {
    let mut updated = OsString::from(root.as_os_str());
    if let Some(previous) = old_path.filter(|value| !value.is_empty()) {
        updated.push(";");
        updated.push(previous);
    }
    updated
}

fn restore_path(old_path: Option<OsString>) {
    if let Some(previous) = old_path {
        std::env::set_var("PATH", previous);
    } else {
        std::env::remove_var("PATH");
    }
}

#[test]
fn logs_sync_smoke_writes_new_layout_and_updates_checkpoint() {
    let _guard = lock_env_mutex();
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
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect("sync should succeed");

    assert_eq!(result.status, "success");
    assert_eq!(result.downloaded, 1);
    assert!(resolve_apexlogs_root(Some(
        workspace_root
            .to_str()
            .expect("workspace path should be utf8")
    ))
    .join("orgs")
    .join("default@example.com")
    .join("logs")
    .join("2026-03-30")
    .join("07L000000000003AA.log")
    .is_file());

    let state = read_sync_state(Some(
        workspace_root
            .to_str()
            .expect("workspace path should be utf8"),
    ))
    .expect("sync state should load");
    assert_eq!(
        state.orgs["default@example.com"]
            .last_synced_log_id
            .as_deref(),
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
    let _guard = lock_env_mutex();
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
    std::env::set_var(
        "ALV_TEST_SF_ORG_DISPLAY_JSON",
        r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#,
    );
    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );

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
fn logs_sync_smoke_persists_requested_alias_when_org_list_is_unavailable() {
    let _guard = lock_env_mutex();
    let workspace_root = make_temp_workspace("persist-alias");
    let fixture_dir = make_fixture_dir("fixture-persist-alias");
    fs::write(
        fixture_dir.join("07L000000000008AA.log"),
        "09:00:00.0|USER_INFO|synced body\n",
    )
    .expect("fixture log should be writable");

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        r#"{"result":{"records":[{"Id":"07L000000000008AA","StartTime":"2026-03-30T18:39:58.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-8","LogLength":4096}]}}"#,
    );
    std::env::set_var(
        "ALV_TEST_SF_ORG_DISPLAY_JSON",
        r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#,
    );
    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );

    sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: Some("ALV_ALIAS".to_string()),
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect("sync should succeed");

    let metadata: OrgMetadata = serde_json::from_slice(
        &fs::read(org_metadata_path(
            workspace_root.to_str(),
            "default@example.com",
        ))
        .expect("org metadata should exist"),
    )
    .expect("org metadata should parse");
    assert_eq!(metadata.target_org, "ALV_ALIAS");
    assert_eq!(metadata.alias.as_deref(), Some("ALV_ALIAS"));

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}

#[test]
fn logs_sync_smoke_keeps_previous_checkpoint_on_partial_failure() {
    let _guard = lock_env_mutex();
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
    std::env::set_var(
        "ALV_TEST_SF_ORG_DISPLAY_JSON",
        r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#,
    );
    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );

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
    let state = read_sync_state(Some(
        workspace_root
            .to_str()
            .expect("workspace path should be utf8"),
    ))
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

#[test]
fn logs_sync_smoke_paginates_beyond_first_page() {
    let _guard = lock_env_mutex();
    let workspace_root = make_temp_workspace("paginated");
    let fixture_dir = make_fixture_dir("fixture-paginated");
    let fake_sf_root = make_temp_workspace("fake-sf");
    let page_one_path = fake_sf_root.join("page-1.json");
    let page_two_path = fake_sf_root.join("page-2.json");

    let rows = (1..=201)
        .rev()
        .map(|index| {
            let id = format!("07L{index:012}AA");
            let start_time = format!(
                "2026-03-30T18:{:02}:{:02}.000Z",
                (index / 60) % 60,
                index % 60
            );
            (id, start_time)
        })
        .collect::<Vec<_>>();
    let page_one = rows[..200].to_vec();
    let page_two = rows[200..].to_vec();
    let page_one_last_id = page_one
        .last()
        .map(|(id, _)| id.clone())
        .expect("page one should contain rows");

    for (id, _) in &rows {
        fs::write(
            fixture_dir.join(format!("{id}.log")),
            format!("body for {id}\n"),
        )
        .expect("fixture log should be writable");
    }
    write_log_list_fixture(&page_one_path, &page_one);
    write_log_list_fixture(&page_two_path, &page_two);

    write_paginated_fake_sf_command(
        &fake_sf_root,
        &page_one_path,
        &page_two_path,
        &page_one_last_id,
    );

    let old_path = std::env::var_os("PATH");
    std::env::set_var("PATH", path_with_front(&fake_sf_root, old_path.clone()));
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::set_var("ALV_TEST_SF_ORG_DISPLAY_JSON", org_display_fixture());
    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );

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
    assert_eq!(result.downloaded, 201);
    assert!(resolve_apexlogs_root(Some(
        workspace_root
            .to_str()
            .expect("workspace path should be utf8")
    ))
    .join("orgs")
    .join("default@example.com")
    .join("logs")
    .join(page_two[0].1.get(0..10).expect("day should exist"))
    .join(format!("{}.log", page_two[0].0))
    .is_file());

    let state = read_sync_state(Some(
        workspace_root
            .to_str()
            .expect("workspace path should be utf8"),
    ))
    .expect("sync state should load");
    assert_eq!(
        state.orgs["default@example.com"]
            .last_synced_log_id
            .as_deref(),
        Some(rows[0].0.as_str())
    );

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    restore_path(old_path);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
    fs::remove_dir_all(fake_sf_root).expect("fake sf dir should be removable");
}

#[test]
fn logs_sync_smoke_prefers_checkpoint_id_over_shared_timestamp() {
    let _guard = lock_env_mutex();
    let workspace_root = make_temp_workspace("same-timestamp");
    let fixture_dir = make_fixture_dir("fixture-same-timestamp");
    let shared_start_time = "2026-03-30T18:39:58.000Z";

    for log_id in [
        "07L000000000003AA",
        "07L000000000004AA",
        "07L000000000005AA",
    ] {
        fs::write(
            fixture_dir.join(format!("{log_id}.log")),
            format!("body for {log_id}\n"),
        )
        .expect("fixture log should be writable");
    }

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        format!(
            r#"{{"result":{{"records":[{{"Id":"07L000000000003AA","StartTime":"{shared_start_time}","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-1","LogLength":4096}}]}}}}"#
        ),
    );
    std::env::set_var("ALV_TEST_SF_ORG_DISPLAY_JSON", org_display_fixture());
    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );

    sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: None,
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect("checkpoint seed sync should succeed");

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        format!(
            r#"{{"result":{{"records":[
              {{"Id":"07L000000000005AA","StartTime":"{shared_start_time}","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-5","LogLength":4096}},
              {{"Id":"07L000000000004AA","StartTime":"{shared_start_time}","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-4","LogLength":4096}},
              {{"Id":"07L000000000003AA","StartTime":"{shared_start_time}","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-3","LogLength":4096}}
            ]}}}}"#
        ),
    );

    let second = sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: None,
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect("same-timestamp sync should succeed");

    assert_eq!(second.status, "success");
    assert_eq!(second.downloaded, 2);
    let state = read_sync_state(Some(
        workspace_root
            .to_str()
            .expect("workspace path should be utf8"),
    ))
    .expect("sync state should load");
    assert_eq!(
        state.orgs["default@example.com"]
            .last_synced_log_id
            .as_deref(),
        Some("07L000000000005AA")
    );

    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}

#[test]
fn logs_sync_smoke_propagates_list_failures() {
    let _guard = lock_env_mutex();
    let workspace_root = make_temp_workspace("list-failure");
    let fake_sf_root = make_temp_workspace("fake-sf-failure");
    let old_path = std::env::var_os("PATH");
    write_failing_fake_sf_command(&fake_sf_root, "simulated list failure");

    std::env::set_var("PATH", path_with_front(&fake_sf_root, old_path.clone()));
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::set_var("ALV_TEST_SF_ORG_DISPLAY_JSON", org_display_fixture());
    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);

    let error = sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: None,
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
        },
        &alv_core::logs::CancellationToken::new(),
    )
    .expect_err("list failures should surface as errors");

    assert!(
        error.contains("simulated list failure"),
        "expected list failure to propagate, got: {error}"
    );

    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    restore_path(old_path);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    fs::remove_dir_all(fake_sf_root).expect("fake sf dir should be removable");
}

#[test]
fn logs_sync_smoke_returns_cancelled_result_when_list_fetch_is_cancelled() {
    let _guard = lock_env_mutex();
    let workspace_root = make_temp_workspace("list-cancelled");

    std::env::set_var(
        TEST_SF_LOG_LIST_JSON_ENV,
        r#"{"result":{"records":[{"Id":"07L000000000003AA","StartTime":"2026-03-30T18:39:58.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-1","LogLength":4096}]}}"#,
    );
    std::env::set_var("ALV_TEST_SF_ORG_DISPLAY_JSON", org_display_fixture());
    std::env::set_var("ALV_TEST_LOGS_CANCEL_DELAY_MS", "250");

    let token = alv_core::logs::CancellationToken::new();
    let cancel_handle = token.clone();
    thread::spawn(move || {
        thread::sleep(std::time::Duration::from_millis(50));
        cancel_handle.cancel();
    });

    let result = sync_logs_with_cancel(
        &LogsSyncParams {
            target_org: None,
            workspace_root: Some(workspace_root.display().to_string()),
            force_full: false,
        },
        &token,
    )
    .expect("sync should return a cancelled result");

    assert_eq!(result.status, "cancelled");
    assert_eq!(result.downloaded, 0);

    std::env::remove_var("ALV_TEST_LOGS_CANCEL_DELAY_MS");
    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}
