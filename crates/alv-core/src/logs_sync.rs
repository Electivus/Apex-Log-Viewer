use crate::{
    auth,
    auth::OrgAuth,
    log_store::{
        log_file_path_for_start_time, read_sync_state, safe_target_org, write_org_metadata,
        write_sync_state, write_version_file, OrgMetadata, SyncStateOrgEntry,
        LOG_STORE_LAYOUT_VERSION,
    },
    logs::{
        download_log_to_path_for_auth_with_cancel, list_logs_for_auth_detailed_with_cancel,
        CancellationToken, LogRow, LogsCursor, LogsListParams, LogsRuntimeError,
    },
    orgs::list_orgs,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, VecDeque},
    sync::{mpsc, Arc, Mutex},
    thread,
};

const SYNC_PAGE_SIZE: usize = 200;
const CANCELLED_MESSAGE: &str = "request cancelled";
const DEFAULT_SYNC_CONCURRENCY: usize = 6;
const MAX_SYNC_CONCURRENCY: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogsSyncParams {
    pub target_org: Option<String>,
    pub workspace_root: Option<String>,
    pub force_full: bool,
    pub concurrency: Option<usize>,
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
    sync_logs_detailed_with_cancel(params, cancellation).map_err(|error| error.to_string())
}

pub fn sync_logs_detailed_with_cancel(
    params: &LogsSyncParams,
    cancellation: &CancellationToken,
) -> Result<LogsSyncResult, LogsRuntimeError> {
    cancellation
        .check_cancelled()
        .map_err(LogsRuntimeError::from_message)?;
    write_version_file(params.workspace_root.as_deref(), LOG_STORE_LAYOUT_VERSION)
        .map_err(LogsRuntimeError::from_message)?;
    let started_at = timestamp_now();

    let auth = auth::resolve_org_auth(params.target_org.as_deref())
        .map_err(LogsRuntimeError::from_message)?;
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
    let previous = read_sync_state(params.workspace_root.as_deref())
        .map_err(LogsRuntimeError::from_message)?
        .orgs
        .get(&resolved_username)
        .cloned();

    let mut state = read_sync_state(params.workspace_root.as_deref())
        .map_err(LogsRuntimeError::from_message)?;
    let mut downloaded = 0usize;
    let mut cached = 0usize;
    let mut failed = 0usize;
    let mut newest: Option<(String, String)> = None;
    let mut cursor: Option<LogsCursor> = None;
    let sync_concurrency = normalize_sync_concurrency(params.concurrency);

    loop {
        let mut rows = match list_logs_for_auth_detailed_with_cancel(
            &auth,
            &LogsListParams {
                username: params.target_org.clone(),
                limit: Some(SYNC_PAGE_SIZE),
                cursor: cursor.clone(),
                offset: Some(0),
            },
            cancellation,
        ) {
            Ok(rows) => rows,
            Err(error) if error.message() == CANCELLED_MESSAGE || cancellation.is_cancelled() => {
                break
            }
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

        let (page_rows, reached_checkpoint) =
            select_sync_page_rows(rows, previous.as_ref(), params.force_full);

        let outcome = process_sync_page(
            &auth,
            params.workspace_root.as_deref(),
            &resolved_username,
            page_rows,
            sync_concurrency,
            cancellation,
        );
        downloaded += outcome.downloaded;
        cached += outcome.cached;
        failed += outcome.failed;
        if newest.is_none() {
            newest = outcome.newest_synced.clone();
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

    let checkpoint = newest.clone().or_else(|| {
        previous.as_ref().map(|entry| {
            (
                entry.last_synced_log_id.clone().unwrap_or_default(),
                entry.last_synced_start_time.clone().unwrap_or_default(),
            )
        })
    });

    if status == "success" {
        let (last_synced_log_id, last_synced_start_time) = checkpoint.clone().unwrap_or_default();
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
        write_sync_state(params.workspace_root.as_deref(), &state)
            .map_err(LogsRuntimeError::from_message)?;
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
    )
    .map_err(LogsRuntimeError::from_message)?;

    Ok(LogsSyncResult {
        status: status.clone(),
        target_org: resolved_username.clone(),
        safe_target_org: safe_org,
        downloaded,
        cached,
        failed,
        checkpoint_advanced: status == "success",
        state_file: crate::log_store::sync_state_path(params.workspace_root.as_deref())
            .display()
            .to_string(),
        last_synced_log_id: if status == "success" {
            checkpoint.map(|(log_id, _)| log_id)
        } else {
            newest.map(|(log_id, _)| log_id)
        },
    })
}

pub fn normalize_sync_concurrency(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_SYNC_CONCURRENCY)
        .clamp(1, MAX_SYNC_CONCURRENCY)
}

fn timestamp_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn row_matches_checkpoint(entry: &SyncStateOrgEntry, row: &LogRow) -> bool {
    if let Some(last_synced_log_id) = entry
        .last_synced_log_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return last_synced_log_id == row.id.as_str();
    }

    entry.last_synced_start_time.as_deref() == Some(row.start_time.as_str())
}

fn select_sync_page_rows(
    rows: Vec<LogRow>,
    previous: Option<&SyncStateOrgEntry>,
    force_full: bool,
) -> (Vec<LogRow>, bool) {
    let mut selected = Vec::new();
    let mut reached_checkpoint = false;
    let mut seen_log_ids = BTreeSet::new();

    for row in rows {
        let hit_checkpoint =
            !force_full && previous.is_some_and(|entry| row_matches_checkpoint(entry, &row));
        if hit_checkpoint {
            reached_checkpoint = true;
            break;
        }
        if seen_log_ids.insert(row.id.clone()) {
            selected.push(row);
        }
    }

    (selected, reached_checkpoint)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncItemStatus {
    Downloaded,
    Cached,
    Failed,
    Cancelled,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PageSyncOutcome {
    downloaded: usize,
    cached: usize,
    failed: usize,
    newest_synced: Option<(String, String)>,
}

fn process_sync_page(
    auth: &OrgAuth,
    workspace_root: Option<&str>,
    resolved_username: &str,
    rows: Vec<LogRow>,
    concurrency: usize,
    cancellation: &CancellationToken,
) -> PageSyncOutcome {
    if rows.is_empty() {
        return PageSyncOutcome::default();
    }

    let queue = Arc::new(Mutex::new(
        rows.into_iter().enumerate().collect::<VecDeque<_>>(),
    ));
    let (tx, rx) = mpsc::channel::<(usize, String, String, SyncItemStatus)>();
    let auth = auth.clone();
    let workspace_root = workspace_root.map(str::to_string);
    let resolved_username = resolved_username.to_string();
    let worker_count = {
        let guard = queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        concurrency.min(guard.len().max(1))
    };

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let tx = tx.clone();
            let queue = Arc::clone(&queue);
            let auth = auth.clone();
            let workspace_root = workspace_root.clone();
            let resolved_username = resolved_username.clone();
            let cancellation = cancellation.clone();
            scope.spawn(move || loop {
                if cancellation.is_cancelled() {
                    break;
                }

                let Some((index, row)) = queue
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .pop_front()
                else {
                    break;
                };

                let target_path = log_file_path_for_start_time(
                    workspace_root.as_deref(),
                    &resolved_username,
                    &row.start_time,
                    &row.id,
                );
                let status = if target_path.is_file() {
                    SyncItemStatus::Cached
                } else {
                    match download_log_to_path_for_auth_with_cancel(
                        &auth,
                        &row.id,
                        &target_path,
                        &cancellation,
                    ) {
                        Ok(_) => SyncItemStatus::Downloaded,
                        Err(error) if error == CANCELLED_MESSAGE || cancellation.is_cancelled() => {
                            SyncItemStatus::Cancelled
                        }
                        Err(_) => SyncItemStatus::Failed,
                    }
                };

                let _ = tx.send((index, row.id, row.start_time, status));
                if status == SyncItemStatus::Cancelled {
                    break;
                }
            });
        }
        drop(tx);

        let mut outcome = PageSyncOutcome::default();
        let mut best_index: Option<usize> = None;
        for (index, row_id, start_time, item) in rx {
            match item {
                SyncItemStatus::Downloaded | SyncItemStatus::Cached => {
                    if item == SyncItemStatus::Downloaded {
                        outcome.downloaded += 1;
                    } else {
                        outcome.cached += 1;
                    }
                    if best_index.is_none_or(|best| index < best) {
                        best_index = Some(index);
                        outcome.newest_synced = Some((row_id, start_time));
                    }
                }
                SyncItemStatus::Failed => outcome.failed += 1,
                SyncItemStatus::Cancelled => {}
            }
        }
        outcome
    })
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_sync_concurrency, select_sync_page_rows, timestamp_now, LogRow, SyncStateOrgEntry,
    };

    #[test]
    fn timestamp_now_emits_rfc3339_like_utc_values() {
        let value = timestamp_now();
        assert!(value.contains('T'));
        assert!(value.ends_with('Z'));
    }

    #[test]
    fn normalize_sync_concurrency_clamps_values() {
        assert_eq!(normalize_sync_concurrency(None), 6);
        assert_eq!(normalize_sync_concurrency(Some(0)), 1);
        assert_eq!(normalize_sync_concurrency(Some(1)), 1);
        assert_eq!(normalize_sync_concurrency(Some(4)), 4);
        assert_eq!(normalize_sync_concurrency(Some(999)), 8);
    }

    #[test]
    fn select_sync_page_rows_stops_before_checkpoint_and_deduplicates_ids() {
        let rows = vec![
            make_row("07L000000000003AA", "2026-03-30T18:41:00.000Z"),
            make_row("07L000000000002AA", "2026-03-30T18:40:00.000Z"),
            make_row("07L000000000002AA", "2026-03-30T18:40:00.000Z"),
            make_row("07L000000000001AA", "2026-03-30T18:39:00.000Z"),
        ];
        let checkpoint = SyncStateOrgEntry {
            target_org: "default@example.com".to_string(),
            safe_target_org: "default@example.com".to_string(),
            org_dir: "apexlogs/orgs/default@example.com".to_string(),
            last_sync_started_at: None,
            last_sync_completed_at: None,
            last_synced_log_id: Some("07L000000000002AA".to_string()),
            last_synced_start_time: Some("2026-03-30T18:40:00.000Z".to_string()),
            downloaded_count: 0,
            cached_count: 0,
            last_error: None,
        };

        let (selected, reached_checkpoint) = select_sync_page_rows(rows, Some(&checkpoint), false);

        assert!(reached_checkpoint);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "07L000000000003AA");
    }

    fn make_row(id: &str, start_time: &str) -> LogRow {
        LogRow {
            id: id.to_string(),
            start_time: start_time.to_string(),
            operation: "ExecuteAnonymous".to_string(),
            application: "Developer Console".to_string(),
            duration_milliseconds: 1,
            status: "Success".to_string(),
            request: format!("REQ-{id}"),
            log_length: 1,
            log_user: None,
        }
    }
}
