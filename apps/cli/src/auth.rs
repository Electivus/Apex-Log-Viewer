use serde_json::Value;
use std::process::Command;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
  #[error("invalid auth json")]
  InvalidJson,
  #[error("missing auth fields")]
  MissingFields,
  #[error("command failed: {0}")]
  CommandFailed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgAuth {
  pub access_token: String,
  pub instance_url: String,
  pub username: Option<String>,
}

fn read_string(value: &Value, keys: &[&str]) -> Option<String> {
  for key in keys {
    if let Some(found) = value.get(*key).and_then(|v| v.as_str()) {
      return Some(found.to_string());
    }
  }
  None
}

pub fn parse_auth_json(input: &str) -> Result<OrgAuth, AuthError> {
  let value: Value = serde_json::from_str(input).map_err(|_| AuthError::InvalidJson)?;
  let result = value.get("result").unwrap_or(&value);
  if !result.is_object() {
    return Err(AuthError::InvalidJson);
  }

  let access_token = read_string(result, &["accessToken", "access_token"]).ok_or(AuthError::MissingFields)?;
  let instance_url =
    read_string(result, &["instanceUrl", "instance_url", "loginUrl"]).ok_or(AuthError::MissingFields)?;
  let username = read_string(result, &["username"]);

  Ok(OrgAuth {
    access_token,
    instance_url,
    username,
  })
}

fn build_sf_args(target: Option<&str>) -> Vec<String> {
  let mut args = vec![
    "org".to_string(),
    "display".to_string(),
    "--json".to_string(),
    "--verbose".to_string(),
  ];
  if let Some(value) = target {
    args.push("-o".to_string());
    args.push(value.to_string());
  }
  args
}

fn build_sfdx_args(target: Option<&str>) -> Vec<String> {
  let mut args = vec!["force:org:display".to_string(), "--json".to_string()];
  if let Some(value) = target {
    args.push("-u".to_string());
    args.push(value.to_string());
  }
  args
}

pub fn get_auth_with_runner<F>(target: Option<&str>, mut runner: F) -> Result<OrgAuth, AuthError>
where
  F: FnMut(&str, &[String]) -> Result<String, AuthError>,
{
  let sf_args = build_sf_args(target);
  let sf_error = match runner("sf", &sf_args) {
    Ok(output) => match parse_auth_json(&output) {
      Ok(auth) => return Ok(auth),
      Err(err) => Some(err),
    },
    Err(err) => Some(err),
  };

  let sfdx_args = build_sfdx_args(target);
  match runner("sfdx", &sfdx_args) {
    Ok(output) => parse_auth_json(&output),
    Err(err) => Err(sf_error.unwrap_or(err)),
  }
}

fn run_command(program: &str, args: &[String]) -> Result<String, AuthError> {
  let output = Command::new(program)
    .args(args)
    .output()
    .map_err(|err| AuthError::CommandFailed(format!("{program}: {err}")))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    return Err(AuthError::CommandFailed(format!(
      "{program} exited {status}: {stderr}",
      status = output.status
    )));
  }

  String::from_utf8(output.stdout)
    .map_err(|err| AuthError::CommandFailed(format!("{program} stdout: {err}")))
}

pub fn get_auth(target: Option<&str>) -> Result<OrgAuth, AuthError> {
  get_auth_with_runner(target, run_command)
}
