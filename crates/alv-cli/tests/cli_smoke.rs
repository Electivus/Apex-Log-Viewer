use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Mutex, OnceLock,
    },
    thread,
    time::Duration,
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
