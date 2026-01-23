use crate::auth::OrgAuth;
use crate::output::ApexLogSummary;
use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum HttpError {
  #[error("request failed: {0}")]
  RequestFailed(String),
  #[error("response decode failed")]
  DecodeFailed,
}

#[derive(Debug, Deserialize)]
struct QueryResponse {
  records: Vec<ApexLogSummary>,
}

pub fn build_logs_query(limit: u32) -> String {
  let safe_limit = limit.max(1).min(200);
  format!(
    "SELECT Id, StartTime, Operation, Application, DurationMilliseconds, Status, Request, LogLength, LogUser.Name FROM ApexLog ORDER BY StartTime DESC, Id DESC LIMIT {safe_limit}"
  )
}

pub fn build_query_url(instance_url: &str, api_version: &str, soql: &str) -> String {
  let base = instance_url.trim_end_matches('/');
  let encoded = urlencoding::encode(soql);
  format!("{base}/services/data/v{api_version}/tooling/query?q={encoded}")
}

pub fn query_apex_logs(
  auth: &OrgAuth,
  api_version: &str,
  limit: u32,
) -> Result<Vec<ApexLogSummary>, HttpError> {
  let soql = build_logs_query(limit);
  let url = build_query_url(&auth.instance_url, api_version, &soql);
  let client = reqwest::blocking::Client::new();
  let response = client
    .get(url)
    .bearer_auth(&auth.access_token)
    .send()
    .map_err(|err| HttpError::RequestFailed(err.to_string()))?;

  if !response.status().is_success() {
    return Err(HttpError::RequestFailed(response.status().to_string()));
  }

  let parsed: QueryResponse = response
    .json()
    .map_err(|_| HttpError::DecodeFailed)?;
  Ok(parsed.records)
}

pub fn fetch_log_body(
  auth: &OrgAuth,
  api_version: &str,
  log_id: &str,
) -> Result<String, HttpError> {
  let base = auth.instance_url.trim_end_matches('/');
  let url = format!(
    "{base}/services/data/v{api_version}/tooling/sobjects/ApexLog/{log_id}/Body"
  );
  let client = reqwest::blocking::Client::new();
  let response = client
    .get(url)
    .bearer_auth(&auth.access_token)
    .send()
    .map_err(|err| HttpError::RequestFailed(err.to_string()))?;

  if !response.status().is_success() {
    return Err(HttpError::RequestFailed(response.status().to_string()));
  }

  response.text().map_err(|err| HttpError::RequestFailed(err.to_string()))
}
