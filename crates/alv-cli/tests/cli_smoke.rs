use std::{
    fs,
    io::{BufRead, BufReader, Write},
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
        let stdout = child.stdout.take().expect("child stdout should be available");
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
fn cli_smoke_prints_banner_for_standalone_invocation() {
    let output = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"))
        .output()
        .expect("cli should execute");

    assert!(output.status.success(), "cli should exit successfully");
    assert_eq!(
        String::from_utf8(output.stdout)
            .expect("stdout should be utf8")
            .trim(),
        "apex-log-viewer"
    );
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
    assert_eq!(initialize["id"], "initialize:1");
    assert_eq!(initialize["result"]["protocol_version"], "1");
    assert_eq!(initialize["result"]["channel"], "stable");
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
    let temp_dir = std::env::temp_dir().join(format!(
        "alv-cli-smoke-{}-{}",
        std::process::id(),
        unique
    ));
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
