use crate::{
    auth,
    log_store::{
        log_file_path_for_start_time, read_sync_state, safe_target_org, write_org_metadata,
        write_sync_state, write_version_file, OrgMetadata, SyncStateOrgEntry,
        LOG_STORE_LAYOUT_VERSION,
    },
    logs::{
        download_log_to_path_with_cancel, list_logs_with_cancel, CancellationToken, LogsCursor,
        LogsListParams,
    },
    orgs::list_orgs,
};
use serde::{Deserialize, Serialize};

const SYNC_PAGE_SIZE: usize = 200;
const CANCELLED_MESSAGE: &str = "request cancelled";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogsSyncParams {
    pub target_org: Option<String>,
    pub workspace_root: Option<String>,
    pub force_full: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogsSyncResult {
    pub status: String,
    pub target_org: String,
    pub safe_target_org: String,
    pub downloaded: usize,
    pub cached: usize,
    pub failed: usize,
    pub checkpoint_advanced: bool,
    pub state_file: String,
    pub last_synced_log_id: Option<String>,
}

pub fn sync_logs_with_cancel(
    params: &LogsSyncParams,
    cancellation: &CancellationToken,
) -> Result<LogsSyncResult, String> {
    cancellation.check_cancelled()?;
    write_version_file(params.workspace_root.as_deref(), LOG_STORE_LAYOUT_VERSION)?;
    let started_at = timestamp_now();

    let auth = auth::resolve_org_auth(params.target_org.as_deref())?;
    let resolved_username = auth
        .username
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let safe_org = safe_target_org(&resolved_username);
    let requested_alias = params
        .target_org
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != resolved_username && !value.contains('@'))
        .map(ToOwned::to_owned);
    let alias = list_orgs(false)
        .ok()
        .and_then(|orgs| {
            orgs.into_iter()
                .find(|org| org.username == resolved_username)
        })
        .and_then(|org| org.alias)
        .or(requested_alias);
    let previous = read_sync_state(params.workspace_root.as_deref())?
        .orgs
        .get(&resolved_username)
        .cloned();

    let mut state = read_sync_state(params.workspace_root.as_deref())?;
    let mut downloaded = 0usize;
    let mut cached = 0usize;
    let mut failed = 0usize;
    let mut newest: Option<(String, String)> = None;
    let mut cursor: Option<LogsCursor> = None;
    let mut reached_checkpoint = false;

    loop {
        let mut rows = match list_logs_with_cancel(
            &LogsListParams {
                username: params.target_org.clone(),
                limit: Some(SYNC_PAGE_SIZE),
                cursor: cursor.clone(),
                offset: Some(0),
            },
            cancellation,
        ) {
            Ok(rows) => rows,
            Err(error) if error == CANCELLED_MESSAGE || cancellation.is_cancelled() => break,
            Err(error) => return Err(error),
        };
        rows.sort_by(|left, right| {
            right
                .start_time
                .cmp(&left.start_time)
                .then_with(|| right.id.cmp(&left.id))
        });

        let page_len = rows.len();
        if page_len == 0 {
            break;
        }

        let next_cursor = rows.last().map(|row| LogsCursor {
            before_start_time: Some(row.start_time.clone()),
            before_id: Some(row.id.clone()),
        });

        for row in rows {
            let hit_checkpoint = !params.force_full
                && previous
                    .as_ref()
                    .is_some_and(|entry| row_matches_checkpoint(entry, &row));

            let target_path = log_file_path_for_start_time(
                params.workspace_root.as_deref(),
                &resolved_username,
                &row.start_time,
                &row.id,
            );
            if target_path.is_file() {
                cached += 1;
            } else if download_log_to_path_with_cancel(
                &row.id,
                Some(&resolved_username),
                &target_path,
                cancellation,
            )
            .is_ok()
            {
                downloaded += 1;
            } else {
                failed += 1;
                continue;
            }

            if newest.is_none() {
                newest = Some((row.id.clone(), row.start_time.clone()));
            }

            if hit_checkpoint {
                reached_checkpoint = true;
                break;
            }
        }

        if reached_checkpoint || cancellation.is_cancelled() || page_len < SYNC_PAGE_SIZE {
            break;
        }

        cursor = next_cursor.and_then(LogsCursor::filter_active);
        if cursor.is_none() {
            break;
        }
    }

    let partial = failed > 0 || cancellation.is_cancelled();
    let status = if cancellation.is_cancelled() {
        "cancelled".to_string()
    } else if partial {
        "partial".to_string()
    } else {
        "success".to_string()
    };
    let finished_at = timestamp_now();

    if status == "success" {
        let (last_synced_log_id, last_synced_start_time) = newest.clone().unwrap_or_else(|| {
            (
                previous
                    .as_ref()
                    .and_then(|entry| entry.last_synced_log_id.clone())
                    .unwrap_or_default(),
                previous
                    .as_ref()
                    .and_then(|entry| entry.last_synced_start_time.clone())
                    .unwrap_or_default(),
            )
        });
        state.orgs.insert(
            resolved_username.clone(),
            SyncStateOrgEntry {
                target_org: resolved_username.clone(),
                safe_target_org: safe_org.clone(),
                org_dir: format!("apexlogs/orgs/{safe_org}"),
                last_sync_started_at: Some(started_at.clone()),
                last_sync_completed_at: Some(finished_at.clone()),
                last_synced_log_id: if last_synced_log_id.is_empty() {
                    None
                } else {
                    Some(last_synced_log_id.clone())
                },
                last_synced_start_time: if last_synced_start_time.is_empty() {
                    None
                } else {
                    Some(last_synced_start_time.clone())
                },
                downloaded_count: downloaded,
                cached_count: cached,
                last_error: None,
            },
        );
        write_sync_state(params.workspace_root.as_deref(), &state)?;
    }

    write_org_metadata(
        params.workspace_root.as_deref(),
        &OrgMetadata {
            target_org: params
                .target_org
                .clone()
                .unwrap_or_else(|| resolved_username.clone()),
            safe_target_org: safe_org.clone(),
            resolved_username: resolved_username.clone(),
            alias,
            instance_url: Some(auth.instance_url),
            updated_at: finished_at.clone(),
        },
    )?;

    Ok(LogsSyncResult {
        status,
        target_org: resolved_username.clone(),
        safe_target_org: safe_org,
        downloaded,
        cached,
        failed,
        checkpoint_advanced: failed == 0 && !cancellation.is_cancelled(),
        state_file: crate::log_store::sync_state_path(params.workspace_root.as_deref())
            .display()
            .to_string(),
        last_synced_log_id: newest.map(|(log_id, _)| log_id),
    })
}

fn timestamp_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn row_matches_checkpoint(entry: &SyncStateOrgEntry, row: &crate::logs::LogRow) -> bool {
    if let Some(last_synced_log_id) = entry
        .last_synced_log_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return last_synced_log_id == row.id.as_str();
    }

    entry.last_synced_start_time.as_deref() == Some(row.start_time.as_str())
}

#[cfg(test)]
mod tests {
    use super::timestamp_now;

    #[test]
    fn timestamp_now_emits_rfc3339_like_utc_values() {
        let value = timestamp_now();
        assert!(value.contains('T'));
        assert!(value.ends_with('Z'));
    }
}
