# MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Rust MCP server binary that exposes an `apex_logs_sync` tool by calling the existing CLI logic directly.

**Architecture:** Refactor `crates/cli` to expose a pure `logs_sync` API returning `SyncOutput`/`ErrorOutput`, then add a new `crates/mcp` binary that implements MCP JSON-RPC over stdio with `initialize`, `tools/list`, and `tools/call`.

**Tech Stack:** Rust 2021, serde/serde_json, existing CLI crate.

### Task 1: Expose CLI Logs Sync as a Pure API

**Files:**
- Modify: `crates/cli/src/commands/logs_sync.rs`
- Modify: `crates/cli/tests/logs_sync.rs`

**Step 1: Write the failing test**

```rust
use apex_log_viewer_cli::commands::logs_sync::{sync, LogsSyncArgs};
use std::path::PathBuf;
use tempfile::tempdir;

struct DirGuard(PathBuf);

impl Drop for DirGuard {
  fn drop(&mut self) {
    let _ = std::env::set_current_dir(&self.0);
  }
}

#[test]
fn logs_sync_returns_error_output_when_missing_project() {
  let temp = tempdir().expect("tempdir");
  let prev = std::env::current_dir().expect("cwd");
  let _guard = DirGuard(prev);

  std::env::set_current_dir(temp.path()).expect("set cwd");

  let err = sync(LogsSyncArgs { limit: 1, target: None }).expect_err("expected error");
  assert!(!err.ok);
  assert_eq!(err.error_code, "NO_SFDX_PROJECT");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p apex-log-viewer-cli logs_sync_returns_error_output_when_missing_project`

Expected: compile error (missing `sync`) or test failure.

**Step 3: Write minimal implementation**

```rust
pub fn sync(args: LogsSyncArgs) -> Result<SyncOutput, ErrorOutput> {
  let cwd = std::env::current_dir()
    .map_err(|err| error_output("CWD_FAILED", "Failed to resolve current directory.", Some(err.to_string())))?;
  let project_root = find_project_root(&cwd).ok_or_else(|| {
    error_output(
      "NO_SFDX_PROJECT",
      "sfdx-project.json not found. Run inside a valid SFDX project.",
      None,
    )
  })?;
  let api_version = read_source_api_version(&project_root).map_err(map_project_error)?;

  let auth = get_auth(args.target.as_deref()).map_err(map_auth_error)?;
  let safe_limit = args.limit.max(1).min(200);
  let logs = query_apex_logs(&auth, &api_version, safe_limit).map_err(map_http_error)?;
  let dir = ensure_apexlogs_dir()?;

  let mut saved: Vec<SavedLog> = Vec::new();
  let mut skipped: Vec<SkippedLog> = Vec::new();
  let mut errors: Vec<SyncError> = Vec::new();

  for log in &logs {
    let log_id = log.id.clone();
    let username = auth.username.as_deref().unwrap_or("default");
    let filename = make_log_filename(username, &log_id);
    let path = dir.join(&filename);
    match fetch_log_body(&auth, &api_version, &log_id) {
      Ok(body) => match fs::write(&path, body.as_bytes()) {
        Ok(()) => saved.push(SavedLog { id: log_id, file: format!("apexlogs/{filename}"), size: body.len() as u64 }),
        Err(err) => errors.push(SyncError { id: Some(log_id), message: err.to_string() }),
      },
      Err(err) => skipped.push(SkippedLog { id: log_id, reason: err.to_string() }),
    }
  }

  Ok(SyncOutput {
    ok: true,
    org: OrgSummary { username: auth.username.clone(), instance_url: auth.instance_url.clone() },
    api_version,
    limit: safe_limit,
    saved_dir: "apexlogs".to_string(),
    logs,
    saved,
    skipped,
    errors,
  })
}

pub fn run(args: LogsSyncArgs) -> Result<(), String> {
  let output = sync(args).map_err(serialize_error)?;
  let json = serde_json::to_string(&output)
    .map_err(|err| serialize_error(error_output("SERIALIZE_FAILED", "Failed to serialize output.", Some(err.to_string()))))?;
  println!("{json}");
  Ok(())
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p apex-log-viewer-cli`

Expected: PASS

**Step 5: Commit**

```bash
git add crates/cli/src/commands/logs_sync.rs crates/cli/tests/logs_sync.rs
git commit -m "feat(cli): expose logs sync api"
```

### Task 2: Add MCP Crate with Tool Handler (TDD)

**Files:**
- Modify: `Cargo.toml`
- Create: `crates/mcp/Cargo.toml`
- Create: `crates/mcp/src/lib.rs`
- Create: `crates/mcp/src/protocol.rs`
- Create: `crates/mcp/src/tools.rs`
- Create: `crates/mcp/src/handlers.rs`
- Create: `crates/mcp/tests/handlers.rs`

