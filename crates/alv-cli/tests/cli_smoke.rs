use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    net::TcpListener,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

const PROXY_ENV_VARS: &[&str] = &[
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
];

fn test_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}

fn lock_test_guard() -> std::sync::MutexGuard<'static, ()> {
    test_guard()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct EnvVarRestore {
    key: &'static str,
    value: Option<OsString>,
}

impl EnvVarRestore {
    fn capture(key: &'static str) -> Self {
        Self {
            key,
            value: std::env::var_os(key),
        }
    }
}

impl Drop for EnvVarRestore {
    fn drop(&mut self) {
        match self.value.as_ref() {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

fn isolate_salesforce_home(root: &std::path::Path) -> Vec<EnvVarRestore> {
    let home = root.join("home");
    fs::create_dir_all(home.join(".sf")).expect("isolated .sf dir should be created");
    fs::create_dir_all(home.join(".sfdx")).expect("isolated .sfdx dir should be created");
    let guards = vec![
        EnvVarRestore::capture("HOME"),
        EnvVarRestore::capture("USERPROFILE"),
    ];
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    guards
}

fn org_display_fixture(instance_url: &str) -> String {
    format!(
        r#"{{"result":{{"username":"default@example.com","accessToken":"token","instanceUrl":"{instance_url}"}}}}"#
    )
}

fn apex_log_viewer_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_apex-log-viewer"));
    for key in PROXY_ENV_VARS {
        command.env_remove(key);
    }
    command.env("NO_PROXY", "127.0.0.1,localhost");
    command.env("no_proxy", "127.0.0.1,localhost");
    command
}

fn spawn_single_http_response(
    status: &str,
    content_type: &str,
    body: &'static [u8],
) -> (String, thread::JoinHandle<()>) {
    spawn_http_responses(vec![(
        status.to_string(),
        content_type.to_string(),
        body.to_vec(),
    )])
}

fn spawn_http_responses(
    responses: Vec<(String, String, Vec<u8>)>,
) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
    let address = listener
        .local_addr()
        .expect("test server address should be available");
    let handle = thread::spawn(move || {
        listener
            .set_nonblocking(true)
            .expect("test server should become nonblocking");
        for (status, content_type, body) in responses {
            let deadline = Instant::now() + Duration::from_secs(30);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "test server timed out waiting for request"
                        );
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("test server accept failed: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .expect("test server should set read timeout");
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
                .write_all(&body)
                .expect("test server should write body");
        }
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
        let mut child = apex_log_viewer_command()
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
    let output = apex_log_viewer_command()
        .output()
        .expect("help should execute");

    assert!(output.status.success(), "help should exit successfully");
    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("Local-first Apex log sync and analysis CLI"));
    assert!(stdout.contains("logs"));
    assert!(stdout.contains("app-server"));
}

#[test]
fn cli_smoke_shows_agent_friendly_root_commands_in_help() {
    let output = apex_log_viewer_command()
        .args(["--help"])
        .output()
        .expect("help should execute");

    assert!(output.status.success(), "help should exit successfully");
    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("doctor"));
    assert!(stdout.contains("orgs"));
    assert!(stdout.contains("users"));
    assert!(stdout.contains("trace-flags"));
    assert!(stdout.contains("debug-levels"));
    assert!(stdout.contains("tooling"));
    assert!(stdout.contains("skills"));
}

#[test]
fn cli_smoke_shows_skills_install_help() {
    let output = apex_log_viewer_command()
        .args(["skills", "install", "--help"])
        .output()
        .expect("help should execute");

    assert!(output.status.success(), "help should exit successfully");
    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("--codex-home"));
    assert!(stdout.contains("--force"));
    assert!(stdout.contains("--dry-run"));
}

