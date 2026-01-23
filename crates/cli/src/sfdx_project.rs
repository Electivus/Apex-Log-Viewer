use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProjectError {
  #[error("sfdx-project.json not found")]
  MissingProject,
  #[error("invalid sfdx-project.json")]
  InvalidJson,
  #[error("missing sourceApiVersion")]
  MissingApiVersion,
}

pub fn find_project_root(start: &Path) -> Option<PathBuf> {
  let mut current = if start.is_file() {
    start.parent()?.to_path_buf()
  } else {
    start.to_path_buf()
  };

  loop {
    if current.join("sfdx-project.json").is_file() {
      return Some(current);
    }
    if !current.pop() {
      break;
    }
  }

  None
}

fn is_valid_api_version(value: &str) -> bool {
  let mut parts = value.split('.');
  match (parts.next(), parts.next(), parts.next()) {
    (Some(major), Some(minor), None) => {
      !major.is_empty()
        && !minor.is_empty()
        && major.chars().all(|c| c.is_ascii_digit())
        && minor.chars().all(|c| c.is_ascii_digit())
    }
    _ => false,
  }
}

pub fn read_source_api_version(project_root: &Path) -> Result<String, ProjectError> {
  let path = project_root.join("sfdx-project.json");
  let content = fs::read_to_string(&path).map_err(|_| ProjectError::MissingProject)?;
  let value: Value = serde_json::from_str(&content).map_err(|_| ProjectError::InvalidJson)?;
  let version = value
    .get("sourceApiVersion")
    .and_then(|v| v.as_str())
    .ok_or(ProjectError::MissingApiVersion)?;

  if !is_valid_api_version(version) {
    return Err(ProjectError::InvalidJson);
  }

  Ok(version.to_string())
}