**Step 1: Write the failing tests**

```rust
use apex_log_viewer_cli::output::{ErrorOutput, OrgSummary, SyncOutput};
use apex_log_viewer_mcp::handlers::{handle_request, LogsSyncProvider};
use apex_log_viewer_mcp::protocol::Request;
use serde_json::json;

struct FakeLogsSync {
  result: Result<SyncOutput, ErrorOutput>,
}

impl LogsSyncProvider for FakeLogsSync {
  fn logs_sync(&self, _limit: Option<u32>, _target: Option<String>) -> Result<SyncOutput, ErrorOutput> {
    self.result.clone()
  }
}

fn sample_output() -> SyncOutput {
  SyncOutput {
    ok: true,
    org: OrgSummary { username: Some("user@example.com".to_string()), instance_url: "https://example.my.salesforce.com".to_string() },
    api_version: "64.0".to_string(),
    limit: 1,
    saved_dir: "apexlogs".to_string(),
    logs: vec![],
    saved: vec![],
    skipped: vec![],
    errors: vec![],
  }
}

#[test]
fn tools_list_includes_apex_logs_sync() {
  let req = Request { jsonrpc: Some("2.0".to_string()), id: Some(json!(1)), method: "tools/list".to_string(), params: None };
  let res = handle_request(req, &FakeLogsSync { result: Ok(sample_output()) }).expect("response");
  let value = serde_json::to_value(res).expect("serialize");
  assert_eq!(value["result"]["tools"][0]["name"], "apex_logs_sync");
}

#[test]
fn tools_call_returns_sync_output_text() {
  let req = Request {
    jsonrpc: Some("2.0".to_string()),
    id: Some(json!(2)),
    method: "tools/call".to_string(),
    params: Some(json!({ "name": "apex_logs_sync", "arguments": { "limit": 1 } })),
  };
  let res = handle_request(req, &FakeLogsSync { result: Ok(sample_output()) }).expect("response");
  let value = serde_json::to_value(res).expect("serialize");
  assert_eq!(value["result"]["isError"], false);
  let text = value["result"]["content"][0]["text"].as_str().expect("text");
  let payload: serde_json::Value = serde_json::from_str(text).expect("json payload");
  assert_eq!(payload["ok"], true);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p apex-log-viewer-mcp`

Expected: compile failure (crate or symbols missing).

**Step 3: Implement minimal MCP crate**

`Cargo.toml` (root):

```toml
[workspace]
members = ["crates/cli", "crates/mcp"]
resolver = "2"
```

`crates/mcp/Cargo.toml`:

```toml
[package]
name = "apex-log-viewer-mcp"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "apex-log-viewer-mcp"
path = "src/main.rs"

[dependencies]
apex-log-viewer-cli = { path = "../cli" }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
```

`crates/mcp/src/lib.rs`:

```rust
pub mod handlers;
pub mod protocol;
pub mod tools;
```

`crates/mcp/src/protocol.rs`:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct Request {
  pub jsonrpc: Option<String>,
  pub id: Option<Value>,
  pub method: String,
  pub params: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct RpcError {
  pub code: i64,
  pub message: String,
}

#[derive(Debug, Serialize)]
pub struct Response {
  pub jsonrpc: &'static str,
  pub id: Value,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub result: Option<Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<RpcError>,
}

impl Response {
  pub fn ok(id: Value, result: Value) -> Self {
    Self { jsonrpc: "2.0", id, result: Some(result), error: None }
  }

  pub fn error(id: Value, code: i64, message: impl Into<String>) -> Self {
    Self { jsonrpc: "2.0", id, result: None, error: Some(RpcError { code, message: message.into() }) }
  }
}
```

`crates/mcp/src/tools.rs`:

```rust
use serde_json::json;

pub const APEX_LOGS_SYNC_TOOL: &str = "apex_logs_sync";

pub fn list_tools() -> serde_json::Value {
  json!({
    "tools": [
      {
        "name": APEX_LOGS_SYNC_TOOL,
        "title": "Sync Apex Logs",
        "description": "Sync Apex logs to the local apexlogs directory.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": { "type": "number", "description": "Max logs to fetch (1-200).", "minimum": 1, "maximum": 200 },
            "target": { "type": "string", "description": "Org username or alias." }
          }
        }
      }
    ],
    "nextCursor": null
  })
}
```

`crates/mcp/src/handlers.rs`:

```rust
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
    sync(LogsSyncArgs { limit: limit.unwrap_or(100), target })
  }
}

