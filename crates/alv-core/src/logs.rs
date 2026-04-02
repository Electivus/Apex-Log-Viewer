use reqwest::{blocking::Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    auth::{self, OrgAuth},
    cli_json::extract_json_object,
};

pub const TEST_SF_LOG_LIST_JSON_ENV: &str = "ALV_TEST_SF_LOG_LIST_JSON";
pub const TEST_APEX_LOG_FIXTURE_DIR_ENV: &str = "ALV_TEST_APEX_LOG_FIXTURE_DIR";
const TEST_LOGS_CANCEL_DELAY_MS_ENV: &str = "ALV_TEST_LOGS_CANCEL_DELAY_MS";
const CANCELLED_MESSAGE: &str = "request cancelled";
const DEFAULT_API_VERSION: &str = "64.0";
const HTTP_POLL_INTERVAL: Duration = Duration::from_millis(10);
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

static API_VERSION_OVERRIDES: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

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
    if let Some(fixture) = maybe_fixture_log_list_json(cancellation)? {
        return Ok(fixture);
    }

    cancellation.check_cancelled()?;
    let auth = auth::resolve_org_auth(params.username.as_deref())?;
    run_tooling_logs_query_with_cancel(&auth, params, cancellation)
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
    crate::log_store::find_cached_log_path(workspace_root, log_id, None)
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
    if let Some(existing) = crate::log_store::find_cached_log_path(workspace_root, log_id, username)
    {
        return Ok(existing);
    }

    let target_dir = resolve_apex_logs_dir(workspace_root);
    let safe_user = sanitize_username(username);
    let target_path = target_dir.join(format!("{safe_user}_{log_id}.log"));

    download_log_to_path_with_cancel(log_id, username, &target_path, cancellation)
}

pub(crate) fn list_logs_for_auth_with_cancel(
    auth: &OrgAuth,
    params: &LogsListParams,
    cancellation: &CancellationToken,
) -> Result<Vec<LogRow>, String> {
    if let Some(fixture) = maybe_fixture_log_list_json(cancellation)? {
        return list_logs_from_json(&fixture);
    }
    let json = run_tooling_logs_query_with_cancel(auth, params, cancellation)?;
    list_logs_from_json(&json)
}

pub(crate) fn download_log_to_path_for_auth_with_cancel(
    auth: &OrgAuth,
    log_id: &str,
    target_path: &Path,
    cancellation: &CancellationToken,
) -> Result<PathBuf, String> {
    cancellation.check_cancelled()?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    if let Ok(fixture_dir) = env::var(TEST_APEX_LOG_FIXTURE_DIR_ENV) {
        maybe_test_delay(TEST_LOGS_CANCEL_DELAY_MS_ENV, cancellation)?;
        cancellation.check_cancelled()?;
        let source_path = Path::new(&fixture_dir).join(format!("{log_id}.log"));
        if !source_path.is_file() {
            return Err(format!(
                "fixture log file not found for {log_id}: {}",
                source_path.display()
            ));
        }
        let bytes = fs::read(&source_path).map_err(|error| {
            format!(
                "failed to read fixture log {}: {error}",
                source_path.display()
            )
        })?;
        return write_bytes_atomically(target_path, &bytes, cancellation);
    }

    let body = fetch_apex_log_body_with_cancel(auth, log_id, cancellation)?;
    write_bytes_atomically(target_path, body.as_bytes(), cancellation)
}

pub fn download_log_to_path_with_cancel(
    log_id: &str,
    username: Option<&str>,
    target_path: &Path,
    cancellation: &CancellationToken,
) -> Result<PathBuf, String> {
    if env::var(TEST_APEX_LOG_FIXTURE_DIR_ENV).is_ok() {
        let fallback_auth = OrgAuth {
            access_token: String::new(),
            instance_url: String::new(),
            username: username.map(str::to_string),
        };
        return download_log_to_path_for_auth_with_cancel(
            &fallback_auth,
            log_id,
            target_path,
            cancellation,
        );
    }

    let auth = auth::resolve_org_auth(username)?;
    download_log_to_path_for_auth_with_cancel(&auth, log_id, target_path, cancellation)
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
            "{base_select} WHERE StartTime < {} OR (StartTime = {} AND Id < '{}') ORDER BY StartTime DESC, Id DESC LIMIT {page_size}",
            before_start_time.trim(),
            before_start_time.trim(),
            escape_soql_literal(before_id)
        ),
        _ => format!(
            "{base_select} ORDER BY StartTime DESC, Id DESC LIMIT {page_size} OFFSET {offset}"
        ),
    }
}

