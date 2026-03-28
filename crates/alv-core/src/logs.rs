use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

pub const TEST_SF_LOG_LIST_JSON_ENV: &str = "ALV_TEST_SF_LOG_LIST_JSON";
pub const TEST_APEX_LOG_FIXTURE_DIR_ENV: &str = "ALV_TEST_APEX_LOG_FIXTURE_DIR";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LogsListParams {
    pub username: Option<String>,
    pub page_size: Option<usize>,
    pub offset: Option<usize>,
    pub before_start_time: Option<String>,
    pub before_id: Option<String>,
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
    let json = run_sf_log_list_json(params)?;
    list_logs_from_json(&json)
}

pub fn list_logs_from_json(json: &str) -> Result<Vec<LogRow>, String> {
    let parsed: Value = serde_json::from_str(json)
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
    if let Ok(fixture) = env::var(TEST_SF_LOG_LIST_JSON_ENV) {
        return Ok(fixture);
    }

    let safe_page_size = params.page_size.unwrap_or(100).clamp(1, 200);
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

    run_command("sf", &args)
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

    let staging_dir = make_temp_staging_dir()?;
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

    run_command("sf", &args)?;

    let downloaded_path = find_downloaded_log(&staging_dir, log_id).ok_or_else(|| {
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

    if let Err(error) = fs::remove_dir_all(&staging_dir) {
        return Err(format!(
            "downloaded log but failed to cleanup staging dir {}: {error}",
            staging_dir.display()
        ));
    }

    Ok(target_path)
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
        params.before_start_time.as_deref().filter(|value| !value.trim().is_empty()),
        params.before_id.as_deref().filter(|value| !value.trim().is_empty()),
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

fn run_command(program: &str, args: &[String]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("{program} failed to start: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
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

    Err(format!("{program} exited with status {}", output.status))
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
