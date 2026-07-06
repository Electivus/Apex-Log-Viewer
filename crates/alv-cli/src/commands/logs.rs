use crate::{
    cli::{
        LogDeleteArgs, LogListArgs, LogReadArgs, LogResolveArgs, LogStatusArgs, LogSyncArgs,
        LogTriageArgs, LogsArgs, LogsCommand,
    },
    commands::OutputMode,
};
use alv_core::{
    log_ops,
    log_store::{self, OrgMetadata, SyncState},
    logs::{
        list_logs_detailed_with_cancel, CancellationToken, LogsListParams, LogsRuntimeError,
        RuntimeErrorData,
    },
    logs_sync::{sync_logs_detailed_with_cancel, LogsSyncParams, LogsSyncResult},
    triage::{triage_logs_with_cancel, LogsTriageParams},
};
use serde::Serialize;
use std::{collections::BTreeSet, env, fs, path::Path};

#[derive(Debug, Clone, Serialize)]
struct StatusResult {
    target_org: String,
    safe_target_org: String,
    workspace_root: String,
    apexlogs_root: String,
    state_file: String,
    log_count: usize,
    has_state: bool,
    last_sync_started_at: Option<String>,
    last_sync_completed_at: Option<String>,
    last_synced_log_id: Option<String>,
    last_synced_start_time: Option<String>,
    downloaded_count: usize,
    cached_count: usize,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
struct CommandErrorResult<'a> {
    status: &'static str,
    code: &'static str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<&'a RuntimeErrorData>,
}

pub fn run(args: LogsArgs, output: OutputMode) -> Result<i32, String> {
    match args.command {
        LogsCommand::List(list) => run_list(list, output),
        LogsCommand::Sync(sync) => run_sync(sync, output),
        LogsCommand::Status(status) => run_status(status, output),
        LogsCommand::Read(read) => run_read(read, output),
        LogsCommand::Resolve(resolve) => run_resolve(resolve, output),
        LogsCommand::Triage(triage) => run_triage(triage, output),
        LogsCommand::Delete(delete) => run_delete(delete, output),
    }
}

fn run_list(args: LogListArgs, output: OutputMode) -> Result<i32, String> {
    let params = LogsListParams {
        username: args.target_org,
        limit: args.limit,
        cursor: None,
        offset: args.offset,
    };
    let result = list_logs_detailed_with_cancel(&params, &CancellationToken::new())
        .map_err(|error| format_logs_error(&error, output.json))?;
    if output.json {
        print_json(&result)?;
    } else {
        println!("Apex logs");
        for row in &result {
            println!(
                "{} {} {} {}",
                row.id, row.start_time, row.status, row.operation
            );
        }
    }
    Ok(0)
}

fn run_sync(args: LogSyncArgs, output: OutputMode) -> Result<i32, String> {
    let params = LogsSyncParams {
        target_org: args.target_org,
        workspace_root: Some(workspace_root_string()?),
        force_full: args.force_full,
        concurrency: args.concurrency,
    };
    let result = sync_logs_detailed_with_cancel(&params, &CancellationToken::new())
        .map_err(|error| format_logs_error(&error, output.json))?;

    if output.json {
        print_json(&result)?;
    } else {
        print_sync_summary(&result);
    }

    Ok(match result.status.as_str() {
        "success" => 0,
        "partial" => 2,
        "cancelled" => 130,
        _ => 1,
    })
}

