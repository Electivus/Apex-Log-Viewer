use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

pub const LOG_STORE_LAYOUT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SyncState {
    pub version: u32,
    pub orgs: BTreeMap<String, SyncStateOrgEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateOrgEntry {
    pub target_org: String,
    pub safe_target_org: String,
    pub org_dir: String,
    pub last_sync_started_at: Option<String>,
    pub last_sync_completed_at: Option<String>,
    pub last_synced_log_id: Option<String>,
    pub last_synced_start_time: Option<String>,
    pub downloaded_count: usize,
    pub cached_count: usize,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgMetadata {
    pub target_org: String,
    pub safe_target_org: String,
    pub resolved_username: String,
    pub alias: Option<String>,
    pub instance_url: Option<String>,
    pub updated_at: String,
}

pub fn resolve_apexlogs_root(workspace_root: Option<&str>) -> PathBuf {
    match workspace_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(root) => Path::new(root).join("apexlogs"),
        None => env::temp_dir().join("apexlogs"),
    }
}

pub fn safe_target_org(value: &str) -> String {
    let trimmed = value.trim();
    let safe = trimmed
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '.' | '@' | '-' => character,
            _ => '_',
        })
        .collect::<String>();

    if safe.is_empty() {
        "default".to_string()
    } else {
        safe
    }
}

pub fn version_file_path(workspace_root: Option<&str>) -> PathBuf {
    resolve_apexlogs_root(workspace_root)
        .join(".alv")
        .join("version.json")
}

pub fn sync_state_path(workspace_root: Option<&str>) -> PathBuf {
    resolve_apexlogs_root(workspace_root)
        .join(".alv")
        .join("sync-state.json")
}

pub fn org_dir(workspace_root: Option<&str>, raw_org: &str) -> PathBuf {
    resolve_apexlogs_root(workspace_root)
        .join("orgs")
        .join(safe_target_org(raw_org))
}

pub fn org_metadata_path(workspace_root: Option<&str>, raw_org: &str) -> PathBuf {
    org_dir(workspace_root, raw_org).join("org.json")
}

pub fn log_file_path_for_start_time(
    workspace_root: Option<&str>,
    raw_org: &str,
    start_time: &str,
    log_id: &str,
) -> PathBuf {
    let day = start_time
        .get(0..10)
        .filter(|value| value.len() == 10)
        .unwrap_or("unknown-date");

    org_dir(workspace_root, raw_org)
        .join("logs")
        .join(day)
        .join(format!("{log_id}.log"))
}

pub fn unknown_date_log_path(workspace_root: Option<&str>, raw_org: &str, log_id: &str) -> PathBuf {
    org_dir(workspace_root, raw_org)
        .join("logs")
        .join("unknown-date")
        .join(format!("{log_id}.log"))
}

pub fn write_version_file(workspace_root: Option<&str>, version: u32) -> Result<(), String> {
    let path = version_file_path(workspace_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    fs::write(
        &path,
        serde_json::to_vec_pretty(&version).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

pub fn read_version_file(workspace_root: Option<&str>) -> Result<u32, String> {
    let path = version_file_path(workspace_root);
    if !path.is_file() {
        return Ok(LOG_STORE_LAYOUT_VERSION);
    }

    serde_json::from_slice::<u32>(
        &fs::read(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))?,
    )
    .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

pub fn write_sync_state(workspace_root: Option<&str>, state: &SyncState) -> Result<(), String> {
    let path = sync_state_path(workspace_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    fs::write(
        &path,
        serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

pub fn read_sync_state(workspace_root: Option<&str>) -> Result<SyncState, String> {
    let path = sync_state_path(workspace_root);
    if !path.is_file() {
        return Ok(SyncState {
            version: LOG_STORE_LAYOUT_VERSION,
            orgs: BTreeMap::new(),
        });
    }

    serde_json::from_slice::<SyncState>(
        &fs::read(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))?,
    )
    .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

pub fn write_org_metadata(
    workspace_root: Option<&str>,
    metadata: &OrgMetadata,
) -> Result<(), String> {
    let path = org_metadata_path(workspace_root, &metadata.resolved_username);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    fs::write(
        &path,
        serde_json::to_vec_pretty(metadata).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

pub fn find_cached_log_path(
    workspace_root: Option<&str>,
    log_id: &str,
    resolved_username: Option<&str>,
) -> Option<PathBuf> {
    if log_id.trim().is_empty() {
        return None;
    }

    let root = resolve_apexlogs_root(workspace_root);

    if let Some(username) = resolved_username.filter(|value| !value.trim().is_empty()) {
        let scoped_root = org_dir(workspace_root, username).join("logs");
        if let Some(found) = find_log_in_logs_dir(&scoped_root, log_id) {
            return Some(found);
        }

        let safe_username = safe_target_org(username);
        for candidate in [
            root.join(format!("{safe_username}_{log_id}.log")),
            root.join(format!("{log_id}.log")),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }

        return None;
    }

    let orgs_root = root.join("orgs");
    if let Some(found) = find_log_in_orgs_root(&orgs_root, log_id) {
        return Some(found);
    }

    let entries = fs::read_dir(&root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name()?.to_string_lossy();
        if file_name == format!("{log_id}.log") || file_name.ends_with(&format!("_{log_id}.log")) {
            return Some(path);
        }
    }

    None
}

fn find_log_in_logs_dir(logs_root: &Path, log_id: &str) -> Option<PathBuf> {
    if !logs_root.is_dir() {
        return None;
    }

    for entry in fs::read_dir(logs_root).ok()?.flatten() {
        let day_dir = entry.path();
        if !day_dir.is_dir() {
            continue;
        }

        let candidate = day_dir.join(format!("{log_id}.log"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn find_log_in_orgs_root(orgs_root: &Path, log_id: &str) -> Option<PathBuf> {
    if !orgs_root.is_dir() {
        return None;
    }

    for entry in fs::read_dir(orgs_root).ok()?.flatten() {
        let found = find_log_in_logs_dir(&entry.path().join("logs"), log_id);
        if found.is_some() {
            return found;
        }
    }

    None
}