pub fn handle_request(request: Request, provider: &impl LogsSyncProvider) -> Option<Response> {
  let id = request.id.unwrap_or(Value::Null);
  if request.id.is_none() {
    return None;
  }

  match request.method.as_str() {
    "initialize" => Some(Response::ok(id, json!({
      "protocolVersion": request.jsonrpc.clone().unwrap_or_else(|| "2024-11-05".to_string()),
      "capabilities": { "tools": { "listChanged": false } },
      "serverInfo": { "name": "apex-log-viewer-mcp", "version": env!("CARGO_PKG_VERSION") }
    }))),
    "tools/list" => Some(Response::ok(id, list_tools())),
    "tools/call" => Some(handle_tools_call(id, request.params, provider)),
    _ => Some(Response::error(id, -32601, "Method not found")),
  }
}

fn handle_tools_call(id: Value, params: Option<Value>, provider: &impl LogsSyncProvider) -> Response {
  let params = params.unwrap_or_else(|| json!({}));
  let name = params.get("name").and_then(Value::as_str).unwrap_or("");
  if name != APEX_LOGS_SYNC_TOOL {
    return Response::error(id, -32601, "Unknown tool");
  }
  let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
  let args_obj = args.as_object().ok_or_else(|| Response::error(id.clone(), -32602, "arguments must be object"));
  let args_obj = match args_obj {
    Ok(v) => v,
    Err(err) => return err,
  };

  let limit = match args_obj.get("limit") {
    None => None,
    Some(value) => value.as_u64().map(|v| v as u32).or_else(|| Some(0)).filter(|v| *v > 0),
  };
  if args_obj.get("limit").is_some() && limit.is_none() {
    return Response::error(id, -32602, "limit must be a positive number");
  }

  let target = match args_obj.get("target") {
    None => None,
    Some(value) => value.as_str().map(|v| v.to_string()),
  };
  if args_obj.get("target").is_some() && target.is_none() {
    return Response::error(id, -32602, "target must be a string");
  }

  match provider.logs_sync(limit, target) {
    Ok(output) => tool_result(id, &output, false),
    Err(err) => tool_result(id, &err, true),
  }
}

fn tool_result<T: serde::Serialize>(id: Value, payload: &T, is_error: bool) -> Response {
  let text = serde_json::to_string(payload).unwrap_or_else(|_| "{\"ok\":false,\"errorCode\":\"SERIALIZE_FAILED\",\"message\":\"Failed to serialize output.\"}".to_string());
  Response::ok(id, json!({
    "content": [{ "type": "text", "text": text }],
    "isError": is_error,
  }))
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p apex-log-viewer-mcp`

Expected: PASS

**Step 5: Commit**

```bash
git add Cargo.toml crates/mcp

git commit -m "feat(mcp): add tool handler and protocol"
```

### Task 3: Add MCP Stdio Server + Changelog

**Files:**
- Create: `crates/mcp/src/main.rs`
- Modify: `CHANGELOG.md`

**Step 1: Implement stdio main**

```rust
use std::io::{self, BufRead, Write};

use apex_log_viewer_mcp::handlers::{handle_request, CliLogsSync};
use apex_log_viewer_mcp::protocol::Response;
use serde_json::Value;

fn main() {
  let stdin = io::stdin();
  let mut stdout = io::stdout();
  let provider = CliLogsSync;

  for line in stdin.lock().lines() {
    let line = match line {
      Ok(line) => line,
      Err(_) => continue,
    };
    if line.trim().is_empty() {
      continue;
    }

    match serde_json::from_str(&line) {
      Ok(request) => {
        if let Some(response) = handle_request(request, &provider) {
          if let Ok(json) = serde_json::to_string(&response) {
            let _ = writeln!(stdout, "{json}");
            let _ = stdout.flush();
          }
        }
      }
      Err(err) => {
        let response = Response::error(Value::Null, -32700, format!("Parse error: {err}"));
        if let Ok(json) = serde_json::to_string(&response) {
          let _ = writeln!(stdout, "{json}");
          let _ = stdout.flush();
        }
      }
    }
  }
}
```

**Step 2: Update changelog**

Add under **Unreleased → Features** in `CHANGELOG.md`:

```markdown
- MCP: add `apex-log-viewer-mcp` server exposing the `apex_logs_sync` tool.
```

**Step 3: Run tests/build**

Run:
- `cargo test -p apex-log-viewer-cli`
- `cargo test -p apex-log-viewer-mcp`

Expected: PASS

**Step 4: Commit**

```bash
git add crates/mcp/src/main.rs CHANGELOG.md Cargo.lock

git commit -m "feat(mcp): add stdio server binary"
```