#[test]
fn cli_smoke_skills_install_json_writes_bundled_skill() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("alv-cli-skill-install-{unique}"));
    let codex_home = root.join("codex-home");
    fs::create_dir_all(&root).expect("temp root should exist");
    let codex_home_arg = codex_home.display().to_string();

    let output = apex_log_viewer_command()
        .args([
            "--json",
            "skills",
            "install",
            "--codex-home",
            &codex_home_arg,
        ])
        .output()
        .expect("skill install should execute");

    assert!(
        output.status.success(),
        "skill install should succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: Value = serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(json["status"], "installed");
    assert_eq!(json["skill_name"], "apex-log-viewer-cli");
    let skill_dir = codex_home.join("skills").join("apex-log-viewer-cli");
    let skill_md =
        fs::read_to_string(skill_dir.join("SKILL.md")).expect("skill should be installed");
    assert!(skill_md.contains("name: apex-log-viewer-cli"));
    let openai_yaml = fs::read_to_string(skill_dir.join("agents").join("openai.yaml"))
        .expect("openai metadata should be installed");
    assert!(openai_yaml.contains("Use $apex-log-viewer-cli"));

    fs::remove_dir_all(root).expect("temp root should be removable");
}

#[test]
fn cli_smoke_skills_install_refuses_to_replace_without_force() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("alv-cli-skill-replace-{unique}"));
    let codex_home = root.join("codex-home");
    let skill_dir = codex_home.join("skills").join("apex-log-viewer-cli");
    fs::create_dir_all(&skill_dir).expect("existing skill dir should exist");
    fs::write(skill_dir.join("SKILL.md"), "custom skill").expect("custom skill should be writable");
    let codex_home_arg = codex_home.display().to_string();

    let output = apex_log_viewer_command()
        .args([
            "--json",
            "skills",
            "install",
            "--codex-home",
            &codex_home_arg,
        ])
        .output()
        .expect("skill install should execute");

    assert!(
        !output.status.success(),
        "skill install should fail without --force"
    );
    let stderr_json: Value =
        serde_json::from_slice(&output.stderr).expect("stderr should be valid json");
    assert_eq!(stderr_json["status"], "error");
    assert_eq!(stderr_json["code"], "command_failed");
    assert!(
        stderr_json["message"]
            .as_str()
            .is_some_and(|value| value.contains("--force")),
        "expected force guidance, got: {stderr_json}"
    );
    assert_eq!(
        fs::read_to_string(skill_dir.join("SKILL.md")).expect("custom skill should remain"),
        "custom skill"
    );

    fs::remove_dir_all(root).expect("temp root should be removable");
}

#[test]
fn cli_smoke_shows_logs_subcommands_in_help() {
    let output = apex_log_viewer_command()
        .args(["logs", "--help"])
        .output()
        .expect("help should execute");

    assert!(output.status.success(), "help should exit successfully");
    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    assert!(stdout.contains("sync"));
    assert!(stdout.contains("status"));
    assert!(stdout.contains("search"));
    assert!(stdout.contains("read"));
    assert!(stdout.contains("resolve"));
    assert!(stdout.contains("triage"));
    assert!(stdout.contains("delete"));
    assert!(!stdout.contains("index"));
}

#[test]
fn cli_smoke_accepts_global_json_before_logs_status() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-global-json-status-{unique}"));
    fs::create_dir_all(&workspace_root).expect("workspace should exist");

    let output = apex_log_viewer_command()
        .current_dir(&workspace_root)
        .args(["--json", "logs", "status"])
        .output()
        .expect("status should execute");

    assert!(output.status.success(), "status should exit successfully");
    let stdout_json: Value =
        serde_json::from_slice(&output.stdout).expect("stdout should be valid json");
    assert_eq!(stdout_json["has_state"], false);
    assert_eq!(stdout_json["target_org"], "default");

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_logs_delete_json_requires_confirmation() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root = std::env::temp_dir().join(format!("alv-cli-delete-confirmation-{unique}"));
    fs::create_dir_all(&workspace_root).expect("workspace should exist");

    let output = apex_log_viewer_command()
        .current_dir(&workspace_root)
        .args([
            "--json",
            "logs",
            "delete",
            "--target-org",
            "example@example.com",
            "--ids",
            "07L000000000001AAA",
        ])
        .output()
        .expect("delete should execute");

    assert!(
        !output.status.success(),
        "delete should fail without --yes or --dry-run"
    );
    let stderr_json: Value =
        serde_json::from_slice(&output.stderr).expect("stderr should be valid json");
    assert_eq!(stderr_json["status"], "error");
    assert_eq!(stderr_json["code"], "command_failed");
    assert!(
        stderr_json["message"]
            .as_str()
            .is_some_and(|value| value.contains("--yes")),
        "expected confirmation guidance, got: {stderr_json}"
    );

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
}