fn run_tooling_logs_query_with_cancel(
    auth: &OrgAuth,
    params: &LogsListParams,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    cancellation.check_cancelled()?;
    let safe_page_size = params.limit.unwrap_or(100).clamp(1, 200);
    let safe_offset = params.offset.unwrap_or(0);
    let soql = build_logs_query(safe_page_size, safe_offset, params);
    request_tooling_query_json(auth, &soql, cancellation)
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

fn maybe_fixture_log_list_json(cancellation: &CancellationToken) -> Result<Option<String>, String> {
    let Ok(fixture) = env::var(TEST_SF_LOG_LIST_JSON_ENV) else {
        return Ok(None);
    };

    maybe_test_delay(TEST_LOGS_CANCEL_DELAY_MS_ENV, cancellation)?;
    cancellation.check_cancelled()?;
    Ok(Some(fixture))
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

fn strip_trailing_slashes(value: &str) -> &str {
    value.trim_end_matches('/')
}

fn normalize_org_cache_key(auth: &OrgAuth) -> String {
    let instance = strip_trailing_slashes(auth.instance_url.trim()).to_ascii_lowercase();
    if !instance.is_empty() {
        return instance;
    }
    auth.username
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn api_version_overrides() -> &'static Mutex<BTreeMap<String, String>> {
    API_VERSION_OVERRIDES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn get_effective_api_version(auth: &OrgAuth) -> String {
    api_version_overrides()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&normalize_org_cache_key(auth))
        .cloned()
        .unwrap_or_else(|| DEFAULT_API_VERSION.to_string())
}

fn record_api_version_override(auth: &OrgAuth, version: &str) {
    api_version_overrides()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(normalize_org_cache_key(auth), version.to_string());
}

fn parse_api_version(value: &str) -> Option<(u32, u32)> {
    let trimmed = value.trim();
    let (major, minor) = trimmed.split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

fn build_versioned_url(auth: &OrgAuth, version: &str, path: &str) -> Result<Url, String> {
    let base = strip_trailing_slashes(auth.instance_url.trim());
    Url::parse(&format!("{base}/services/data/v{version}{path}"))
        .map_err(|error| format!("invalid Salesforce URL: {error}"))
}

fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(HTTP_CONNECT_TIMEOUT)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .build()
            .expect("reqwest blocking client should initialize")
    })
}

#[derive(Debug)]
enum HttpRequestError {
    Cancelled,
    Failed {
        status: Option<StatusCode>,
        message: String,
    },
}

impl HttpRequestError {
    fn to_string_message(&self) -> String {
        match self {
            Self::Cancelled => CANCELLED_MESSAGE.to_string(),
            Self::Failed { message, .. } => message.clone(),
        }
    }
}

fn run_http_request_with_cancel(
    auth: &OrgAuth,
    url: Url,
    accept: &'static str,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, HttpRequestError> {
    cancellation
        .check_cancelled()
        .map_err(|_| HttpRequestError::Cancelled)?;

    let auth = auth.clone();
    let url_string = url.to_string();
    let token = cancellation.clone();
    let (tx, rx) = mpsc::sync_channel(1);

    thread::spawn(move || {
        let response = http_client()
            .get(url_string)
            .header("Authorization", format!("Bearer {}", auth.access_token))
            .header("Accept", accept)
            .send();
        let result = match response {
            Ok(response) => {
                let status = response.status();
                match response.bytes() {
                    Ok(body) if status.is_success() => Ok(body.to_vec()),
                    Ok(body) => Err(HttpRequestError::Failed {
                        status: Some(status),
                        message: String::from_utf8_lossy(&body).trim().to_string(),
                    }),
                    Err(error) => Err(HttpRequestError::Failed {
                        status: Some(status),
                        message: error.to_string(),
                    }),
                }
            }
            Err(error) => Err(HttpRequestError::Failed {
                status: error.status(),
                message: error.to_string(),
            }),
        };
        let _ = tx.send(result);
    });

    loop {
        if token.is_cancelled() {
            return Err(HttpRequestError::Cancelled);
        }

        match rx.recv_timeout(HTTP_POLL_INTERVAL) {
            Ok(result) => return result,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return Err(HttpRequestError::Failed {
                    status: None,
                    message: "HTTP worker disconnected before returning a response".to_string(),
                });
            }
        }
    }
}

fn request_bytes_with_version_fallback(
    auth: &OrgAuth,
    path: &str,
    query_pairs: &[(&str, &str)],
    accept: &'static str,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, String> {
    let mut attempted_fallback = false;

    loop {
        cancellation.check_cancelled()?;
        let active_version = get_effective_api_version(auth);
        let mut url = build_versioned_url(auth, &active_version, path)?;
        for (key, value) in query_pairs {
            url.query_pairs_mut().append_pair(key, value);
        }

        match run_http_request_with_cancel(auth, url, accept, cancellation) {
            Ok(bytes) => return Ok(bytes),
            Err(HttpRequestError::Cancelled) => return Err(CANCELLED_MESSAGE.to_string()),
            Err(HttpRequestError::Failed {
                status: Some(StatusCode::NOT_FOUND),
                message,
            }) if !attempted_fallback => {
                let requested = parse_api_version(&active_version);
                let Some(org_max_version) = discover_org_max_api_version(auth, cancellation)?
                else {
                    return Err(message);
                };
                let org_max = parse_api_version(&org_max_version);
                if requested.is_some() && org_max.is_some() && requested > org_max {
                    record_api_version_override(auth, &org_max_version);
                    attempted_fallback = true;
                    continue;
                }
                return Err(message);
            }
            Err(error) => return Err(error.to_string_message()),
        }
    }
}

