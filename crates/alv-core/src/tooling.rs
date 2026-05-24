use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    future::Future,
    sync::{mpsc::sync_channel, OnceLock},
    time::Duration,
};
use tokio::runtime::{Builder as RuntimeBuilder, Runtime};

use crate::{
    auth::{self, OrgAuth},
    logs::CancellationToken,
};

const DEFAULT_API_VERSION: &str = "64.0";
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const HTTP_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(10);

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
static HTTP_RUNTIME: OnceLock<Runtime> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesforceQueryResult {
    pub records: Vec<Value>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_records_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SObjectWriteResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositeDeleteResult {
    pub id: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<Value>,
}

pub fn escape_soql_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

pub fn resolve_org_auth(target_org: Option<&str>) -> Result<OrgAuth, String> {
    auth::resolve_org_auth(target_org)
}

pub fn query_tooling(
    target_org: Option<&str>,
    soql: &str,
    cancellation: &CancellationToken,
) -> Result<SalesforceQueryResult, String> {
    let auth = resolve_org_auth(target_org)?;
    query_path_all(&auth, "/tooling/query", soql, cancellation)
}

pub fn query_standard(
    target_org: Option<&str>,
    soql: &str,
    cancellation: &CancellationToken,
) -> Result<SalesforceQueryResult, String> {
    let auth = resolve_org_auth(target_org)?;
    query_path_all(&auth, "/query", soql, cancellation)
}

pub fn request_get(
    target_org: Option<&str>,
    path_or_url: &str,
    cancellation: &CancellationToken,
) -> Result<Value, String> {
    let auth = resolve_org_auth(target_org)?;
    let url = build_api_url(&auth, path_or_url)?;
    let bytes = request_bytes(
        &auth,
        Method::GET,
        url,
        None,
        "application/json",
        cancellation,
    )?;
    parse_json_bytes(&bytes, "GET response")
}

pub fn request_text_get(
    target_org: Option<&str>,
    path_or_url: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let auth = resolve_org_auth(target_org)?;
    let url = build_api_url(&auth, path_or_url)?;
    let bytes = request_bytes(&auth, Method::GET, url, None, "text/plain", cancellation)?;
    String::from_utf8(bytes).map_err(|error| format!("invalid UTF-8 response: {error}"))
}

pub fn sobject_create(
    target_org: Option<&str>,
    tooling: bool,
    object_name: &str,
    payload: &Value,
    cancellation: &CancellationToken,
) -> Result<SObjectWriteResult, String> {
    let auth = resolve_org_auth(target_org)?;
    let prefix = if tooling { "/tooling" } else { "" };
    let url = build_versioned_url(&auth, &format!("{prefix}/sobjects/{object_name}"))?;
    let body = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    let bytes = request_bytes(
        &auth,
        Method::POST,
        url,
        Some(body),
        "application/json",
        cancellation,
    )?;
    parse_write_result(&bytes)
}

pub fn sobject_update(
    target_org: Option<&str>,
    tooling: bool,
    object_name: &str,
    id: &str,
    payload: &Value,
    cancellation: &CancellationToken,
) -> Result<SObjectWriteResult, String> {
    let auth = resolve_org_auth(target_org)?;
    let prefix = if tooling { "/tooling" } else { "" };
    let url = build_versioned_url(&auth, &format!("{prefix}/sobjects/{object_name}/{id}"))?;
    let body = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    let bytes = request_bytes(
        &auth,
        Method::PATCH,
        url,
        Some(body),
        "application/json",
        cancellation,
    )?;
    if bytes.is_empty() {
        return Ok(SObjectWriteResult {
            success: true,
            id: Some(id.to_string()),
            errors: Vec::new(),
        });
    }
    parse_write_result(&bytes)
}

pub fn sobject_delete(
    target_org: Option<&str>,
    tooling: bool,
    object_name: &str,
    id: &str,
    cancellation: &CancellationToken,
) -> Result<SObjectWriteResult, String> {
    let auth = resolve_org_auth(target_org)?;
    let prefix = if tooling { "/tooling" } else { "" };
    let url = build_versioned_url(&auth, &format!("{prefix}/sobjects/{object_name}/{id}"))?;
    let bytes = request_bytes(
        &auth,
        Method::DELETE,
        url,
        None,
        "application/json",
        cancellation,
    )?;
    if bytes.is_empty() {
        return Ok(SObjectWriteResult {
            success: true,
            id: Some(id.to_string()),
            errors: Vec::new(),
        });
    }
    parse_write_result(&bytes)
}

pub fn composite_delete_sobjects(
    target_org: Option<&str>,
    ids: &[String],
    cancellation: &CancellationToken,
) -> Result<Vec<CompositeDeleteResult>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let auth = resolve_org_auth(target_org)?;
    let mut url = build_versioned_url(&auth, "/composite/sobjects")?;
    url.query_pairs_mut()
        .append_pair("ids", &ids.join(","))
        .append_pair("allOrNone", "false");
    let bytes = request_bytes(
        &auth,
        Method::DELETE,
        url,
        None,
        "application/json",
        cancellation,
    )?;
    serde_json::from_slice::<Vec<CompositeDeleteResult>>(&bytes)
        .map_err(|error| format!("invalid composite delete response JSON: {error}"))
}

