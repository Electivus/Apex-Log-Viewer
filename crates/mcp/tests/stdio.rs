use apex_log_viewer_cli::output::{ErrorOutput, SyncOutput};
use apex_log_viewer_mcp::handlers::LogsSyncProvider;
use apex_log_viewer_mcp::stdio::handle_line;

struct FakeLogsSync;

impl LogsSyncProvider for FakeLogsSync {
  fn logs_sync(&self, _limit: Option<u32>, _target: Option<String>) -> Result<SyncOutput, ErrorOutput> {
    Err(ErrorOutput {
      ok: false,
      error_code: "TEST".to_string(),
      message: "test".to_string(),
      details: None,
    })
  }
}

#[test]
fn handle_line_returns_parse_error_response() {
  let response = handle_line("{not json}", &FakeLogsSync).expect("response");
  let value: serde_json::Value = serde_json::from_str(&response).expect("json");
  assert_eq!(value["error"]["code"], -32700);
}
