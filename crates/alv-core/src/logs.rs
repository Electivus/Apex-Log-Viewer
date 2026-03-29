use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::cli::build_command_invocation;
use crate::cli_json::extract_json_object;

pub const TEST_SF_LOG_LIST_JSON_ENV: &str = "ALV_TEST_SF_LOG_LIST_JSON";
pub const TEST_APEX_LOG_FIXTURE_DIR_ENV: &str = "ALV_TEST_APEX_LOG_FIXTURE_DIR";
const TEST_LOGS_CANCEL_DELAY_MS_ENV: &str = "ALV_TEST_LOGS_CANCEL_DELAY_MS";
const CANCELLED_MESSAGE: &str = "request cancelled";
const TRACE_RUNTIME_SPAWN_ENV: &str = "ALV_TRACE_RUNTIME_SPAWN";

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn check_cancelled(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CANCELLED_MESSAGE.to_string())
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogsListParams {
    pub username: Option<String>,
    #[serde(alias = "pageSize", alias = "page_size")]
    pub limit: Option<usize>,
    #[serde(default)]
    pub cursor: Option<LogsCursor>,
    #[serde(alias = "offset")]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogsCursor {
    #[serde(alias = "before_start_time")]
    pub before_start_time: Option<String>,
    #[serde(alias = "before_id")]
    pub before_id: Option<String>,
}