fn query_path_all(
    auth: &OrgAuth,
    query_path: &str,
    soql: &str,
    cancellation: &CancellationToken,
) -> Result<SalesforceQueryResult, String> {
    let mut url = build_versioned_url(auth, query_path)?;
    url.query_pairs_mut().append_pair("q", soql);
    let mut combined = SalesforceQueryResult {
        records: Vec::new(),
        done: true,
        total_size: None,
        next_records_url: None,
        raw: None,
    };
    let mut next_url = Some(url);

    while let Some(url) = next_url.take() {
        cancellation.check_cancelled()?;
        let bytes = request_bytes(
            auth,
            Method::GET,
            url,
            None,
            "application/json",
            cancellation,
        )?;
        let page = parse_query_result(&bytes)?;
        combined.total_size = page.total_size.or(combined.total_size);
        combined.records.extend(page.records);
        combined.done = page.done;
        combined.next_records_url = page.next_records_url.clone();
        next_url = page
            .next_records_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| build_api_url(auth, value))
            .transpose()?;
        if page.done {
            break;
        }
    }

    Ok(combined)
}

fn parse_query_result(bytes: &[u8]) -> Result<SalesforceQueryResult, String> {
    let raw = parse_json_bytes(bytes, "query response")?;
    let records = raw
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(SalesforceQueryResult {
        records,
        done: raw.get("done").and_then(Value::as_bool).unwrap_or(true),
        total_size: raw
            .get("totalSize")
            .and_then(Value::as_u64)
            .or_else(|| raw.get("total_size").and_then(Value::as_u64)),
        next_records_url: raw
            .get("nextRecordsUrl")
            .and_then(Value::as_str)
            .or_else(|| raw.get("next_records_url").and_then(Value::as_str))
            .map(str::to_string),
        raw: Some(raw),
    })
}

fn parse_write_result(bytes: &[u8]) -> Result<SObjectWriteResult, String> {
    if bytes.is_empty() {
        return Ok(SObjectWriteResult {
            success: true,
            id: None,
            errors: Vec::new(),
        });
    }
    let raw = parse_json_bytes(bytes, "write response")?;
    Ok(SObjectWriteResult {
        success: raw.get("success").and_then(Value::as_bool).unwrap_or(true),
        id: raw.get("id").and_then(Value::as_str).map(str::to_string),
        errors: raw
            .get("errors")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    })
}

fn parse_json_bytes(bytes: &[u8], label: &str) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|error| format!("invalid {label} JSON: {error}"))
}

fn request_bytes(
    auth: &OrgAuth,
    method: Method,
    url: Url,
    body: Option<String>,
    accept: &'static str,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, String> {
    cancellation.check_cancelled()?;
    let mut active_auth = auth.clone();
    let mut attempted_refresh = false;

    loop {
        let active_url = url.clone();
        let request_url = active_url.to_string();
        let method_for_request = method.clone();
        let accept_for_request = accept;
        let body_for_request = body.clone();
        let auth_for_request = active_auth.clone();
        let result = run_async_operation_with_cancel(
            async move {
                let mut builder = http_client()
                    .request(method_for_request, active_url)
                    .header(
                        "Authorization",
                        format!("Bearer {}", auth_for_request.access_token),
                    )
                    .header("Accept", accept_for_request)
                    .header("Content-Type", "application/json");
                if let Some(body) = body_for_request {
                    builder = builder.body(body);
                }
                let response = builder.send().await.map_err(|error| HttpRequestError {
                    status: error.status(),
                    message: format_request_error(&error, &request_url),
                })?;
                let status = response.status();
                let bytes = response.bytes().await.map_err(|error| HttpRequestError {
                    status: Some(status),
                    message: format!(
                        "failed to read HTTP response body from {request_url} after {status}: {error}"
                    ),
                })?;
                if status.is_success() {
                    return Ok(bytes.to_vec());
                }
                let body_text = String::from_utf8_lossy(&bytes).trim().to_string();
                let message = if body_text.is_empty() {
                    format!("HTTP {status} from {request_url}")
                } else {
                    format!(
                        "HTTP {status} from {request_url}: {}",
                        redact_secrets(&body_text)
                    )
                };
                Err(HttpRequestError {
                    status: Some(status),
                    message,
                })
            },
            cancellation,
        );

        match result {
            Ok(bytes) => return Ok(bytes),
            Err(error) if error.status == Some(StatusCode::UNAUTHORIZED) && !attempted_refresh => {
                let Some(username) = active_auth
                    .username
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                else {
                    return Err(error.message);
                };
                auth::clear_cached_org_auth_for_username(Some(&username));
                active_auth = resolve_org_auth(Some(&username))?;
                attempted_refresh = true;
            }
            Err(error) => return Err(error.message),
        }
    }
}