#[test]
fn cli_smoke_shows_target_org_in_sync_help() {
    let output = apex_log_viewer_command()
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
fn cli_smoke_logs_sync_json_omits_index_fields() {
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

    let output = apex_log_viewer_command()
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
    let removed_fields = [
        format!("{}{}", "index", "ed"),
        format!("{}_{}", "index", "file"),
        format!("{}_{}", "index", "error"),
    ];
    for field in removed_fields {
        assert!(
            json.get(&field).is_none(),
            "sync JSON should not expose {field}"
        );
    }
    assert!(workspace_root
        .join("apexlogs")
        .join(".alv")
        .join("sync-state.json")
        .is_file());
    assert!(!workspace_root
        .join("apexlogs")
        .join(".alv")
        .join("log-index.sqlite")
        .exists());

    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
    fs::remove_dir_all(fixture_dir).expect("fixture dir should be removable");
}

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

    let output = apex_log_viewer_command()
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

    let output = apex_log_viewer_command()
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

    let output = apex_log_viewer_command()
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

    let output = apex_log_viewer_command()
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

    let output = apex_log_viewer_command()
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

    let output = apex_log_viewer_command()
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

    let output = apex_log_viewer_command()
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

    let output = apex_log_viewer_command()
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
fn cli_smoke_logs_search_json_uses_alias_org_first_cache_without_auth_or_metadata() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root =
        std::env::temp_dir().join(format!("alv-cli-search-alias-offline-{unique}"));
    let log_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("ALV_ALIAS")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&log_dir).expect("log dir should exist");
    fs::write(
        log_dir.join("07L000000000007AA.log"),
        "09:00:00.0|FATAL_ERROR|AliasOfflineNeedle\n",
    )
    .expect("alias-scoped log should be writable");

    let output = apex_log_viewer_command()
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

    let output = apex_log_viewer_command()
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