impl LogsCursor {
    pub fn filter_active(self) -> Option<Self> {
        if self
            .before_start_time
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            || self
                .before_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        {
            Some(self)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogUser {
    #[serde(rename = "Name", skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogRow {
    #[serde(rename = "Id")]
    pub id: String,
    #[serde(rename = "StartTime")]
    pub start_time: String,
    #[serde(rename = "Operation")]
    pub operation: String,
    #[serde(rename = "Application")]
    pub application: String,
    #[serde(rename = "DurationMilliseconds")]
    pub duration_milliseconds: u64,
    #[serde(rename = "Status")]
    pub status: String,
    #[serde(rename = "Request")]
    pub request: String,
    #[serde(rename = "LogLength")]
    pub log_length: u64,
    #[serde(rename = "LogUser", skip_serializing_if = "Option::is_none")]
    pub log_user: Option<LogUser>,
}

pub fn list_logs(params: &LogsListParams) -> Result<Vec<LogRow>, String> {
    list_logs_with_cancel(params, &CancellationToken::new())
}

pub fn list_logs_with_cancel(
    params: &LogsListParams,
    cancellation: &CancellationToken,
) -> Result<Vec<LogRow>, String> {
    let json = run_sf_log_list_json_with_cancel(params, cancellation)?;
    list_logs_from_json(&json)
}

pub fn list_logs_from_json(json: &str) -> Result<Vec<LogRow>, String> {
    let normalized = extract_json_object(json);
    let parsed: Value = serde_json::from_str(&normalized)
        .map_err(|error| format!("invalid log list JSON fixture: {error}"))?;

    let records = parsed
        .get("result")
        .and_then(|value| value.get("records"))
        .and_then(Value::as_array)
        .or_else(|| parsed.get("records").and_then(Value::as_array))
        .ok_or_else(|| "log list payload missing result.records".to_string())?;

    let mut rows = Vec::with_capacity(records.len());
    for record in records {
        rows.push(LogRow {
            id: string_field(record, "Id").ok_or_else(|| "log record missing Id".to_string())?,
            start_time: string_field(record, "StartTime").unwrap_or_default(),
            operation: string_field(record, "Operation").unwrap_or_default(),
            application: string_field(record, "Application").unwrap_or_default(),
            duration_milliseconds: number_field(record, "DurationMilliseconds").unwrap_or(0),
            status: string_field(record, "Status").unwrap_or_default(),
            request: string_field(record, "Request").unwrap_or_default(),
            log_length: number_field(record, "LogLength").unwrap_or(0),
            log_user: record
                .get("LogUser")
                .and_then(Value::as_object)
                .map(|_| LogUser {
                    name: record
                        .get("LogUser")
                        .and_then(|value| value.get("Name"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                }),
        });
    }

    Ok(rows)
}

pub fn run_sf_log_list_json(params: &LogsListParams) -> Result<String, String> {
    run_sf_log_list_json_with_cancel(params, &CancellationToken::new())
}

pub fn run_sf_log_list_json_with_cancel(
    params: &LogsListParams,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    if let Ok(fixture) = env::var(TEST_SF_LOG_LIST_JSON_ENV) {
        maybe_test_delay(TEST_LOGS_CANCEL_DELAY_MS_ENV, cancellation)?;
        cancellation.check_cancelled()?;
        return Ok(fixture);
    }

    cancellation.check_cancelled()?;
    let safe_page_size = params.limit.unwrap_or(100).clamp(1, 200);
    let safe_offset = params.offset.unwrap_or(0);
    let soql = build_logs_query(safe_page_size, safe_offset, params);

    let mut args = vec![
        "data".to_string(),
        "query".to_string(),
        "--use-tooling-api".to_string(),
        "--json".to_string(),
        "--result-format".to_string(),
        "json".to_string(),
        "--query".to_string(),
        soql,
    ];

    if let Some(username) = params
        .username
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        args.push("--target-org".to_string());
        args.push(username.trim().to_string());
    }

    run_command_with_cancel("sf", &args, cancellation)
}

pub fn resolve_apex_logs_dir(workspace_root: Option<&str>) -> PathBuf {
    match workspace_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(root) => Path::new(root).join("apexlogs"),
        None => env::temp_dir().join("apexlogs"),
    }
}

pub fn find_cached_log_path(workspace_root: Option<&str>, log_id: &str) -> Option<PathBuf> {
    if log_id.trim().is_empty() {
        return None;
    }

    let dir = resolve_apex_logs_dir(workspace_root);
    let entries = fs::read_dir(dir).ok()?;

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name()?.to_string_lossy();
        if file_name == format!("{log_id}.log") || file_name.ends_with(&format!("_{log_id}.log")) {
            return Some(path);
        }
    }

    None
}

pub fn ensure_log_file_cached(
    log_id: &str,
    username: Option<&str>,
    workspace_root: Option<&str>,
) -> Result<PathBuf, String> {
    ensure_log_file_cached_with_cancel(log_id, username, workspace_root, &CancellationToken::new())
}

pub fn ensure_log_file_cached_with_cancel(
    log_id: &str,
    username: Option<&str>,
    workspace_root: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<PathBuf, String> {
    cancellation.check_cancelled()?;
    if let Some(existing) = find_cached_log_path(workspace_root, log_id) {
        return Ok(existing);
    }

    let target_dir = resolve_apex_logs_dir(workspace_root);
    fs::create_dir_all(&target_dir).map_err(|error| {
        format!(
            "failed to create apexlogs dir {}: {error}",
            target_dir.display()
        )
    })?;

    let safe_user = sanitize_username(username);
    let target_path = target_dir.join(format!("{safe_user}_{log_id}.log"));

    if let Ok(fixture_dir) = env::var(TEST_APEX_LOG_FIXTURE_DIR_ENV) {
        cancellation.check_cancelled()?;
        let source_path = Path::new(&fixture_dir).join(format!("{log_id}.log"));
        if !source_path.is_file() {
            return Err(format!(
                "fixture log file not found for {log_id}: {}",
                source_path.display()
            ));
        }
        fs::copy(&source_path, &target_path).map_err(|error| {
            format!(
                "failed to copy fixture log {} into cache {}: {error}",
                source_path.display(),
                target_path.display()
            )
        })?;
        return Ok(target_path);
    }

    with_temp_staging_dir(|staging_dir| {
        let mut args = vec![
            "apex".to_string(),
            "get".to_string(),
            "log".to_string(),
            "--json".to_string(),
            "--log-id".to_string(),
            log_id.to_string(),
            "--output-dir".to_string(),
            staging_dir.display().to_string(),
        ];

        if let Some(value) = username.map(str::trim).filter(|value| !value.is_empty()) {
            args.push("--target-org".to_string());
            args.push(value.to_string());
        }

        run_command_with_cancel("sf", &args, cancellation)?;
        cancellation.check_cancelled()?;

        let downloaded_path = find_downloaded_log(staging_dir, log_id).ok_or_else(|| {
            format!(
                "sf apex get log did not write a .log file for {log_id} in {}",
                staging_dir.display()
            )
        })?;

        fs::copy(&downloaded_path, &target_path).map_err(|error| {
            format!(
                "failed to copy downloaded log {} into cache {}: {error}",
                downloaded_path.display(),
                target_path.display()
            )
        })?;

        Ok(target_path.clone())
    })
}

pub fn extract_code_unit_started(lines: &[&str]) -> Option<String> {
    for line in lines {
        let marker = "|CODE_UNIT_STARTED|";
        let Some(index) = line.find(marker) else {
            continue;
        };
        let captured = line[index + marker.len()..].trim();
        if captured.is_empty() {
            continue;
        }
        let parts = captured
            .split('|')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if let Some(last) = parts.last() {
            return Some((*last).to_string());
        }
        return Some(captured.to_string());
    }
    None
}

fn build_logs_query(page_size: usize, offset: usize, params: &LogsListParams) -> String {
    let base_select = "SELECT Id, StartTime, Operation, Application, DurationMilliseconds, Status, Request, LogLength, LogUser.Name FROM ApexLog";
    match (
        params
            .cursor
            .as_ref()
            .and_then(|cursor| cursor.before_start_time.as_deref())
            .filter(|value| !value.trim().is_empty()),
        params
            .cursor
            .as_ref()
            .and_then(|cursor| cursor.before_id.as_deref())
            .filter(|value| !value.trim().is_empty()),
    ) {
        (Some(before_start_time), Some(before_id)) => format!(
            "{base_select} WHERE StartTime < '{}' OR (StartTime = '{}' AND Id < '{}') ORDER BY StartTime DESC, Id DESC LIMIT {page_size}",
            escape_soql_literal(before_start_time),
            escape_soql_literal(before_start_time),
            escape_soql_literal(before_id)
        ),
        _ => format!(
            "{base_select} ORDER BY StartTime DESC, Id DESC LIMIT {page_size} OFFSET {offset}"
        ),
    }
}

fn find_downloaded_log(staging_dir: &Path, log_id: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(staging_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name()?.to_string_lossy();
        if !file_name.ends_with(".log") {
            continue;
        }
        if file_name.contains(log_id) || file_name == format!("{log_id}.log") {
            return Some(path);
        }
    }

    let entries = fs::read_dir(staging_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("log") {
            return Some(path);
        }
    }

    None
}

fn make_temp_staging_dir() -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = env::temp_dir().join(format!("alv-log-fetch-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&path)
        .map_err(|error| format!("failed to create staging dir {}: {error}", path.display()))?;
    Ok(path)
}

fn with_temp_staging_dir<T>(run: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    let staging_dir = make_temp_staging_dir()?;
    let result = run(&staging_dir);
    let _ = fs::remove_dir_all(&staging_dir);
    result
}

fn run_command_with_cancel(
    program: &str,
    args: &[String],
    cancellation: &CancellationToken,
) -> Result<String, String> {
    cancellation.check_cancelled()?;

    let invocation = build_command_invocation(program, args)?;
    trace_runtime_spawn(&format!(
        "spawn program={} args={:?}",
        invocation.program, invocation.args
    ));

    let mut child = Command::new(&invocation.program)
        .args(&invocation.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{program} failed to start: {error}"))?;
    trace_runtime_spawn(&format!(
        "child-started original={} pid={}",
        program,
        child.id()
    ));

    let stdout_reader = spawn_output_reader(child.stdout.take(), program, "stdout");
    let stderr_reader = spawn_output_reader(child.stderr.take(), program, "stderr");

    let status = loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = join_output_reader(stdout_reader);
            let _ = join_output_reader(stderr_reader);
            trace_runtime_spawn(&format!("child-cancelled original={program}"));
            return Err(CANCELLED_MESSAGE.to_string());
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                trace_runtime_spawn(&format!("child-exited original={program} status={status}"));
                break status;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = join_output_reader(stdout_reader);
                let _ = join_output_reader(stderr_reader);
                trace_runtime_spawn(&format!(
                    "child-poll-error original={program} error={error}"
                ));
                return Err(format!(
                    "{program} failed while polling child process: {error}"
                ));
            }
        }
    };

    let stdout = join_output_reader(stdout_reader)?;
    let stderr = join_output_reader(stderr_reader)?;
    command_output_to_result(program, status, stdout, stderr)
}

fn trace_runtime_spawn(message: &str) {
    if env::var_os(TRACE_RUNTIME_SPAWN_ENV).is_some() {
        eprintln!("[alv-core] {message}");
    }
}

fn spawn_output_reader<R>(
    pipe: Option<R>,
    program: &str,
    stream_name: &'static str,
) -> thread::JoinHandle<Result<Vec<u8>, String>>
where
    R: Read + Send + 'static,
{
    let program = program.to_string();
    thread::spawn(move || {
        let Some(mut pipe) = pipe else {
            return Ok(Vec::new());
        };
        let mut buffer = Vec::new();
        pipe.read_to_end(&mut buffer)
            .map_err(|error| format!("{program} failed while reading {stream_name}: {error}"))?;
        Ok(buffer)
    })
}

fn join_output_reader(
    handle: thread::JoinHandle<Result<Vec<u8>, String>>,
) -> Result<Vec<u8>, String> {
    handle
        .join()
        .map_err(|_| "output reader thread panicked".to_string())?
}

fn command_output_to_result(
    program: &str,
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();

    if status.success() {
        if stdout.is_empty() {
            return Err(format!("{program} returned empty output"));
        }
        return Ok(stdout);
    }

    if !stderr.is_empty() {
        return Err(stderr);
    }

    if !stdout.is_empty() {
        return Err(stdout);
    }

    Err(format!("{program} exited with status {status}"))
}

fn maybe_test_delay(env_key: &str, cancellation: &CancellationToken) -> Result<(), String> {
    let Some(delay_ms) = env::var(env_key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
    else {
        return Ok(());
    };

    let deadline = std::time::Instant::now() + Duration::from_millis(delay_ms);
    while std::time::Instant::now() < deadline {
        cancellation.check_cancelled()?;
        thread::sleep(Duration::from_millis(5));
    }

    cancellation.check_cancelled()
}

fn sanitize_username(username: Option<&str>) -> String {
    let trimmed = username.unwrap_or("default").trim();
    let sanitized = trimmed
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '.' | '@' | '-' => character,
            _ => '_',
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "default".to_string()
    } else {
        sanitized
    }
}

fn escape_soql_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|field| !field.is_empty())
        .map(str::to_string)
}