#[derive(Debug)]
struct HttpRequestError {
    status: Option<StatusCode>,
    message: String,
}

fn run_async_operation_with_cancel<T, F>(
    future: F,
    cancellation: &CancellationToken,
) -> Result<T, HttpRequestError>
where
    T: Send + 'static,
    F: Future<Output = Result<T, HttpRequestError>> + Send + 'static,
{
    cancellation
        .check_cancelled()
        .map_err(|message| HttpRequestError {
            status: None,
            message,
        })?;

    let (result_tx, result_rx) = sync_channel(1);
    let task = http_runtime().spawn(async move {
        let result = future.await;
        let _ = result_tx.send(result);
    });

    loop {
        if cancellation.is_cancelled() {
            task.abort();
            return Err(HttpRequestError {
                status: None,
                message: "request cancelled".to_string(),
            });
        }
        match result_rx.recv_timeout(HTTP_CANCEL_POLL_INTERVAL) {
            Ok(result) => return result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(HttpRequestError {
                    status: None,
                    message: "HTTP request task terminated unexpectedly".to_string(),
                });
            }
        }
    }
}

fn build_api_url(auth: &OrgAuth, path_or_url: &str) -> Result<Url, String> {
    let value = path_or_url.trim();
    if value.starts_with("http://") || value.starts_with("https://") {
        let url = Url::parse(value).map_err(|error| format!("invalid URL: {error}"))?;
        let base = Url::parse(strip_trailing_slashes(auth.instance_url.trim()))
            .map_err(|error| format!("invalid authenticated org URL: {error}"))?;
        if url.username().is_empty()
            && url.password().is_none()
            && url.scheme() == base.scheme()
            && url.host_str() == base.host_str()
            && url.port_or_known_default() == base.port_or_known_default()
        {
            return Ok(url);
        }
        return Err("absolute Salesforce URL must match authenticated org host".to_string());
    }
    let base = strip_trailing_slashes(auth.instance_url.trim());
    if value.starts_with("/services/data/") {
        return Url::parse(&format!("{base}{value}"))
            .map_err(|error| format!("invalid Salesforce URL: {error}"));
    }
    if value.starts_with('/') {
        return build_versioned_url(auth, value);
    }
    build_versioned_url(auth, &format!("/{value}"))
}

fn build_versioned_url(auth: &OrgAuth, path: &str) -> Result<Url, String> {
    let base = strip_trailing_slashes(auth.instance_url.trim());
    Url::parse(&format!(
        "{base}/services/data/v{DEFAULT_API_VERSION}{path}"
    ))
    .map_err(|error| format!("invalid Salesforce URL: {error}"))
}

fn strip_trailing_slashes(value: &str) -> &str {
    value.trim_end_matches('/')
}

fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(HTTP_CONNECT_TIMEOUT)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .build()
            .expect("reqwest client should initialize")
    })
}

fn http_runtime() -> &'static Runtime {
    HTTP_RUNTIME.get_or_init(|| {
        RuntimeBuilder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime should initialize")
    })
}

fn format_request_error(error: &reqwest::Error, url: &str) -> String {
    let mut message = format!("HTTP request failed for {url}: {error}");
    if let Some(status) = error.status() {
        message = format!("HTTP {status} from {url}: {error}");
    }
    redact_secrets(&message)
}

pub fn redact_secrets(value: &str) -> String {
    let mut output = value.to_string();
    redact_after_prefix(&mut output, "Bearer ");
    redact_after_prefix(&mut output, "access_token=");
    redact_keyed_secret(&mut output, "accessToken");
    redact_keyed_secret(&mut output, "refreshToken");
    output
}

fn redact_after_prefix(output: &mut String, marker: &str) {
    let mut search_start = 0;
    while let Some(relative_index) = output[search_start..].find(marker) {
        let start = search_start + relative_index + marker.len();
        let end = secret_value_end(output, start);
        if end > start {
            output.replace_range(start..end, "[redacted]");
            search_start = start + "[redacted]".len();
        } else {
            search_start = start;
        }
    }
}

