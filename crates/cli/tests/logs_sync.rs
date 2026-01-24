use apex_log_viewer_cli::commands::logs_sync::make_log_filename;
use apex_log_viewer_cli::output::{ApexLogSummary, ApexLogUser, OrgSummary, SavedLog, SyncOutput};

#[test]
fn make_log_filename_sanitizes_username() {
  let name = make_log_filename("User Name/Team", "07Lxx0000000001");
  assert_eq!(name, "User_Name_Team_07Lxx0000000001.log");
}

#[test]
fn sync_output_serializes_expected_shape() {
  let output = SyncOutput {
    ok: true,
    org: OrgSummary {
      username: Some("user@example.com".to_string()),
      instance_url: "https://example.my.salesforce.com".to_string(),
    },
    api_version: "64.0".to_string(),
    limit: 100,
    saved_dir: "apexlogs".to_string(),
    logs: vec![ApexLogSummary {
      id: "07Lxx0000000001".to_string(),
      start_time: "2025-01-01T00:00:00.000+0000".to_string(),
      operation: "EXECUTION".to_string(),
      application: "Apex".to_string(),
      duration_milliseconds: 42,
      status: "Success".to_string(),
      request: "API".to_string(),
      log_length: 1234,
      log_user: Some(ApexLogUser {
        name: Some("User Name".to_string()),
      }),
    }],
    saved: vec![SavedLog {
      id: "07Lxx0000000001".to_string(),
      file: "apexlogs/user_07Lxx0000000001.log".to_string(),
      size: 1234,
    }],
    skipped: vec![],
    errors: vec![],
  };

  let value = serde_json::to_value(output).expect("serialize output");
  assert_eq!(value["ok"], true);
  assert_eq!(value["apiVersion"], "64.0");
  assert_eq!(value["savedDir"], "apexlogs");
  assert_eq!(value["saved"][0]["id"], "07Lxx0000000001");
  assert_eq!(value["org"]["instanceUrl"], "https://example.my.salesforce.com");
  assert_eq!(value["logs"][0]["Id"], "07Lxx0000000001");
  assert_eq!(value["logs"][0]["LogLength"], 1234);
  assert_eq!(value["logs"][0]["LogUser"]["Name"], "User Name");
}
