use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs};

use crate::{
    log_store,
    logs::{ensure_log_file_cached_with_cancel, CancellationToken},
    tooling::{self, escape_soql_literal},
    users,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveLogPathParams {
    pub log_id: String,
    pub target_org: Option<String>,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveLogPathResult {
    pub log_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadLogParams {
    pub log_id: String,
    pub target_org: Option<String>,
    pub workspace_root: Option<String>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadLogResult {
    pub log_id: String,
    pub path: String,
    pub body: String,
    pub size_bytes: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLogsParams {
    pub target_org: Option<String>,
    pub workspace_root: Option<String>,
    pub scope: Option<String>,
    #[serde(default)]
    pub ids: Vec<String>,
    pub limit: Option<usize>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLogsResult {
    pub status: String,
    pub target_org: String,
    pub scope: String,
    pub dry_run: bool,
    pub listed: usize,
    pub total: usize,
    pub deleted: usize,
    pub failed: usize,
    pub cancelled: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub log_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_log_ids: Vec<String>,
}

pub fn resolve_log_path(params: &ResolveLogPathParams) -> ResolveLogPathResult {
    let path = log_store::find_cached_log_path(
        params.workspace_root.as_deref(),
        params.log_id.trim(),
        params.target_org.as_deref(),
    )
    .map(|path| path.display().to_string());
    ResolveLogPathResult {
        log_id: params.log_id.trim().to_string(),
        cached: path.is_some(),
        path,
    }
}

pub fn read_log_with_cancel(
    params: &ReadLogParams,
    cancellation: &CancellationToken,
) -> Result<ReadLogResult, String> {
    let log_id = params.log_id.trim();
    if log_id.is_empty() {
        return Err("log id is required".to_string());
    }
    let path = ensure_log_file_cached_with_cancel(
        log_id,
        params.target_org.as_deref(),
        params.workspace_root.as_deref(),
        cancellation,
    )?;
    let bytes =
        fs::read(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let max_bytes = params.max_bytes.unwrap_or(bytes.len()).max(1);
    let truncated = bytes.len() > max_bytes;
    let body_bytes = if truncated {
        &bytes[..max_bytes]
    } else {
        bytes.as_slice()
    };
    let body = String::from_utf8_lossy(body_bytes).to_string();
    Ok(ReadLogResult {
        log_id: log_id.to_string(),
        path: path.display().to_string(),
        body,
        size_bytes: bytes.len(),
        truncated,
    })
}

pub fn delete_logs_with_cancel(
    params: &DeleteLogsParams,
    cancellation: &CancellationToken,
) -> Result<DeleteLogsResult, String> {
    if !params.dry_run && !params.confirmed {
        return Err("live log delete requires --yes or confirmed=true".to_string());
    }

    let (scope, ids) = resolve_delete_ids(params, cancellation)?;
    let listed = ids.len();
    if params.dry_run {
        let target_org = params
            .target_org
            .clone()
            .unwrap_or_else(|| "default".to_string());
        return Ok(DeleteLogsResult {
            status: "dry-run".to_string(),
            target_org,
            scope,
            dry_run: true,
            listed,
            total: listed,
            deleted: 0,
            failed: 0,
            cancelled: 0,
            log_ids: ids,
            failed_log_ids: Vec::new(),
        });
    }

    let auth = tooling::resolve_org_auth(params.target_org.as_deref())?;
    let target_org = auth
        .username
        .clone()
        .or_else(|| params.target_org.clone())
        .unwrap_or_else(|| "default".to_string());

    let mut deleted = 0usize;
    let mut failed = 0usize;
    let mut cancelled = 0usize;
    let mut failed_log_ids = Vec::new();
    for chunk in ids.chunks(200) {
        cancellation.check_cancelled().map_err(|error| {
            cancelled += chunk.len();
            error
        })?;
        let result =
            tooling::composite_delete_sobjects(params.target_org.as_deref(), chunk, cancellation)?;
        let mut seen = BTreeSet::new();
        for item in result {
            seen.insert(item.id.clone());
            if item.success {
                deleted += 1;
            } else {
                failed += 1;
                failed_log_ids.push(item.id);
            }
        }
        for id in chunk {
            if !seen.contains(id) {
                failed += 1;
                failed_log_ids.push(id.clone());
            }
        }
    }

    Ok(DeleteLogsResult {
        status: if failed == 0 { "success" } else { "partial" }.to_string(),
        target_org,
        scope,
        dry_run: false,
        listed,
        total: listed,
        deleted,
        failed,
        cancelled,
        log_ids: Vec::new(),
        failed_log_ids,
    })
}

fn resolve_delete_ids(
    params: &DeleteLogsParams,
    cancellation: &CancellationToken,
) -> Result<(String, Vec<String>), String> {
    let mut ids = dedup_ids(&params.ids);
    if !ids.is_empty() {
        return Ok(("ids".to_string(), ids));
    }

    let scope = params
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("mine");
    let mut clauses = Vec::new();
    if scope == "mine" {
        let current_user = users::current_user_id(params.target_org.as_deref(), cancellation)?;
        clauses.push(format!(
            "LogUserId = '{}'",
            escape_soql_literal(&current_user)
        ));
    } else if scope != "all" {
        return Err("logs delete scope must be mine or all".to_string());
    }

    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    let limit_clause = params
        .limit
        .map(|limit| format!(" LIMIT {}", limit.max(1)))
        .unwrap_or_default();
    let soql = format!(
        "SELECT Id FROM ApexLog{where_clause} ORDER BY StartTime DESC, Id DESC{limit_clause}"
    );
    let query = tooling::query_tooling(params.target_org.as_deref(), &soql, cancellation)?;
    ids = query
        .records
        .iter()
        .filter_map(|record| record.get("Id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect();
    Ok((scope.to_string(), dedup_ids(&ids)))
}

fn dedup_ids(values: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut ids = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        ids.push(trimmed.to_string());
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::dedup_ids;

    #[test]
    fn dedup_ids_keeps_first_non_empty_values() {
        assert_eq!(
            dedup_ids(&[
                " 07L000000000001AA ".to_string(),
                "".to_string(),
                "07L000000000001AA".to_string(),
                "07L000000000002AA".to_string(),
            ]),
            vec![
                "07L000000000001AA".to_string(),
                "07L000000000002AA".to_string()
            ]
        );
    }
}
