use crate::auth::{get_auth, AuthError};
use crate::http::{fetch_log_body, query_apex_logs, HttpError};
use crate::output::{
  ErrorOutput, OrgSummary, SavedLog, SkippedLog, SyncError, SyncOutput,
};
use crate::sfdx_project::{find_project_root, read_source_api_version, ProjectError};
use clap::Parser;
use std::fs;
use std::path::PathBuf;

#[derive(Parser)]
pub struct LogsSyncArgs {
  #[arg(long, default_value_t = 100)]
  pub limit: u32,
  #[arg(long, short = 'o')]
  pub target: Option<String>,
}

pub fn make_log_filename(username: &str, log_id: &str) -> String {
  let trimmed = username.trim();
  let base = if trimmed.is_empty() { "default" } else { trimmed };
  let safe: String = base
    .chars()
    .map(|c| {
      if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | '-') {
        c
      } else {
        '_'
      }
    })
    .collect();
  format!("{safe}_{log_id}.log")
}

fn error_output(code: &str, message: &str, details: Option<String>) -> ErrorOutput {
  ErrorOutput {
    ok: false,
    error_code: code.to_string(),
    message: message.to_string(),
    details,
  }
}

fn serialize_error(err: ErrorOutput) -> String {
  let code = err.error_code.clone();
  let message = err.message.clone();
  serde_json::to_string(&err)
    .unwrap_or_else(|_| format!("{{\"ok\":false,\"errorCode\":\"{code}\",\"message\":\"{message}\"}}"))
}

fn map_project_error(err: ProjectError) -> ErrorOutput {
  match err {
    ProjectError::MissingProject => error_output(
      "NO_SFDX_PROJECT",
      "sfdx-project.json not found. Run inside a valid SFDX project.",
      None,
    ),
    ProjectError::InvalidJson => error_output(
      "INVALID_SFDX_PROJECT",
      "Invalid sfdx-project.json.",
      None,
    ),
    ProjectError::MissingApiVersion => error_output(
      "MISSING_API_VERSION",
      "sfdx-project.json is missing sourceApiVersion.",
      None,
    ),
  }
}

fn map_auth_error(err: AuthError) -> ErrorOutput {
  error_output("AUTH_FAILED", "Failed to retrieve Salesforce auth.", Some(err.to_string()))
}

fn map_http_error(err: HttpError) -> ErrorOutput {
  error_output("LOGS_QUERY_FAILED", "Failed to query Apex logs.", Some(err.to_string()))
}

fn map_io_error(err: std::io::Error) -> ErrorOutput {
  error_output("IO_ERROR", "Failed to write log file.", Some(err.to_string()))
}

fn ensure_apexlogs_dir() -> Result<PathBuf, ErrorOutput> {
  let cwd = std::env::current_dir()
    .map_err(|err| error_output("CWD_FAILED", "Failed to resolve current directory.", Some(err.to_string())))?;
  let dir = cwd.join("apexlogs");
  fs::create_dir_all(&dir).map_err(map_io_error)?;
  Ok(dir)
}

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
        Ok(()) => {
          saved.push(SavedLog {
            id: log_id,
            file: format!("apexlogs/{filename}"),
            size: body.len() as u64,
          });
        }
        Err(err) => {
          errors.push(SyncError {
            id: Some(log_id),
            message: err.to_string(),
          });
        }
      },
      Err(err) => {
        skipped.push(SkippedLog {
          id: log_id,
          reason: err.to_string(),
        });
      }
    }
  }

  let output = SyncOutput {
    ok: true,
    org: OrgSummary {
      username: auth.username.clone(),
      instance_url: auth.instance_url.clone(),
    },
    api_version,
    limit: safe_limit,
    saved_dir: "apexlogs".to_string(),
    logs,
    saved,
    skipped,
    errors,
  };
  Ok(output)
}

pub fn run(args: LogsSyncArgs) -> Result<(), String> {
  let output = sync(args).map_err(serialize_error)?;
  let json = serde_json::to_string(&output)
    .map_err(|err| serialize_error(error_output("SERIALIZE_FAILED", "Failed to serialize output.", Some(err.to_string()))))?;
  println!("{json}");
  Ok(())
}
