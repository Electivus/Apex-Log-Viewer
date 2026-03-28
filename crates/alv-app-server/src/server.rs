use alv_protocol::messages::{InitializeParams, InitializeResult, RuntimeCapabilities};
use std::io::{self, BufRead, Write};

use crate::transport_stdio::bounded_transport_channel;

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

        if let Some(response) = handle_request(&line)? {
            stdout
                .write_all(response.as_bytes())
                .map_err(|error| error.to_string())?;
            stdout.write_all(b"\n").map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn handle_request(request: &str) -> Result<Option<String>, String> {
    let method = extract_string_field(request, "method").ok_or_else(|| "missing method".to_string())?;

    if method == "cancel" {
        return Ok(None);
    }

    let id = extract_string_field(request, "id").ok_or_else(|| "missing request id".to_string())?;

    match method.as_str() {
        "initialize" => {
            let result = handle_initialize(InitializeParams {
                client_name: extract_string_field(request, "client_name").unwrap_or_default(),
                client_version: extract_string_field(request, "client_version").unwrap_or_default(),
            });
            Ok(Some(jsonrpc_result(&id, &serialize_initialize_result(&result))))
        }
        "org/list" => {
            let force_refresh = extract_bool_field(request, "forceRefresh").unwrap_or(false)
                || extract_bool_field(request, "force_refresh").unwrap_or(false);
            let payload = orgs_handler::handle_org_list(force_refresh)?;
            Ok(Some(jsonrpc_result(&id, &payload)))
        }
        "org/auth" => {
            let username = extract_string_field(request, "username");
            let payload = orgs_handler::handle_org_auth(username.as_deref())?;
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
    format!("{{\"jsonrpc\":\"2.0\",\"id\":\"{}\",\"result\":{result_json}}}", escape_json(id))
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

fn extract_string_field(source: &str, field: &str) -> Option<String> {
    let field_marker = format!("\"{field}\"");
    let field_start = source.find(&field_marker)?;
    let after_field = &source[field_start + field_marker.len()..];
    let colon_index = after_field.find(':')?;
    let after_colon = after_field[colon_index + 1..].trim_start();
    let mut characters = after_colon.chars();

    if characters.next()? != '"' {
        return None;
    }

    let mut escaped = false;
    let mut value = String::new();
    for character in characters {
        if escaped {
            value.push(match character {
                '"' => '"',
                '\\' => '\\',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
            continue;
        }

        match character {
            '\\' => escaped = true,
            '"' => return Some(value),
            other => value.push(other),
        }
    }

    None
}

fn extract_bool_field(source: &str, field: &str) -> Option<bool> {
    let field_marker = format!("\"{field}\"");
    let field_start = source.find(&field_marker)?;
    let after_field = &source[field_start + field_marker.len()..];
    let colon_index = after_field.find(':')?;
    let after_colon = after_field[colon_index + 1..].trim_start();

    if after_colon.starts_with("true") {
        return Some(true);
    }

    if after_colon.starts_with("false") {
        return Some(false);
    }

    None
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
