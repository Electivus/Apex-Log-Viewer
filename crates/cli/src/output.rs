use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutput {
  pub ok: bool,
  pub org: OrgSummary,
  pub api_version: String,
  pub limit: u32,
  pub saved_dir: String,
  pub logs: Vec<ApexLogSummary>,
  pub saved: Vec<SavedLog>,
  pub skipped: Vec<SkippedLog>,
  pub errors: Vec<SyncError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgSummary {
  pub username: Option<String>,
  pub instance_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApexLogSummary {
  #[serde(rename = "Id")]
  pub id: String,
  #[serde(rename = "StartTime")]
  pub start_time: String,
  #[serde(rename = "Operation")]
  pub operation: String,
  #[serde(rename = "Application")]
  pub application: String,
  #[serde(rename = "DurationMilliseconds")]
  pub duration_milliseconds: i64,
  #[serde(rename = "Status")]
  pub status: String,
  #[serde(rename = "Request")]
  pub request: String,
  #[serde(rename = "LogLength")]
  pub log_length: i64,
  #[serde(rename = "LogUser")]
  pub log_user: Option<ApexLogUser>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApexLogUser {
  #[serde(rename = "Name")]
  pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedLog {
  pub id: String,
  pub file: String,
  pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedLog {
  pub id: String,
  pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
  pub id: Option<String>,
  pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorOutput {
  pub ok: bool,
  pub error_code: String,
  pub message: String,
  pub details: Option<String>,
}
