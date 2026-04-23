use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

fn test_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}

fn lock_test_guard() -> std::sync::MutexGuard<'static, ()> {
    test_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn org_display_fixture(instance_url: &str) -> String {
    format!(
        r#"{{"result":{{"username":"default@example.com","accessToken":"token","instanceUrl":"{instance_url}"}}}}"#
    )
}

fn spawn_single_http_response(
    status: &str,
    content_type: &str,
    body: &'static [u8],
) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
    let address = listener
        .local_addr()
        .expect("test server address should be available");
    let status = status.to_string();
    let content_type = content_type.to_string();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener
            .accept()
            .expect("test server should accept request");
        let mut buffer = [0_u8; 4096];
        let _ = stream.read(&mut buffer);
        let headers = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream
            .write_all(headers.as_bytes())
            .expect("test server should write headers");
        stream
            .write_all(body)
            .expect("test server should write body");
    });
    (format!("http://{address}"), handle)
}

struct AppServerHarness {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<String>,
}

impl AppServerHarness {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("app-server process should start");

        let stdin = child.stdin.take().expect("child stdin should be available");
        let stdout = child
            .stdout
            .take()
            .expect("child stdout should be available");
        let (sender, receiver) = mpsc::channel();

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });

        Self {
            child,
            stdin,
            responses: receiver,
        }
    }

    fn send(&mut self, message: &str) {
        writeln!(self.stdin, "{message}").expect("request should be written");
        self.stdin.flush().expect("request should be flushed");
    }

    fn recv_json(&self) -> Value {
        let line = self
            .responses
            .recv_timeout(Duration::from_secs(5))
            .expect("response should arrive before timeout");
        serde_json::from_str(&line).expect("response should be valid json")
    }

    fn request_json(&mut self, message: &str) -> (Value, Duration) {
        let started = Instant::now();
        self.send(message);
        (self.recv_json(), started.elapsed())
    }
}

impl Drop for AppServerHarness {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

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
}

#[test]
fn cli_smoke_shows_target_org_in_sync_help() {
    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .args(["logs", "sync", "--help"])
        .output()
        .expect("help should execute");

    assert!(output.status.success(), "help should exit successfully");
    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("--target-org"));
    assert!(stdout.contains("--force-full"));
    assert!(stdout.contains("--concurrency"));
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
        .args(["logs", "sync", "--json", "--concurrency", "3"])
        .output()
        .expect("sync should execute");

    assert!(output.status.success(), "sync should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["status"], "success");
    assert_eq!(json["target_org"], "default@example.com");
    assert_eq!(json["downloaded"], 1);
    assert!(workspace_root
        .join("apexlogs")
        .join(".alv")
        .join("sync-state.json")
        .is_file());

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}