fn number_field(value: &Value, key: &str) -> Option<u64> {
    match value.get(key) {
        Some(Value::Number(number)) => number.as_u64(),
        Some(Value::String(text)) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn list_staging_dirs() -> BTreeSet<PathBuf> {
        let Some(entries) = fs::read_dir(env::temp_dir()).ok() else {
            return BTreeSet::new();
        };

        entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| {
                        value.starts_with(&format!("alv-log-fetch-{}-", std::process::id()))
                    })
            })
            .collect()
    }

    #[test]
    fn temp_staging_dir_helper_cleans_up_on_success() {
        let before = list_staging_dirs();

        let created = with_temp_staging_dir(|staging_dir| {
            assert!(staging_dir.is_dir());
            Ok(staging_dir.to_path_buf())
        })
        .expect("expected temp staging dir helper to succeed");

        assert!(
            !created.exists(),
            "staging dir should be removed after success"
        );
        assert_eq!(
            list_staging_dirs(),
            before,
            "staging dirs should not leak after success"
        );
    }

    #[test]
    fn temp_staging_dir_helper_cleans_up_on_error() {
        let before = list_staging_dirs();

        let error = with_temp_staging_dir(|staging_dir| -> Result<(), String> {
            assert!(staging_dir.is_dir());
            Err(format!("boom: {}", staging_dir.display()))
        })
        .expect_err("expected temp staging dir helper to bubble up the error");

        assert!(error.starts_with("boom: "));
        assert_eq!(
            list_staging_dirs(),
            before,
            "staging dirs should not leak after errors"
        );
    }
}