fn run_status(args: LogStatusArgs, output: OutputMode) -> Result<i32, String> {
    let workspace_root = workspace_root_string()?;
    let sync_state = log_store::read_sync_state(Some(&workspace_root))?;
    let resolved_username = resolve_local_target_org(
        args.target_org.as_deref(),
        Some(&workspace_root),
        &sync_state,
    )
    .or_else(|| args.target_org.clone())
    .or_else(|| sync_state.orgs.keys().next().cloned())
    .unwrap_or_else(|| "default".to_string());
    let safe_target_org = log_store::safe_target_org(&resolved_username);
    let apexlogs_root = log_store::resolve_apexlogs_root(Some(&workspace_root));
    let entry = sync_state.orgs.get(&resolved_username);
    let log_count = discover_local_log_ids(Some(&workspace_root), Some(&resolved_username))?.len();

    let result = StatusResult {
        target_org: resolved_username.clone(),
        safe_target_org,
        workspace_root: workspace_root.clone(),
        apexlogs_root: apexlogs_root.display().to_string(),
        state_file: log_store::sync_state_path(Some(&workspace_root))
            .display()
            .to_string(),
        log_count,
        has_state: entry.is_some(),
        last_sync_started_at: entry.and_then(|value| value.last_sync_started_at.clone()),
        last_sync_completed_at: entry.and_then(|value| value.last_sync_completed_at.clone()),
        last_synced_log_id: entry.and_then(|value| value.last_synced_log_id.clone()),
        last_synced_start_time: entry.and_then(|value| value.last_synced_start_time.clone()),
        downloaded_count: entry.map(|value| value.downloaded_count).unwrap_or(0),
        cached_count: entry.map(|value| value.cached_count).unwrap_or(0),
        last_error: entry.and_then(|value| value.last_error.clone()),
    };

    if output.json {
        print_json(&result)?;
    } else {
        print_status_summary(&result);
    }

    Ok(0)
}

fn run_read(args: LogReadArgs, output: OutputMode) -> Result<i32, String> {
    let result = log_ops::read_log_with_cancel(
        &log_ops::ReadLogParams {
            log_id: args.log_id,
            target_org: args.target_org,
            workspace_root: Some(workspace_root_string()?),
            max_bytes: args.max_bytes,
        },
        &CancellationToken::new(),
    )?;
    if output.json {
        print_json(&result)?;
    } else {
        print!("{}", result.body);
    }
    Ok(0)
}

fn run_resolve(args: LogResolveArgs, output: OutputMode) -> Result<i32, String> {
    let result = log_ops::resolve_log_path(&log_ops::ResolveLogPathParams {
        log_id: args.log_id,
        target_org: args.target_org,
        workspace_root: Some(workspace_root_string()?),
    });
    if output.json {
        print_json(&result)?;
    } else if let Some(path) = result.path {
        println!("{path}");
    } else {
        println!("log is not cached");
    }
    Ok(0)
}

fn run_triage(args: LogTriageArgs, output: OutputMode) -> Result<i32, String> {
    let result = triage_logs_with_cancel(
        &LogsTriageParams {
            log_ids: args.log_ids,
            log_start_times: Default::default(),
            username: args.target_org,
            workspace_root: Some(workspace_root_string()?),
        },
        &CancellationToken::new(),
    )?;
    if output.json {
        print_json(&result)?;
    } else {
        for item in &result {
            let reason = item
                .summary
                .primary_reason
                .as_deref()
                .unwrap_or("No obvious errors");
            println!("{}: {reason}", item.log_id);
        }
    }
    Ok(0)
}

fn run_delete(args: LogDeleteArgs, output: OutputMode) -> Result<i32, String> {
    let mut ids = args.ids;
    if let Some(path) = args
        .ids_file
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let body =
            fs::read_to_string(path).map_err(|error| format!("failed to read {path}: {error}"))?;
        ids.extend(
            body.lines()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        );
    }
    let result = log_ops::delete_logs_with_cancel(
        &log_ops::DeleteLogsParams {
            target_org: args.target_org,
            workspace_root: Some(workspace_root_string()?),
            scope: args.scope,
            ids,
            limit: args.limit,
            dry_run: args.dry_run,
            confirmed: args.yes,
        },
        &CancellationToken::new(),
    )?;
    if output.json {
        print_json(&result)?;
    } else if result.dry_run {
        println!("Would delete {} Apex log(s)", result.total);
    } else {
        println!(
            "Deleted {} Apex log(s); failed {}; cancelled {}",
            result.deleted, result.failed, result.cancelled
        );
    }
    Ok(if result.failed > 0 { 2 } else { 0 })
}