#[test]
fn cli_smoke_logs_sync_failure_prints_http_details() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-sync-failure-{unique}"));
    fs::create_dir_all(&workspace_root).expect("workspace should exist");
    let (base_url, server_handle) = spawn_single_http_response(
        "500 Internal Server Error",
        "text/plain",
        b"simulated list failure",
    );

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .env(
            "ALV_TEST_SF_ORG_DISPLAY_JSON",
            org_display_fixture(&base_url),
        )
        .args(["logs", "sync"])
        .output()
        .expect("sync should execute");

    assert!(!output.status.success(), "sync should fail");
    let stderr = String::from_utf8(output.stderr).expect("stderr should be utf8");
    assert!(
        stderr.contains("HTTP 500 Internal Server Error"),
        "expected HTTP message, got: {stderr}"
    );
    assert!(
        stderr.contains("HTTP status: 500"),
        "expected status detail, got: {stderr}"
    );
    assert!(
        stderr.contains("URL:"),
        "expected URL detail, got: {stderr}"
    );
    assert!(
        stderr.contains("/services/data/") && stderr.contains("/tooling/query"),
        "expected tooling query URL, got: {stderr}"
    );
    assert!(
        stderr.contains("Response body:") && stderr.contains("simulated list failure"),
        "expected response body detail, got: {stderr}"
    );

    server_handle.join().expect("server thread should complete");
    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_logs_sync_json_failure_prints_error_data() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-sync-json-failure-{unique}"));
    fs::create_dir_all(&workspace_root).expect("workspace should exist");
    let (base_url, server_handle) = spawn_single_http_response(
        "503 Service Unavailable",
        "application/json",
        br#"{"message":"temporary Salesforce failure"}"#,
    );

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .env(
            "ALV_TEST_SF_ORG_DISPLAY_JSON",
            org_display_fixture(&base_url),
        )
        .args(["logs", "sync", "--json"])
        .output()
        .expect("sync should execute");

    assert!(!output.status.success(), "sync should fail");
    let stderr_json: Value =
        serde_json::from_slice(&output.stderr).expect("stderr should be valid json");
    assert_eq!(stderr_json["status"], "error");
    assert_eq!(stderr_json["data"]["status"], 503);
    assert!(
        stderr_json["data"]["url"]
            .as_str()
            .is_some_and(|value| value.contains("/tooling/query")),
        "expected tooling query URL, got: {stderr_json}"
    );
    assert_eq!(
        stderr_json["data"]["responseBody"],
        r#"{"message":"temporary Salesforce failure"}"#
    );

    server_handle.join().expect("server thread should complete");
    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
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
        .args([
            "logs",
            "status",
            "--json",
            "--target-org",
            "default@example.com",
        ])
        .output()
        .expect("status should execute");

    assert!(output.status.success(), "status should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["target_org"], "default@example.com");
    assert_eq!(json["last_synced_log_id"], "07L000000000003AA");

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_logs_status_json_prefers_explicit_target_org_over_cached_default() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-status-target-{unique}"));
    let state_dir = workspace_root.join("apexlogs").join(".alv");
    fs::create_dir_all(&state_dir).expect("state dir should exist");
    fs::write(
        state_dir.join("sync-state.json"),
        r#"{"version":1,"orgs":{"default@example.com":{"targetOrg":"default@example.com","safeTargetOrg":"default@example.com","orgDir":"apexlogs/orgs/default@example.com","lastSyncStartedAt":"2026-03-30T18:40:00.000Z","lastSyncCompletedAt":"2026-03-30T18:40:04.000Z","lastSyncedLogId":"07L000000000003AA","lastSyncedStartTime":"2026-03-30T18:39:58.000Z","downloadedCount":3,"cachedCount":12,"lastError":null}}}"#,
    )
    .expect("sync state should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .args(["logs", "status", "--json", "--target-org", "ALV_ALIAS"])
        .output()
        .expect("status should execute");

    assert!(output.status.success(), "status should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["target_org"], "ALV_ALIAS");
    assert_eq!(json["has_state"], false);

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_logs_status_json_prefers_synced_metadata_when_alias_matches_multiple_orgs() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root =
        std::env::temp_dir().join(format!("alv-cli-status-duplicate-alias-{unique}"));
    let state_dir = workspace_root.join("apexlogs").join(".alv");
    let older_org_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("aaa@example.com");
    let synced_org_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("zzz@example.com");
    fs::create_dir_all(&state_dir).expect("state dir should exist");
    fs::create_dir_all(older_org_dir.join("logs").join("2026-03-30"))
        .expect("older org log dir should exist");
    fs::create_dir_all(synced_org_dir.join("logs").join("2026-03-30"))
        .expect("synced org log dir should exist");
    fs::write(
        state_dir.join("sync-state.json"),
        r#"{"version":1,"orgs":{"zzz@example.com":{"targetOrg":"zzz@example.com","safeTargetOrg":"zzz@example.com","orgDir":"apexlogs/orgs/zzz@example.com","lastSyncStartedAt":"2026-03-30T18:40:00.000Z","lastSyncCompletedAt":"2026-03-30T18:40:04.000Z","lastSyncedLogId":"07L000000000009AA","lastSyncedStartTime":"2026-03-30T18:39:58.000Z","downloadedCount":1,"cachedCount":0,"lastError":null}}}"#,
    )
    .expect("sync state should be writable");
    fs::write(
        older_org_dir.join("org.json"),
        r#"{"targetOrg":"ALV_ALIAS","safeTargetOrg":"ALV_ALIAS","resolvedUsername":"aaa@example.com","alias":"ALV_ALIAS","instanceUrl":"https://aaa.example.com","updatedAt":"2026-03-30T18:40:00.000Z"}"#,
    )
    .expect("older org metadata should be writable");
    fs::write(
        synced_org_dir.join("org.json"),
        r#"{"targetOrg":"ALV_ALIAS","safeTargetOrg":"ALV_ALIAS","resolvedUsername":"zzz@example.com","alias":"ALV_ALIAS","instanceUrl":"https://zzz.example.com","updatedAt":"2026-03-31T12:00:00.000Z"}"#,
    )
    .expect("synced org metadata should be writable");
    fs::write(
        older_org_dir
            .join("logs")
            .join("2026-03-30")
            .join("07L000000000010AA.log"),
        "older org log\n",
    )
    .expect("older org log should be writable");
    fs::write(
        synced_org_dir
            .join("logs")
            .join("2026-03-30")
            .join("07L000000000009AA.log"),
        "synced org log\n",
    )
    .expect("synced org log should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .args(["logs", "status", "--json", "--target-org", "ALV_ALIAS"])
        .output()
        .expect("status should execute");

    assert!(output.status.success(), "status should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["target_org"], "zzz@example.com");
    assert_eq!(json["last_synced_log_id"], "07L000000000009AA");
    assert_eq!(json["log_count"], 1);

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

#[test]
fn cli_smoke_logs_search_json_keeps_alias_scoped_legacy_logs() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-search-legacy-alias-{unique}"));
    let apexlogs_root = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_root).expect("apexlogs dir should exist");
    fs::write(
        apexlogs_root.join("ALV_ALIAS_07L000000000005AA.log"),
        "09:00:00.0|FATAL_ERROR|System.NullPointerException\n",
    )
    .expect("legacy alias-scoped log should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .env(
            "ALV_TEST_SF_ORG_DISPLAY_JSON",
            r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#,
        )
        .args([
            "logs",
            "search",
            "NullPointerException",
            "--json",
            "--target-org",
            "ALV_ALIAS",
        ])
        .output()
        .expect("search should execute");

    assert!(output.status.success(), "search should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["target_org"], "default@example.com");
    assert_eq!(json["matches"][0]["log_id"], "07L000000000005AA");

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_logs_search_json_resolves_alias_without_local_metadata() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-search-alias-{unique}"));
    let log_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&log_dir).expect("log dir should exist");
    fs::write(
        log_dir.join("07L000000000004AA.log"),
        "09:00:00.0|FATAL_ERROR|System.NullPointerException\n",
    )
    .expect("cached log should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .env(
            "ALV_TEST_SF_ORG_DISPLAY_JSON",
            r#"{"result":{"username":"default@example.com","accessToken":"token","instanceUrl":"https://default.example.com"}}"#,
        )
        .args([
            "logs",
            "search",
            "NullPointerException",
            "--json",
            "--target-org",
            "ALV_ALIAS",
        ])
        .output()
        .expect("search should execute");

    assert!(output.status.success(), "search should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["target_org"], "default@example.com");
    assert_eq!(json["matches"][0]["log_id"], "07L000000000004AA");

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_logs_search_json_uses_local_alias_resolution_without_auth() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-search-local-alias-{unique}"));
    let org_root = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com");
    let log_dir = org_root.join("logs").join("2026-03-30");
    fs::create_dir_all(&log_dir).expect("log dir should exist");
    fs::write(
        log_dir.join("07L000000000006AA.log"),
        "09:00:00.0|FATAL_ERROR|System.NullPointerException\n",
    )
    .expect("cached log should be writable");
    fs::write(
        org_root.join("org.json"),
        r#"{"targetOrg":"ALV_ALIAS","safeTargetOrg":"ALV_ALIAS","resolvedUsername":"default@example.com","alias":"ALV_ALIAS","instanceUrl":"https://default.example.com","updatedAt":"2026-03-31T12:00:00.000Z"}"#,
    )
    .expect("org metadata should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .args([
            "logs",
            "search",
            "NullPointerException",
            "--json",
            "--target-org",
            "ALV_ALIAS",
        ])
        .output()
        .expect("search should execute");

    assert!(output.status.success(), "search should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["target_org"], "default@example.com");
    assert_eq!(json["matches"][0]["log_id"], "07L000000000006AA");

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_logs_search_json_falls_back_to_alias_cache_without_auth_or_metadata() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root =
        std::env::temp_dir().join(format!("alv-cli-search-alias-offline-{unique}"));
    let apexlogs_root = workspace_root.join("apexlogs");
    fs::create_dir_all(&apexlogs_root).expect("apexlogs dir should exist");
    fs::write(
        apexlogs_root.join("ALV_ALIAS_07L000000000007AA.log"),
        "09:00:00.0|FATAL_ERROR|AliasOfflineNeedle\n",
    )
    .expect("legacy alias-scoped log should be writable");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .args([
            "logs",
            "search",
            "AliasOfflineNeedle",
            "--json",
            "--target-org",
            "ALV_ALIAS",
        ])
        .output()
        .expect("search should execute");

    assert!(output.status.success(), "search should exit successfully");
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["target_org"], "ALV_ALIAS");
    assert_eq!(json["matches"][0]["log_id"], "07L000000000007AA");

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_logs_search_rejects_empty_query() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-search-empty-{unique}"));
    fs::create_dir_all(&workspace_root).expect("workspace should exist");

    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .current_dir(&workspace_root)
        .args(["logs", "search", "   "])
        .output()
        .expect("search should execute");

    assert!(
        !output.status.success(),
        "search should fail for an empty query"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("search query must not be empty"),
        "stderr should explain the validation failure"
    );

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_routes_initialize_and_logs_list_over_stdio() {
    let _guard = lock_test_guard();

    std::env::set_var(
        "ALV_TEST_SF_LOG_LIST_JSON",
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

    let mut harness = AppServerHarness::spawn();
    harness.send(
        r#"{"jsonrpc":"2.0","id":"initialize:1","method":"initialize","params":{"client_name":"cli-smoke","client_version":"0.1.0"}}"#,
    );
    let initialize = harness.recv_json();
    let runtime_version = initialize["result"]["runtime_version"]
        .as_str()
        .expect("initialize result should include runtime_version");
    let cli_version = initialize["result"]["cli_version"]
        .as_str()
        .expect("initialize result should include cli_version");
    assert_eq!(runtime_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(cli_version, env!("CARGO_PKG_VERSION"));
    let expected_channel = if cli_version.contains('-') {
        "pre-release"
    } else {
        "stable"
    };
    assert_eq!(initialize["id"], "initialize:1");
    assert_eq!(initialize["result"]["protocol_version"], "1");
    assert_eq!(initialize["result"]["channel"], expected_channel);
    assert_eq!(initialize["result"]["capabilities"]["logs"], true);

    harness.send(r#"{"jsonrpc":"2.0","id":"logs:1","method":"logs/list","params":{"limit":1}}"#);
    let logs = harness.recv_json();
    assert_eq!(logs["id"], "logs:1");
    assert_eq!(logs["result"][0]["Id"], "07L000000000001AA");
    assert_eq!(logs["result"][0]["Operation"], "ExecuteAnonymous");

    std::env::remove_var("ALV_TEST_SF_LOG_LIST_JSON");
    drop(harness);
}

#[test]
fn cli_smoke_routes_org_endpoints_over_stdio_with_fast_fixture_round_trips() {
    let _guard = lock_test_guard();

    std::env::set_var(
        "ALV_TEST_SF_ORG_LIST_JSON",
        r#"{
          "result": {
            "nonScratchOrgs": [
              {
                "username": "default@example.com",
                "alias": "Default",
                "isDefaultUsername": true,
                "instanceUrl": "https://default.example.com"
              }
            ]
          }
        }"#,
    );
    std::env::set_var(
        "ALV_TEST_SF_ORG_DISPLAY_JSON",
        r#"{
          "result": {
            "username": "default@example.com",
            "accessToken": "token",
            "instanceUrl": "https://default.example.com"
          }
        }"#,
    );

    let mut harness = AppServerHarness::spawn();
    let (initialize, initialize_elapsed) = harness.request_json(
        r#"{"jsonrpc":"2.0","id":"initialize:orgs","method":"initialize","params":{"client_name":"cli-smoke","client_version":"0.1.0"}}"#,
    );
    assert_eq!(initialize["id"], "initialize:orgs");
    assert_eq!(initialize["result"]["capabilities"]["orgs"], true);

    let (orgs, org_list_elapsed) = harness.request_json(
        r#"{"jsonrpc":"2.0","id":"orgs:1","method":"org/list","params":{"forceRefresh":true}}"#,
    );
    assert_eq!(orgs["id"], "orgs:1");
    assert_eq!(orgs["result"][0]["username"], "default@example.com");
    assert_eq!(orgs["result"][0]["alias"], "Default");

    let (auth, org_auth_elapsed) = harness.request_json(
        r#"{"jsonrpc":"2.0","id":"auth:1","method":"org/auth","params":{"username":"default@example.com"}}"#,
    );
    assert_eq!(auth["id"], "auth:1");
    assert_eq!(auth["result"]["username"], "default@example.com");
    assert_eq!(auth["result"]["accessToken"], "token");
    assert_eq!(auth["result"]["instanceUrl"], "https://default.example.com");

    let budget = Duration::from_secs(2);
    assert!(
        initialize_elapsed < budget,
        "initialize round-trip should stay under {:?}, got {:?}",
        budget,
        initialize_elapsed
    );
    assert!(
        org_list_elapsed < budget,
        "org/list round-trip should stay under {:?}, got {:?}",
        budget,
        org_list_elapsed
    );
    assert!(
        org_auth_elapsed < budget,
        "org/auth round-trip should stay under {:?}, got {:?}",
        budget,
        org_auth_elapsed
    );

    std::env::remove_var("ALV_TEST_SF_ORG_LIST_JSON");
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    drop(harness);
}

#[cfg(windows)]
#[test]
fn cli_smoke_uses_explicit_sf_cmd_shim_for_org_endpoints() {
    let _guard = lock_test_guard();

    std::env::remove_var("ALV_TEST_SF_ORG_LIST_JSON");
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let temp_dir =
        std::env::temp_dir().join(format!("alv-cli-smoke-{}-{}", std::process::id(), unique));
    fs::create_dir_all(&temp_dir).expect("temp dir should be created");
    let sf_cmd = temp_dir.join("sf.cmd");
    fs::write(
        &sf_cmd,
        r#"@echo off
if /I "%*"=="org list --json --skip-connection-status" (
  echo {"result":{"nonScratchOrgs":[{"username":"shim@example.com","alias":"Shim","isDefaultUsername":true,"instanceUrl":"https://shim.example.com"}]}}
  exit /b 0
)
if /I "%*"=="org display --json --verbose -o shim@example.com" (
  echo {"status":0,"result":{"username":"shim@example.com","accessToken":"shim-token","instanceUrl":"https://shim.example.com"}}
  exit /b 0
)
echo Unexpected sf args: %* 1>&2
exit /b 1
"#,
    )
    .expect("sf shim should be written");

    std::env::set_var("ALV_SF_BIN_PATH", &sf_cmd);

    let mut harness = AppServerHarness::spawn();
    let (initialize, initialize_elapsed) = harness.request_json(
        r#"{"jsonrpc":"2.0","id":"initialize:shim","method":"initialize","params":{"client_name":"cli-smoke","client_version":"0.1.0"}}"#,
    );
    assert_eq!(initialize["id"], "initialize:shim");

    let (orgs, org_list_elapsed) = harness.request_json(
        r#"{"jsonrpc":"2.0","id":"orgs:shim","method":"org/list","params":{"forceRefresh":true}}"#,
    );
    assert_eq!(orgs["result"][0]["username"], "shim@example.com");
    assert_eq!(orgs["result"][0]["alias"], "Shim");

    let (auth, org_auth_elapsed) = harness.request_json(
        r#"{"jsonrpc":"2.0","id":"auth:shim","method":"org/auth","params":{"username":"shim@example.com"}}"#,
    );
    assert_eq!(auth["result"]["username"], "shim@example.com");
    assert_eq!(auth["result"]["accessToken"], "shim-token");
    assert_eq!(auth["result"]["instanceUrl"], "https://shim.example.com");

    let budget = Duration::from_secs(3);
    assert!(
        initialize_elapsed < budget,
        "initialize round-trip should stay under {:?}, got {:?}",
        budget,
        initialize_elapsed
    );
    assert!(
        org_list_elapsed < budget,
        "org/list via sf.cmd shim should stay under {:?}, got {:?}",
        budget,
        org_list_elapsed
    );
    assert!(
        org_auth_elapsed < budget,
        "org/auth via sf.cmd shim should stay under {:?}, got {:?}",
        budget,
        org_auth_elapsed
    );

    drop(harness);
    std::env::remove_var("ALV_SF_BIN_PATH");
    fs::remove_dir_all(&temp_dir).expect("temp dir should be removable");
}

#[cfg(windows)]
#[test]
fn cli_smoke_logs_list_does_not_keep_sf_cmd_stdin_open() {
    let _guard = lock_test_guard();

    std::env::remove_var("ALV_TEST_SF_LOG_LIST_JSON");

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let temp_dir = std::env::temp_dir().join(format!(
        "alv-cli-logs-stdin-{}-{}",
        std::process::id(),
        unique
    ));
    fs::create_dir_all(&temp_dir).expect("temp dir should be created");
    let sf_cmd = temp_dir.join("sf.cmd");
    fs::write(
        &sf_cmd,
        r#"@echo off
more >nul
echo {"result":{"records":[{"Id":"07L000000000001AA","StartTime":"2026-03-27T12:00:00.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-1","LogLength":4096}]}}
"#,
    )
    .expect("sf shim should be written");

    std::env::set_var("ALV_SF_BIN_PATH", &sf_cmd);

    let mut harness = AppServerHarness::spawn();
    let (logs, elapsed) = harness.request_json(
        r#"{"jsonrpc":"2.0","id":"logs:stdin","method":"logs/list","params":{"limit":1,"username":"shim@example.com"}}"#,
    );
    assert_eq!(logs["id"], "logs:stdin");
    assert_eq!(logs["result"][0]["Id"], "07L000000000001AA");

    let budget = Duration::from_secs(3);
    assert!(
        elapsed < budget,
        "logs/list via sf.cmd shim should not wait on inherited stdin longer than {:?}, got {:?}",
        budget,
        elapsed
    );

    drop(harness);
    std::env::remove_var("ALV_SF_BIN_PATH");
    fs::remove_dir_all(&temp_dir).expect("temp dir should be removable");
}

#[test]
fn cli_smoke_cancels_in_flight_request_and_keeps_serving_next_response() {
    let _guard = lock_test_guard();

    std::env::set_var(
        "ALV_TEST_SF_LOG_LIST_JSON",
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
    std::env::set_var("ALV_TEST_LOGS_CANCEL_DELAY_MS", "400");

    let mut harness = AppServerHarness::spawn();
    harness.send(
        r#"{"jsonrpc":"2.0","id":"logs:cancel-me","method":"logs/list","params":{"limit":1}}"#,
    );
    thread::sleep(Duration::from_millis(50));
    harness.send(r#"{"jsonrpc":"2.0","method":"cancel","params":{"requestId":"logs:cancel-me"}}"#);
    harness.send(
        r#"{"jsonrpc":"2.0","id":"init:1","method":"initialize","params":{"client_name":"cli-smoke","client_version":"0.1.0"}}"#,
    );

    let follow_up = harness.recv_json();
    assert_eq!(follow_up["id"], "init:1");
    assert_eq!(follow_up["result"]["protocol_version"], "1");

    std::env::remove_var("ALV_TEST_LOGS_CANCEL_DELAY_MS");
    std::env::remove_var("ALV_TEST_SF_LOG_LIST_JSON");
    drop(harness);
}
