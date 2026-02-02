use apex_log_viewer_cli::output::{ErrorOutput, OrgSummary, SyncOutput};
use apex_log_viewer_mcp::handlers::{handle_request, LogsSyncProvider};
use apex_log_viewer_mcp::protocol::Request;
use serde_json::json;

struct FakeLogsSync;

impl LogsSyncProvider for FakeLogsSync {
  fn logs_sync(&self, _limit: Option<u32>, _target: Option<String>) -> Result<SyncOutput, ErrorOutput> {
    Ok(sample_output())
  }
}

fn sample_output() -> SyncOutput {
  SyncOutput {
    ok: true,
    org: OrgSummary {
      username: Some("user@example.com".to_string()),
      instance_url: "https://example.my.salesforce.com".to_string(),
    },
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
  let req = Request {
    jsonrpc: Some("2.0".to_string()),
    id: Some(json!(1)),
    method: "tools/list".to_string(),
    params: None,
  };
  let res = handle_request(req, &FakeLogsSync).expect("response");
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
  let res = handle_request(req, &FakeLogsSync).expect("response");
  let value = serde_json::to_value(res).expect("serialize");
  assert_eq!(value["result"]["isError"], false);
  let text = value["result"]["content"][0]["text"].as_str().expect("text");
  let payload: serde_json::Value = serde_json::from_str(text).expect("json payload");
  assert_eq!(payload["ok"], true);
}