fn redact_keyed_secret(output: &mut String, key: &str) {
    let mut search_start = 0;
    while let Some(relative_index) = output[search_start..].find(key) {
        let mut cursor = search_start + relative_index + key.len();
        cursor = skip_ascii_whitespace(output, cursor);
        if output[cursor..].starts_with('"') || output[cursor..].starts_with('\'') {
            cursor += 1;
            cursor = skip_ascii_whitespace(output, cursor);
        }
        if !(output[cursor..].starts_with(':') || output[cursor..].starts_with('=')) {
            search_start = cursor;
            continue;
        }
        cursor += 1;
        cursor = skip_ascii_whitespace(output, cursor);

        let quote = output[cursor..]
            .chars()
            .next()
            .filter(|ch| *ch == '"' || *ch == '\'');
        let start = if quote.is_some() { cursor + 1 } else { cursor };
        let end = quote
            .and_then(|quote_char| {
                output[start..]
                    .find(quote_char)
                    .map(|relative_end| start + relative_end)
            })
            .unwrap_or_else(|| secret_value_end(output, start));

        if end > start {
            output.replace_range(start..end, "[redacted]");
            search_start = start + "[redacted]".len();
        } else {
            search_start = start;
        }
    }
}

fn skip_ascii_whitespace(value: &str, mut cursor: usize) -> usize {
    while cursor < value.len() && value.as_bytes()[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    cursor
}

fn secret_value_end(value: &str, start: usize) -> usize {
    value[start..]
        .find(|ch: char| {
            ch.is_whitespace() || ch == '"' || ch == '&' || ch == ',' || ch == '}' || ch == ']'
        })
        .map(|offset| start + offset)
        .unwrap_or(value.len())
}

#[cfg(test)]
mod tests {
    use super::{build_api_url, escape_soql_literal, redact_secrets};
    use crate::auth::OrgAuth;

    fn test_auth() -> OrgAuth {
        OrgAuth {
            access_token: "secret-token".to_string(),
            instance_url: "https://example.my.salesforce.com".to_string(),
            username: Some("user@example.com".to_string()),
        }
    }

    #[test]
    fn escape_soql_literal_escapes_quotes_and_backslashes() {
        assert_eq!(escape_soql_literal("O'Brien\\QA"), "O\\'Brien\\\\QA");
    }

    #[test]
    fn build_api_url_allows_absolute_url_for_authenticated_org_host() {
        let url = build_api_url(
            &test_auth(),
            "https://example.my.salesforce.com/services/data/v64.0/tooling/query?q=SELECT+Id+FROM+ApexLog",
        )
        .expect("same-host URL should be accepted");

        assert_eq!(
            url.as_str(),
            "https://example.my.salesforce.com/services/data/v64.0/tooling/query?q=SELECT+Id+FROM+ApexLog"
        );
    }

    #[test]
    fn build_api_url_rejects_absolute_url_for_external_host() {
        let err = build_api_url(
            &test_auth(),
            "https://attacker.example/services/data/v64.0/tooling/query",
        )
        .expect_err("external absolute URL should be rejected");

        assert!(err.contains("authenticated org host"));
    }

    #[test]
    fn build_api_url_rejects_absolute_url_with_userinfo() {
        let err = build_api_url(
            &test_auth(),
            "https://token@example.my.salesforce.com/services/data/v64.0/tooling/query",
        )
        .expect_err("userinfo should be rejected");

        assert!(err.contains("authenticated org host"));
    }

    #[test]
    fn redact_secrets_hides_bearer_tokens() {
        let redacted = redact_secrets("Authorization: Bearer 00D-secret-token failed");
        assert!(redacted.contains("Bearer [redacted]"));
        assert!(!redacted.contains("00D-secret-token"));
    }

    #[test]
    fn redact_secrets_hides_json_token_fields() {
        let redacted = redact_secrets(
            r#"{"accessToken":"00D-access-token","refreshToken":"00D-refresh-token"}"#,
        );

        assert!(redacted.contains(r#""accessToken":"[redacted]""#));
        assert!(redacted.contains(r#""refreshToken":"[redacted]""#));
        assert!(!redacted.contains("00D-access-token"));
        assert!(!redacted.contains("00D-refresh-token"));
    }

    #[test]
    fn redact_secrets_hides_key_value_token_fields() {
        let redacted =
            redact_secrets("accessToken=00D-access-token refreshToken: 00D-refresh-token");

        assert!(redacted.contains("accessToken=[redacted]"));
        assert!(redacted.contains("refreshToken: [redacted]"));
        assert!(!redacted.contains("00D-access-token"));
        assert!(!redacted.contains("00D-refresh-token"));
    }
}
