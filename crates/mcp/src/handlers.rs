use apex_log_viewer_cli::commands::logs_sync::{sync, LogsSyncArgs};
use apex_log_viewer_cli::output::{ErrorOutput, SyncOutput};
use serde_json::{json, Value};

use crate::protocol::{Request, Response};
use crate::tools::{list_tools, APEX_LOGS_SYNC_TOOL};

pub trait LogsSyncProvider {
  fn logs_sync(&self, limit: Option<u32>, target: Option<String>) -> Result<SyncOutput, ErrorOutput>;
}

pub struct CliLogsSync;

impl LogsSyncProvider for CliLogsSync {
  fn logs_sync(&self, limit: Option<u32>, target: Option<String>) -> Result<SyncOutput, ErrorOutput> {
    sync(LogsSyncArgs {
      limit: limit.unwrap_or(100),
      target,
    })
  }
}

pub fn handle_request(request: Request, provider: &impl LogsSyncProvider) -> Option<Response> {
  let id = request.id?;
  match request.method.as_str() {
    "initialize" => Some(Response::ok(
      id,
      json!({
        "protocolVersion": request.jsonrpc.unwrap_or_else(|| "2024-11-05".to_string()),
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "apex-log-viewer-mcp", "version": env!("CARGO_PKG_VERSION") }
      }),
    )),
    "tools/list" => Some(Response::ok(id, list_tools())),
    "tools/call" => Some(handle_tools_call(id, request.params, provider)),
    _ => Some(Response::error(id, -32601, "Method not found")),
  }
}

fn handle_tools_call(id: Value, params: Option<Value>, provider: &impl LogsSyncProvider) -> Response {
  let params = match params {
    Some(value) => value,
    None => return Response::error(id, -32602, "Missing params"),
  };
  let params_obj = match params.as_object() {
    Some(value) => value,
    None => return Response::error(id, -32602, "params must be an object"),
  };
  let name = match params_obj.get("name").and_then(Value::as_str) {
    Some(value) => value,
    None => return Response::error(id, -32602, "Missing tool name"),
  };
  if name != APEX_LOGS_SYNC_TOOL {
    return Response::error(id, -32601, "Unknown tool");
  }

  let args = params_obj
    .get("arguments")
    .and_then(Value::as_object)
    .cloned()
    .unwrap_or_default();

  let limit = match args.get("limit") {
    None => None,
    Some(value) => value.as_u64().map(|v| v as u32),
  };
  if args.get("limit").is_some() && limit.is_none() {
    return Response::error(id, -32602, "limit must be a number");
  }

  let target = match args.get("target") {
    None => None,
    Some(value) => value.as_str().map(|v| v.to_string()),
  };
  if args.get("target").is_some() && target.is_none() {
    return Response::error(id, -32602, "target must be a string");
  }

  match provider.logs_sync(limit, target) {
    Ok(output) => tool_result(id, &output, false),
    Err(err) => tool_result(id, &err, true),
  }
}

fn tool_result<T: serde::Serialize>(id: Value, payload: &T, is_error: bool) -> Response {
  let text = serde_json::to_string(payload).unwrap_or_else(|_| {
    "{\"ok\":false,\"errorCode\":\"SERIALIZE_FAILED\",\"message\":\"Failed to serialize output.\"}".to_string()
  });
  Response::ok(
    id,
    json!({
      "content": [{ "type": "text", "text": text }],
      "isError": is_error
    }),
  )
}
