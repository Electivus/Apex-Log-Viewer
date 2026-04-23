use crate::cli::{LogSearchArgs, LogStatusArgs, LogSyncArgs, LogsArgs, LogsCommand};
use alv_core::{
    auth,
    log_store::{self, OrgMetadata, SyncState},
    logs::{CancellationToken, LogsRuntimeError, RuntimeErrorData},
    logs_sync::{sync_logs_detailed_with_cancel, LogsSyncParams, LogsSyncResult},
    search::{search_query, SearchQueryParams, SearchQueryResult, SearchSnippet},
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

#[derive(Debug, Clone, Serialize)]
struct SearchMatch {
    log_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    snippet: Option<SearchSnippet>,
}

#[derive(Debug, Clone, Serialize)]
struct SearchResult {
    target_org: String,
    safe_target_org: String,
    query: String,
    searched_log_count: usize,
    matches: Vec<SearchMatch>,
    pending_log_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
struct CommandErrorResult<'a> {
    status: &'static str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<&'a RuntimeErrorData>,
}

pub fn run(args: LogsArgs) -> Result<i32, String> {
    match args.command {
        LogsCommand::Sync(sync) => run_sync(sync),
        LogsCommand::Status(status) => run_status(status),
        LogsCommand::Search(search) => run_search(search),
    }
}

fn run_sync(args: LogSyncArgs) -> Result<i32, String> {
    let json = args.json;
    let params = LogsSyncParams {
        target_org: args.target_org,
        workspace_root: Some(workspace_root_string()?),
        force_full: args.force_full,
        concurrency: args.concurrency,
    };
    let result = sync_logs_detailed_with_cancel(&params, &CancellationToken::new())
        .map_err(|error| format_logs_error(&error, json))?;

    if json {
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

fn run_status(args: LogStatusArgs) -> Result<i32, String> {
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
    let legacy_scopes =
        legacy_scope_candidates(args.target_org.as_deref(), Some(&resolved_username));
    let legacy_scope_refs = legacy_scopes.iter().map(String::as_str).collect::<Vec<_>>();
    let log_count = discover_local_log_ids(
        Some(&workspace_root),
        Some(&resolved_username),
        &legacy_scope_refs,
    )?
    .len();

    let result = StatusResult {
        target_org: resolved_username,
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

    if args.json {
        print_json(&result)?;
    } else {
        print_status_summary(&result);
    }

    Ok(0)
}

fn run_search(args: LogSearchArgs) -> Result<i32, String> {
    let workspace_root = workspace_root_string()?;
    let query = args.query.trim().to_string();
    if query.is_empty() {
        return Err("search query must not be empty".to_string());
    }

    let sync_state = log_store::read_sync_state(Some(&workspace_root))?;
    let resolved_username = resolve_search_target_org(
        args.target_org.as_deref(),
        Some(&workspace_root),
        &sync_state,
    )?;
    let legacy_scopes =
        legacy_scope_candidates(args.target_org.as_deref(), resolved_username.as_deref());
    let legacy_scope_refs = legacy_scopes.iter().map(String::as_str).collect::<Vec<_>>();
    let log_ids = discover_local_log_ids(
        Some(&workspace_root),
        resolved_username.as_deref(),
        &legacy_scope_refs,
    )?;
    let result = search_query(&SearchQueryParams {
        query: query.clone(),
        log_ids: log_ids.clone(),
        username: resolved_username.clone(),
        raw_username: args
            .target_org
            .clone()
            .filter(|raw| resolved_username.as_deref() != Some(raw.as_str())),
        workspace_root: Some(workspace_root),
    })?;
    let target_org = resolved_username.unwrap_or_else(|| "default".to_string());
    let safe_target_org = log_store::safe_target_org(&target_org);

    let output = build_search_result(target_org, safe_target_org, query, log_ids.len(), result);

    if args.json {
        print_json(&output)?;
    } else {
        print_search_summary(&output);
    }

    Ok(0)
}

fn build_search_result(
    target_org: String,
    safe_target_org: String,
    query: String,
    searched_log_count: usize,
    result: SearchQueryResult,
) -> SearchResult {
    let SearchQueryResult {
        log_ids,
        snippets,
        pending_log_ids,
    } = result;

    let matches = log_ids
        .into_iter()
        .map(|log_id| SearchMatch {
            snippet: snippets.get(&log_id).cloned(),
            log_id,
        })
        .collect();

    SearchResult {
        target_org,
        safe_target_org,
        query,
        searched_log_count,
        matches,
        pending_log_ids,
    }
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

fn print_search_summary(result: &SearchResult) {
    println!(
        "Found {} matching logs for '{}'",
        result.matches.len(),
        result.query
    );
    for entry in &result.matches {
        println!("- {}", entry.log_id);
        if let Some(snippet) = &entry.snippet {
            println!("  {}", snippet.text);
        }
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

fn resolve_search_target_org(
    target_org: Option<&str>,
    workspace_root: Option<&str>,
    sync_state: &SyncState,
) -> Result<Option<String>, String> {
    if let Some(resolved) = resolve_local_target_org(target_org, workspace_root, sync_state) {
        return Ok(Some(resolved));
    }

    let Some(requested) = target_org.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if requested.contains('@') {
        return Ok(Some(requested.to_string()));
    }

    match auth::resolve_org_auth(Some(requested)) {
        Ok(auth) => Ok(Some(auth.username.unwrap_or_else(|| requested.to_string()))),
        Err(_) => Ok(Some(requested.to_string())),
    }
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
    legacy_scopes: &[&str],
) -> Result<Vec<String>, String> {
    let mut ids = BTreeSet::new();
    let apexlogs_root = log_store::resolve_apexlogs_root(workspace_root);

    if let Some(target_org) = resolved_username {
        collect_log_ids_in_tree(
            &log_store::org_dir(workspace_root, target_org).join("logs"),
            &mut ids,
        )?;
        let scopes = if legacy_scopes.is_empty() {
            vec![target_org]
        } else {
            legacy_scopes.to_vec()
        };
        for scope in scopes {
            collect_legacy_scoped_log_ids(&apexlogs_root, scope, &mut ids)?;
        }
    } else {
        collect_log_ids_in_tree(&apexlogs_root.join("orgs"), &mut ids)?;
        collect_legacy_flat_log_ids(&apexlogs_root, &mut ids)?;
    }

    Ok(ids.into_iter().collect())
}

fn legacy_scope_candidates(
    requested_target_org: Option<&str>,
    resolved_username: Option<&str>,
) -> Vec<String> {
    let mut scopes = Vec::new();

    if let Some(resolved_username) = resolved_username
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        scopes.push(resolved_username.to_string());
    }

    if let Some(requested_target_org) = requested_target_org
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| !scopes.iter().any(|existing| existing == value))
    {
        scopes.push(requested_target_org.to_string());
    }

    scopes
}

fn collect_log_ids_in_tree(root: &Path, ids: &mut BTreeSet<String>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }

    for entry in
        fs::read_dir(root).map_err(|error| format!("failed to read {}: {error}", root.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", root.display()))?;
        let path = entry.path();
        if path.is_dir() {
            collect_log_ids_in_tree(&path, ids)?;
            continue;
        }

        if path.extension().and_then(|value| value.to_str()) != Some("log") {
            continue;
        }

        if let Some(log_id) = extract_log_id(&path) {
            ids.insert(log_id);
        }
    }

    Ok(())
}

fn collect_legacy_flat_log_ids(root: &Path, ids: &mut BTreeSet<String>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }

    for entry in
        fs::read_dir(root).map_err(|error| format!("failed to read {}: {error}", root.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", root.display()))?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("log") {
            continue;
        }

        if let Some(log_id) = extract_log_id(&path) {
            ids.insert(log_id);
        }
    }

    Ok(())
}

fn collect_legacy_scoped_log_ids(
    root: &Path,
    target_org: &str,
    ids: &mut BTreeSet<String>,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }

    let prefix = format!("{}_", log_store::safe_target_org(target_org));
    for entry in
        fs::read_dir(root).map_err(|error| format!("failed to read {}: {error}", root.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", root.display()))?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("log") {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let is_bare = !file_name.contains('_');
        if !file_name.starts_with(&prefix) && !is_bare {
            continue;
        }

        if let Some(log_id) = extract_log_id(&path) {
            ids.insert(log_id);
        }
    }

    Ok(())
}

fn extract_log_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?.trim();
    if stem.is_empty() {
        return None;
    }

    let log_id = stem.rsplit('_').next().unwrap_or(stem).trim();
    if log_id.is_empty() {
        None
    } else {
        Some(log_id.to_string())
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