fn workspace_root_string() -> Result<String, String> {
    env::current_dir()
        .map(|path| path.display().to_string())
        .map_err(|error| format!("failed to resolve workspace root: {error}"))
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    let output = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    println!("{output}");
    Ok(())
}

fn format_logs_error(error: &LogsRuntimeError, json: bool) -> String {
    if json {
        let output = CommandErrorResult {
            status: "error",
            code: "command_failed",
            message: error.message(),
            data: error.data(),
        };
        return serde_json::to_string_pretty(&output)
            .unwrap_or_else(|_| error.message().to_string());
    }

    let mut lines = vec![error.message().to_string()];
    if let Some(data) = error.data() {
        if let Some(status) = data.status {
            lines.push(format!("HTTP status: {status}"));
        }
        if let Some(url) = data.url.as_deref().filter(|value| !value.trim().is_empty()) {
            lines.push(format!("URL: {url}"));
        }
        if let Some(body) = data
            .response_body
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push("Response body:".to_string());
            lines.push(body.to_string());
        }
        if !data.causes.is_empty() {
            lines.push("Caused by:".to_string());
            for cause in &data.causes {
                lines.push(format!("- {cause}"));
            }
        }
    }
    lines.join("\n")
}

fn print_sync_summary(result: &LogsSyncResult) {
    println!("Synced Apex logs");
    println!("Status: {}", result.status);
    println!("Downloaded: {}", result.downloaded);
    println!("Cached: {}", result.cached);
    println!("Failed: {}", result.failed);
    println!("Checkpoint advanced: {}", result.checkpoint_advanced);
    println!("State file: {}", result.state_file);
}

fn print_status_summary(result: &StatusResult) {
    println!("Apex logs status");
    println!("Workspace: {}", result.workspace_root);
    println!("Apex logs root: {}", result.apexlogs_root);
    println!("State file: {}", result.state_file);
    println!("Local logs: {}", result.log_count);
    if result.has_state {
        println!("Last sync completed: {:?}", result.last_sync_completed_at);
    } else {
        println!("No sync state found yet");
    }
}

fn resolve_local_target_org(
    target_org: Option<&str>,
    workspace_root: Option<&str>,
    sync_state: &SyncState,
) -> Option<String> {
    let requested = target_org
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    if requested.contains('@') || sync_state.orgs.contains_key(requested) {
        return Some(requested.to_string());
    }

    find_org_metadata_by_alias(workspace_root, requested, sync_state)
        .map(|metadata| metadata.resolved_username)
}

fn find_org_metadata_by_alias(
    workspace_root: Option<&str>,
    alias: &str,
    sync_state: &SyncState,
) -> Option<OrgMetadata> {
    let orgs_root = log_store::resolve_apexlogs_root(workspace_root).join("orgs");
    find_org_metadata_by_alias_in_root(&orgs_root, alias, sync_state)
}

