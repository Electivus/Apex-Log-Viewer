use std::{
    fs,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use alv_app_server::server::{handle_initialize, handle_request_line};
use alv_app_server::transport_stdio::{bounded_transport_channel, TRANSPORT_QUEUE_CAPACITY};
use alv_core::logs::{TEST_APEX_LOG_FIXTURE_DIR_ENV, TEST_SF_LOG_LIST_JSON_ENV};
use alv_protocol::messages::InitializeParams;

fn test_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}

fn make_temp_dir(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("alv-app-server-{name}-{nonce}"));
    fs::create_dir_all(&dir).expect("temp dir should be created");
    dir
}

#[test]
fn app_server_smoke_reports_initialize_handshake() {
    let result = handle_initialize(InitializeParams {
        client_name: "apex-log-viewer-vscode".to_string(),
        client_version: "0.1.0".to_string(),
    });

    assert_eq!(result.runtime_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(result.protocol_version, "1");
    assert_eq!(result.platform, std::env::consts::OS);
    assert_eq!(result.arch, std::env::consts::ARCH);
    assert!(result.capabilities.orgs);
    assert!(result.capabilities.logs);
    assert!(result.capabilities.search);
    assert!(result.capabilities.tail);
    assert!(result.capabilities.debug_flags);
    assert!(result.capabilities.doctor);
    assert_eq!(result.state_dir, ".alv/state");
    assert_eq!(result.cache_dir, ".alv/cache");
}

#[test]
fn app_server_smoke_uses_bounded_transport_channel() {
    let (sender, mut receiver) = bounded_transport_channel::<usize>();

    for value in 0..TRANSPORT_QUEUE_CAPACITY {
        sender
            .try_send(value)
            .expect("queue should accept values up to configured capacity");
    }

    assert!(
        sender.try_send(TRANSPORT_QUEUE_CAPACITY).is_err(),
        "queue should reject writes past capacity"
    );
    assert_eq!(
        receiver
            .try_recv()
            .expect("receiver should have first item"),
        0
    );
}

#[test]
fn app_server_smoke_routes_logs_search_and_triage_requests() {
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

    let workspace_root = make_temp_dir("workspace");
    let apexlogs_dir = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_dir).expect("apexlogs dir should be created");
    fs::write(
        apexlogs_dir.join("default_07L000000000001AA.log"),
        "09:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|AccountService.handle\n09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n",
    )
    .expect("cached log should be writable");

    let fixture_dir = make_temp_dir("fixture");
    fs::write(
        fixture_dir.join("07L00000000000TRI.log"),
        "09:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|AccountService.handle\n09:00:01.0|EXCEPTION_THROWN|System.NullPointerException: boom\n",
    )
    .expect("fixture log should be writable");
    std::env::set_var(
        TEST_APEX_LOG_FIXTURE_DIR_ENV,
        fixture_dir.display().to_string(),
    );

    let list_response = handle_request_line(
        r#"{"jsonrpc":"2.0","id":"logs:1","method":"logs/list","params":{"limit":25,"cursor":{"beforeStartTime":"2026-03-27T12:00:00.000Z","beforeId":"07L000000000009AA"}}}"#,
    )
    .expect("logs/list request should succeed")
    .expect("logs/list should emit a response");
    assert!(list_response.contains("\"Id\":\"07L000000000001AA\""));
    assert!(list_response.contains("\"Operation\":\"ExecuteAnonymous\""));

    let search_response = handle_request_line(&format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"search:1\",\"method\":\"search/query\",\"params\":{{\"query\":\"nullpointerexception\",\"logIds\":[\"07L000000000001AA\",\"07L000000000002AA\"],\"workspaceRoot\":\"{}\"}}}}",
        workspace_root.display()
    ))
    .expect("search/query request should succeed")
    .expect("search/query should emit a response");
    assert!(search_response.contains("\"logIds\":[\"07L000000000001AA\"]"));
    assert!(search_response.contains("\"pendingLogIds\":[\"07L000000000002AA\"]"));

    let triage_response = handle_request_line(&format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"triage:1\",\"method\":\"logs/triage\",\"params\":{{\"username\":\"demo@example.com\",\"logIds\":[\"07L00000000000TRI\"],\"workspaceRoot\":\"{}\"}}}}",
        workspace_root.display()
    ))
    .expect("logs/triage request should succeed")
    .expect("logs/triage should emit a response");
    assert!(triage_response.contains("\"logId\":\"07L00000000000TRI\""));
    assert!(triage_response.contains("\"codeUnitStarted\":\"AccountService.handle\""));
    assert!(triage_response.contains("\"primaryReason\":\"Fatal exception\""));

    std::env::remove_var(TEST_SF_LOG_LIST_JSON_ENV);
    std::env::remove_var(TEST_APEX_LOG_FIXTURE_DIR_ENV);
    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}
