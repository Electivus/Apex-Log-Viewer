use alv_protocol::messages::{InitializeParams, InitializeResult, RuntimeCapabilities};
use serde_json::Value;
use std::io::{self, BufRead, Write};

use crate::transport_stdio::bounded_transport_channel;

#[path = "handlers/logs.rs"]
mod logs_handler;
#[path = "handlers/orgs.rs"]
mod orgs_handler;

pub fn handle_initialize(_params: InitializeParams) -> InitializeResult {
    InitializeResult {
        runtime_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: "1".to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        capabilities: RuntimeCapabilities {
            orgs: true,
            logs: true,
            search: true,
            tail: true,
            debug_flags: true,
            doctor: true,
        },
        state_dir: ".alv/state".to_string(),
        cache_dir: ".alv/cache".to_string(),
    }
}

pub fn run_stdio() -> Result<(), String> {
    let (_sender, _receiver) = bounded_transport_channel::<String>();
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());

    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }

        if let Some(response) = handle_request_line(&line)? {
            stdout
                .write_all(response.as_bytes())
                .map_err(|error| error.to_string())?;
            stdout.write_all(b"\n").map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

pub fn handle_request_line(request: &str) -> Result<Option<String>, String> {
    let envelope: Value =
        serde_json::from_str(request).map_err(|error| format!("invalid request JSON: {error}"))?;

    let method = envelope
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing method".to_string())?;

    if method == "cancel" {
        return Ok(None);
    }

    let id = envelope
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing request id".to_string())?;
    let params = envelope.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => {
            let result = handle_initialize(InitializeParams {
                client_name: params
                    .get("client_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                client_version: params
                    .get("client_version")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            });
            Ok(Some(jsonrpc_result(
                &id,
                &serialize_initialize_result(&result),
            )))
        }
        "org/list" => {
            let force_refresh = params
                .get("forceRefresh")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || params
                    .get("force_refresh")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            let payload = orgs_handler::handle_org_list(force_refresh)?;
            Ok(Some(jsonrpc_result(&id, &payload)))
        }
        "org/auth" => {
            let username = params
                .get("username")
                .and_then(Value::as_str)
                .map(str::to_string);
            let payload = orgs_handler::handle_org_auth(username.as_deref())?;
            Ok(Some(jsonrpc_result(&id, &payload)))
        }
        "logs/list" => {
            let cursor = params.get("cursor").cloned().unwrap_or(Value::Null);
            let payload = logs_handler::handle_logs_list(alv_core::logs::LogsListParams {
                username: params
                    .get("username")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                limit: params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .or_else(|| params.get("pageSize").and_then(Value::as_u64))
                    .or_else(|| params.get("page_size").and_then(Value::as_u64))
                    .map(|value| value as usize),
                cursor: alv_core::logs::LogsCursor {
                    before_start_time: cursor
                        .get("beforeStartTime")
                        .and_then(Value::as_str)
                        .or_else(|| cursor.get("before_start_time").and_then(Value::as_str))
                        .or_else(|| params.get("beforeStartTime").and_then(Value::as_str))
                        .or_else(|| params.get("before_start_time").and_then(Value::as_str))
                        .map(str::to_string),
                    before_id: cursor
                        .get("beforeId")
                        .and_then(Value::as_str)
                        .or_else(|| cursor.get("before_id").and_then(Value::as_str))
                        .or_else(|| params.get("beforeId").and_then(Value::as_str))
                        .or_else(|| params.get("before_id").and_then(Value::as_str))
                        .map(str::to_string),
                }
                .filter_active(),
                offset: params
                    .get("offset")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
            })?;
            Ok(Some(jsonrpc_result(&id, &payload)))
        }
        "search/query" => {
            let payload = logs_handler::handle_search_query(alv_core::search::SearchQueryParams {
                query: params
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                log_ids: string_vec_field(&params, "logIds")
                    .or_else(|| string_vec_field(&params, "log_ids"))
                    .unwrap_or_default(),
                workspace_root: params
                    .get("workspaceRoot")
                    .and_then(Value::as_str)
                    .or_else(|| params.get("workspace_root").and_then(Value::as_str))
                    .map(str::to_string),
            })?;
            Ok(Some(jsonrpc_result(&id, &payload)))
        }
        "logs/triage" => {
            let payload = logs_handler::handle_logs_triage(alv_core::triage::LogsTriageParams {
                log_ids: string_vec_field(&params, "logIds")
                    .or_else(|| string_vec_field(&params, "log_ids"))
                    .unwrap_or_default(),
                username: params
                    .get("username")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                workspace_root: params
                    .get("workspaceRoot")
                    .and_then(Value::as_str)
                    .or_else(|| params.get("workspace_root").and_then(Value::as_str))
                    .map(str::to_string),
            })?;
            Ok(Some(jsonrpc_result(&id, &payload)))
        }
        _ => Ok(Some(jsonrpc_error(
            &id,
            -32601,
            &format!("method not found: {method}"),
        ))),
    }
}

fn jsonrpc_result(id: &str, result_json: &str) -> String {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"{}\",\"result\":{result_json}}}",
        escape_json(id)
    )
}

fn jsonrpc_error(id: &str, code: i32, message: &str) -> String {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"{}\",\"error\":{{\"code\":{code},\"message\":\"{}\"}}}}",
        escape_json(id),
        escape_json(message)
    )
}

fn serialize_initialize_result(result: &InitializeResult) -> String {
    format!(
        "{{\"runtime_version\":\"{}\",\"protocol_version\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"capabilities\":{{\"orgs\":{},\"logs\":{},\"search\":{},\"tail\":{},\"debug_flags\":{},\"doctor\":{}}},\"state_dir\":\"{}\",\"cache_dir\":\"{}\"}}",
        escape_json(&result.runtime_version),
        escape_json(&result.protocol_version),
        escape_json(&result.platform),
        escape_json(&result.arch),
        result.capabilities.orgs,
        result.capabilities.logs,
        result.capabilities.search,
        result.capabilities.tail,
        result.capabilities.debug_flags,
        result.capabilities.doctor,
        escape_json(&result.state_dir),
        escape_json(&result.cache_dir)
    )
}

fn string_vec_field(source: &Value, field: &str) -> Option<Vec<String>> {
    source.get(field).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect()
    })
}

fn escape_json(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    escaped
}