#[test]
fn cli_smoke_routes_agent_friendly_app_server_methods_over_stdio() {
    let _guard = lock_test_guard();

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    let workspace_root =
        std::env::temp_dir().join(format!("alv-app-server-agent-methods-{unique}"));
    let cached_log = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com")
        .join("logs")
        .join("unknown-date")
        .join("07L000000000001AAA.log");
    fs::create_dir_all(
        cached_log
            .parent()
            .expect("cached log should have a parent"),
    )
    .expect("cache dir should exist");
    fs::write(&cached_log, "09:00:00.0|USER_DEBUG|hello from cache\n")
        .expect("cached log should be writable");

    let (instance_url, server_handle) = spawn_http_responses(vec![
        (
            "200 OK".to_string(),
            "application/json".to_string(),
            br#"{"records":[{"Id":"005000000000001AAA","Name":"Ada Lovelace","Username":"ada@example.com","IsActive":true}],"done":true,"totalSize":1}"#.to_vec(),
        ),
        (
            "200 OK".to_string(),
            "application/json".to_string(),
            br#"{"records":[{"Id":"7dl000000000001AAA","DeveloperName":"ALV_DEBUG","MasterLabel":"ALV_DEBUG","Language":"None","Workflow":"INFO","Validation":"INFO","Callout":"INFO","ApexCode":"DEBUG","ApexProfiling":"INFO","Visualforce":"INFO","System":"DEBUG","Database":"INFO","Wave":"INFO","Nba":"INFO","DataAccess":"INFO"}],"done":true,"totalSize":1}"#.to_vec(),
        ),
        (
            "200 OK".to_string(),
            "application/json".to_string(),
            br#"{"records":[{"Id":"7dl000000000001AAA","DeveloperName":"ALV_DEBUG","MasterLabel":"ALV_DEBUG","Language":"None","Workflow":"INFO","Validation":"INFO","Callout":"INFO","ApexCode":"DEBUG","ApexProfiling":"INFO","Visualforce":"INFO","System":"DEBUG","Database":"INFO","Wave":"INFO","Nba":"INFO","DataAccess":"INFO"}],"done":true,"totalSize":1}"#.to_vec(),
        ),
        (
            "200 OK".to_string(),
            "application/json".to_string(),
            br#"{"records":[{"Id":"01p000000000001AAA"}],"done":true,"totalSize":1}"#.to_vec(),
        ),
        (
            "200 OK".to_string(),
            "application/json".to_string(),
            br#"{"ok":true}"#.to_vec(),
        ),
        (
            "200 OK".to_string(),
            "application/json".to_string(),
            br#"{"records":[{"Id":"005000000000001AAA"}],"done":true,"totalSize":1}"#.to_vec(),
        ),
        (
            "200 OK".to_string(),
            "application/json".to_string(),
            br#"{"records":[],"done":true,"totalSize":0}"#.to_vec(),
        ),
    ]);

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
        org_display_fixture(&instance_url),
    );

    let workspace_root_string = workspace_root.display().to_string();
    let mut harness = AppServerHarness::spawn();

    let (doctor, _) = harness
        .request_json(r#"{"jsonrpc":"2.0","id":"doctor:1","method":"doctor/run","params":{}}"#);
    assert_eq!(doctor["id"], "doctor:1");
    assert!(doctor["result"]["runtimeVersion"].is_string());

    let org_resolve = json!({
        "jsonrpc": "2.0",
        "id": "org:resolve",
        "method": "org/resolve",
        "params": { "targetOrg": "Default" }
    })
    .to_string();
    let (resolved, _) = harness.request_json(&org_resolve);
    assert_eq!(resolved["result"]["username"], "default@example.com");
    assert_eq!(resolved["result"]["alias"], "Default");

    let logs_resolve = json!({
        "jsonrpc": "2.0",
        "id": "logs:resolve",
        "method": "logs/resolve",
        "params": {
            "logId": "07L000000000001AAA",
            "targetOrg": "default@example.com",
            "workspaceRoot": workspace_root_string
        }
    })
    .to_string();
    let (resolved_log, _) = harness.request_json(&logs_resolve);
    assert_eq!(resolved_log["result"]["cached"], true);

    let logs_read = json!({
        "jsonrpc": "2.0",
        "id": "logs:read",
        "method": "logs/read",
        "params": {
            "logId": "07L000000000001AAA",
            "targetOrg": "default@example.com",
            "workspaceRoot": workspace_root.display().to_string()
        }
    })
    .to_string();
    let (read_log, _) = harness.request_json(&logs_read);
    assert_eq!(
        read_log["result"]["body"],
        "09:00:00.0|USER_DEBUG|hello from cache\n"
    );

    let logs_delete = json!({
        "jsonrpc": "2.0",
        "id": "logs:delete",
        "method": "logs/delete",
        "params": {
            "targetOrg": "default@example.com",
            "ids": ["07L000000000001AAA"],
            "dryRun": true
        }
    })
    .to_string();
    let (delete_preview, _) = harness.request_json(&logs_delete);
    assert_eq!(delete_preview["result"]["dryRun"], true);
    assert_eq!(delete_preview["result"]["total"], 1);

    let users_search = json!({
        "jsonrpc": "2.0",
        "id": "users:search",
        "method": "users/search",
        "params": { "targetOrg": "default@example.com", "query": "Ada", "limit": 10 }
    })
    .to_string();
    let (users, _) = harness.request_json(&users_search);
    assert_eq!(
        users["result"]["users"][0]["username"], "ada@example.com",
        "expected users/search result, got: {users}"
    );

    let debug_levels_list = json!({
        "jsonrpc": "2.0",
        "id": "debug:list",
        "method": "debugLevels/list",
        "params": { "targetOrg": "default@example.com" }
    })
    .to_string();
    let (debug_levels, _) = harness.request_json(&debug_levels_list);
    assert_eq!(debug_levels["result"][0]["developerName"], "ALV_DEBUG");

    let debug_levels_get = json!({
        "jsonrpc": "2.0",
        "id": "debug:get",
        "method": "debugLevels/get",
        "params": { "targetOrg": "default@example.com", "developerName": "ALV_DEBUG" }
    })
    .to_string();
    let (debug_level, _) = harness.request_json(&debug_levels_get);
    assert_eq!(debug_level["result"]["id"], "7dl000000000001AAA");

    let debug_levels_create = json!({
        "jsonrpc": "2.0",
        "id": "debug:create",
        "method": "debugLevels/create",
        "params": {
            "targetOrg": "default@example.com",
            "record": { "developerName": "ALV_DRY_RUN", "masterLabel": "ALV_DRY_RUN" },
            "dryRun": true
        }
    })
    .to_string();
    let (debug_create, _) = harness.request_json(&debug_levels_create);
    assert_eq!(debug_create["result"]["dryRun"], true);

    let debug_levels_update = json!({
        "jsonrpc": "2.0",
        "id": "debug:update",
        "method": "debugLevels/update",
        "params": {
            "targetOrg": "default@example.com",
            "id": "7dl000000000001AAA",
            "record": { "developerName": "ALV_DRY_RUN", "masterLabel": "ALV_DRY_RUN" },
            "dryRun": true
        }
    })
    .to_string();
    let (debug_update, _) = harness.request_json(&debug_levels_update);
    assert_eq!(debug_update["result"]["id"], "7dl000000000001AAA");

    let debug_levels_delete = json!({
        "jsonrpc": "2.0",
        "id": "debug:delete",
        "method": "debugLevels/delete",
        "params": {
            "targetOrg": "default@example.com",
            "id": "7dl000000000001AAA",
            "dryRun": true
        }
    })
    .to_string();
    let (debug_delete, _) = harness.request_json(&debug_levels_delete);
    assert_eq!(debug_delete["result"]["dryRun"], true);

    let tooling_query = json!({
        "jsonrpc": "2.0",
        "id": "tooling:query",
        "method": "tooling/query",
        "params": {
            "targetOrg": "default@example.com",
            "soql": "SELECT Id FROM ApexClass LIMIT 1"
        }
    })
    .to_string();
    let (tooling, _) = harness.request_json(&tooling_query);
    assert_eq!(tooling["result"]["records"][0]["Id"], "01p000000000001AAA");

    let tooling_get = json!({
        "jsonrpc": "2.0",
        "id": "tooling:get",
        "method": "tooling/request/get",
        "params": {
            "targetOrg": "default@example.com",
            "path": "/services/data/v61.0/limits"
        }
    })
    .to_string();
    let (raw_get, _) = harness.request_json(&tooling_get);
    assert_eq!(raw_get["result"]["ok"], true);

    let trace_status = json!({
        "jsonrpc": "2.0",
        "id": "trace:status",
        "method": "traceFlags/status",
        "params": {
            "targetOrg": "default@example.com",
            "target": { "type": "user", "userId": "" }
        }
    })
    .to_string();
    let (trace_status_result, _) = harness.request_json(&trace_status);
    assert_eq!(trace_status_result["result"]["targetAvailable"], true);
    assert_eq!(trace_status_result["result"]["isActive"], false);

    let trace_apply = json!({
        "jsonrpc": "2.0",
        "id": "trace:apply",
        "method": "traceFlags/apply",
        "params": {
            "targetOrg": "default@example.com",
            "target": { "type": "user", "userId": "" },
            "debugLevelName": "ALV_DEBUG"
        }
    })
    .to_string();
    let (trace_apply_error, _) = harness.request_json(&trace_apply);
    assert!(
        trace_apply_error["error"]["message"]
            .as_str()
            .is_some_and(|value| value.contains("confirmed=true")),
        "expected trace apply confirmation error, got: {trace_apply_error}"
    );

    let trace_remove = json!({
        "jsonrpc": "2.0",
        "id": "trace:remove",
        "method": "traceFlags/remove",
        "params": {
            "targetOrg": "default@example.com",
            "target": { "type": "user", "userId": "" }
        }
    })
    .to_string();
    let (trace_remove_error, _) = harness.request_json(&trace_remove);
    assert!(
        trace_remove_error["error"]["message"]
            .as_str()
            .is_some_and(|value| value.contains("confirmed=true")),
        "expected trace remove confirmation error, got: {trace_remove_error}"
    );

    std::env::remove_var("ALV_TEST_SF_ORG_LIST_JSON");
    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
    drop(harness);
    server_handle
        .join()
        .expect("agent method response server should finish");
    fs::remove_dir_all(workspace_root).expect("workspace should be removable");
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
    let _home_env = isolate_salesforce_home(&temp_dir);
    let sf_cmd = temp_dir.join("sf.cmd");
    fs::write(
        &sf_cmd,
        r#"@echo off
if /I "%*"=="org list --json --skip-connection-status" (
  echo {"result":{"nonScratchOrgs":[{"username":"shim@example.com","alias":"Shim","isDefaultUsername":true,"instanceUrl":"https://shim.example.com"}]}}
  exit /b 0
)
if /I "%*"=="org display --json --target-org shim@example.com" (
  echo {"status":0,"result":{"username":"shim@example.com","instanceUrl":"https://shim.example.com"}}
  exit /b 0
)
if /I "%*"=="org auth show-access-token --json --no-prompt --target-org shim@example.com" (
  echo {"status":0,"result":{"accessToken":"shim-token"}}
  exit /b 0
)
echo Unexpected sf args: %* 1>&2
exit /b 1
"#,
    )
    .expect("sf shim should be written");

    let _sf_bin_env = EnvVarRestore::capture("ALV_SF_BIN_PATH");
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
    let _home_env = isolate_salesforce_home(&temp_dir);
    let log_response = br#"{"result":{"records":[{"Id":"07L000000000001AA","StartTime":"2026-03-27T12:00:00.000Z","Operation":"ExecuteAnonymous","Application":"Developer Console","DurationMilliseconds":125,"Status":"Success","Request":"REQ-1","LogLength":4096}]}}"#;
    let (instance_url, server_handle) =
        spawn_single_http_response("200 OK", "application/json", log_response);
    let sf_cmd = temp_dir.join("sf.cmd");
    let sf_cmd_source = r#"@echo off
more >nul
if /I "%*"=="org display --json --target-org shim@example.com" (
  echo {"status":0,"result":{"username":"shim@example.com","instanceUrl":"__INSTANCE_URL__"}}
  exit /b 0
)
if /I "%*"=="org auth show-access-token --json --no-prompt --target-org shim@example.com" (
  echo {"status":0,"result":{"accessToken":"shim-token"}}
  exit /b 0
)
echo Unexpected sf args: %* 1>&2
exit /b 1
"#
    .replace("__INSTANCE_URL__", &instance_url);
    fs::write(&sf_cmd, sf_cmd_source).expect("sf shim should be written");

    let _sf_bin_env = EnvVarRestore::capture("ALV_SF_BIN_PATH");
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
    server_handle
        .join()
        .expect("log response server should finish");
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