fn request_tooling_query_json(
    auth: &OrgAuth,
    soql: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let bytes = request_bytes_with_version_fallback(
        auth,
        "/tooling/query",
        &[("q", soql)],
        "application/json",
        cancellation,
    )?;
    String::from_utf8(bytes)
        .map_err(|error| format!("invalid UTF-8 in Tooling query response: {error}"))
}

fn fetch_apex_log_body_with_cancel(
    auth: &OrgAuth,
    log_id: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let bytes = request_bytes_with_version_fallback(
        auth,
        &format!("/tooling/sobjects/ApexLog/{log_id}/Body"),
        &[],
        "text/plain",
        cancellation,
    )?;
    String::from_utf8(bytes)
        .map_err(|error| format!("invalid UTF-8 in ApexLog body response: {error}"))
}

fn discover_org_max_api_version(
    auth: &OrgAuth,
    cancellation: &CancellationToken,
) -> Result<Option<String>, String> {
    let url = Url::parse(&format!(
        "{}/services/data",
        strip_trailing_slashes(auth.instance_url.trim())
    ))
    .map_err(|error| format!("invalid Salesforce base URL: {error}"))?;
    let bytes = match run_http_request_with_cancel(auth, url, "application/json", cancellation) {
        Ok(bytes) => bytes,
        Err(HttpRequestError::Cancelled) => return Err(CANCELLED_MESSAGE.to_string()),
        Err(error) => return Err(error.to_string_message()),
    };
    let parsed: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid services/data response JSON: {error}"))?;
    let Some(items) = parsed.as_array() else {
        return Ok(None);
    };

    let mut best: Option<(u32, u32, String)> = None;
    for item in items {
        let Some(version_text) = item.get("version").and_then(Value::as_str) else {
            continue;
        };
        let Some((major, minor)) = parse_api_version(version_text) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|(best_major, best_minor, _)| (major, minor) > (*best_major, *best_minor))
        {
            best = Some((major, minor, version_text.to_string()));
        }
    }

    Ok(best.map(|(_, _, version)| version))
}

fn write_bytes_atomically(
    target_path: &Path,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<PathBuf, String> {
    cancellation.check_cancelled()?;
    let parent = target_path
        .parent()
        .ok_or_else(|| format!("target path has no parent: {}", target_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("apex-log");
    let temp_path = parent.join(format!(".{file_name}.part-{}-{nonce}", std::process::id()));

    let write_result = (|| -> Result<(), String> {
        let mut file = File::create(&temp_path)
            .map_err(|error| format!("failed to create {}: {error}", temp_path.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("failed to write {}: {error}", temp_path.display()))?;
        file.flush()
            .map_err(|error| format!("failed to flush {}: {error}", temp_path.display()))?;
        cancellation.check_cancelled()?;
        fs::rename(&temp_path, target_path).map_err(|error| {
            format!(
                "failed to move {} into {}: {error}",
                temp_path.display(),
                target_path.display()
            )
        })?;
        Ok(())
    })();

    if write_result.is_err() || cancellation.is_cancelled() {
        let _ = fs::remove_file(&temp_path);
    }

    write_result?;
    Ok(target_path.to_path_buf())
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
    use std::sync::{Arc, Mutex};

    #[test]
    fn lock_helper_recovers_from_poison() {
        let poisoned_mutex = Arc::new(Mutex::new(()));
        let poison_target = Arc::clone(&poisoned_mutex);

        let _ = std::thread::spawn(move || {
            let _guard = poison_target
                .lock()
                .expect("poison test should acquire mutex");
            panic!("poison the mutex for regression coverage");
        })
        .join();

        let _guard = poisoned_mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }

    #[test]
    fn parse_api_version_accepts_major_minor() {
        assert_eq!(parse_api_version("64.0"), Some((64, 0)));
        assert_eq!(parse_api_version(" 61.2 "), Some((61, 2)));
        assert_eq!(parse_api_version("v64.0"), None);
    }

    #[test]
    fn write_bytes_atomically_cleans_temp_file_on_cancellation() {
        let root = env::temp_dir().join(format!(
            "alv-log-write-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("temp root should be creatable");
        let target = root.join("07L000000000001AA.log");
        let token = CancellationToken::new();
        token.cancel();

        let error = write_bytes_atomically(&target, b"body", &token)
            .expect_err("cancelled writes should abort");
        assert!(error.contains("cancel"));
        assert!(!target.exists());

        let leftovers = fs::read_dir(&root)
            .expect("temp root should be readable")
            .flatten()
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        assert!(
            leftovers.is_empty(),
            "cancelled atomic writes should not leave temp files behind"
        );

        fs::remove_dir_all(&root).expect("temp root should be removable");
    }
}