fn find_org_metadata_by_alias_in_root(
    orgs_root: &Path,
    alias: &str,
    sync_state: &SyncState,
) -> Option<OrgMetadata> {
    let mut org_dirs = fs::read_dir(orgs_root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    org_dirs.sort();
    let mut matches = Vec::new();

    for org_dir in org_dirs {
        if !org_dir.is_dir() {
            continue;
        }

        let metadata_path = org_dir.join("org.json");
        let Ok(bytes) = fs::read(&metadata_path) else {
            continue;
        };
        let Ok(metadata) = serde_json::from_slice::<OrgMetadata>(&bytes) else {
            continue;
        };
        if metadata.alias.as_deref() == Some(alias) {
            matches.push(metadata);
        }
    }

    matches.into_iter().max_by_key(|metadata| {
        let sync_entry = sync_state.orgs.get(&metadata.resolved_username);
        (
            sync_entry.is_some(),
            sync_entry
                .and_then(|entry| entry.last_sync_completed_at.clone())
                .unwrap_or_default(),
            metadata.updated_at.clone(),
            metadata.resolved_username.clone(),
        )
    })
}

fn discover_local_log_ids(
    workspace_root: Option<&str>,
    resolved_username: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut ids = BTreeSet::new();
    let apexlogs_root = log_store::resolve_apexlogs_root(workspace_root);

    if let Some(target_org) = resolved_username {
        collect_log_ids_in_logs_dir(
            &log_store::org_dir(workspace_root, target_org).join("logs"),
            &mut ids,
        )?;
    } else {
        collect_log_ids_in_orgs_root(&apexlogs_root.join("orgs"), &mut ids)?;
    }

    Ok(ids.into_iter().collect())
}

fn collect_log_ids_in_orgs_root(root: &Path, ids: &mut BTreeSet<String>) -> Result<(), String> {
    if !root.is_dir() {
        return Ok(());
    }

    for entry in
        fs::read_dir(root).map_err(|error| format!("failed to read {}: {error}", root.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", root.display()))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        collect_log_ids_in_logs_dir(&path.join("logs"), ids)?;
    }

    Ok(())
}

fn collect_log_ids_in_logs_dir(logs_root: &Path, ids: &mut BTreeSet<String>) -> Result<(), String> {
    if !logs_root.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(logs_root)
        .map_err(|error| format!("failed to read {}: {error}", logs_root.display()))?
    {
        let entry =
            entry.map_err(|error| format!("failed to read {}: {error}", logs_root.display()))?;
        let day_dir = entry.path();
        if !day_dir.is_dir()
            || !is_supported_log_day_dir_name(entry.file_name().to_string_lossy().as_ref())
        {
            continue;
        }

        for file_entry in fs::read_dir(&day_dir)
            .map_err(|error| format!("failed to read {}: {error}", day_dir.display()))?
        {
            let file_entry = file_entry
                .map_err(|error| format!("failed to read {}: {error}", day_dir.display()))?;
            let path = file_entry.path();
            if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("log") {
                continue;
            }

            if let Some(log_id) = extract_log_id(&path) {
                ids.insert(log_id);
            }
        }
    }

    Ok(())
}

fn is_supported_log_day_dir_name(name: &str) -> bool {
    name == "unknown-date" || is_yyyy_mm_dd(name)
}

fn is_yyyy_mm_dd(value: &str) -> bool {
    matches!(
        value.as_bytes(),
        [y1, y2, y3, y4, b'-', m1, m2, b'-', d1, d2]
            if y1.is_ascii_digit()
                && y2.is_ascii_digit()
                && y3.is_ascii_digit()
                && y4.is_ascii_digit()
                && m1.is_ascii_digit()
                && m2.is_ascii_digit()
                && d1.is_ascii_digit()
                && d2.is_ascii_digit()
    )
}

fn extract_log_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?.trim();
    if (15..=18).contains(&stem.len())
        && stem
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        Some(stem.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn make_temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alv-cli-logs-{label}-{unique}"));
        fs::create_dir_all(&root).expect("temp dir should be creatable");
        root
    }

    #[test]
    fn find_org_metadata_by_alias_in_root_skips_unreadable_entries() {
        let workspace_root = make_temp_dir("alias-scan");
        let orgs_root = workspace_root.join("apexlogs").join("orgs");
        fs::create_dir_all(orgs_root.join("aaa-missing")).expect("bad org dir should exist");
        fs::create_dir_all(orgs_root.join("zzz-good")).expect("good org dir should exist");
        fs::write(
            orgs_root.join("zzz-good").join("org.json"),
            r#"{"targetOrg":"ALV_ALIAS","safeTargetOrg":"default@example.com","resolvedUsername":"default@example.com","alias":"ALV_ALIAS","instanceUrl":"https://default.example.com","updatedAt":"2026-03-31T12:00:00.000Z"}"#,
        )
        .expect("org metadata should be writable");

        let metadata =
            find_org_metadata_by_alias_in_root(&orgs_root, "ALV_ALIAS", &SyncState::default())
                .expect("alias should resolve even when earlier org dirs are unreadable");

        assert_eq!(metadata.resolved_username, "default@example.com");

        fs::remove_dir_all(workspace_root).expect("temp dir should be removable");
    }
}
