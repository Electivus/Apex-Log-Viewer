use serde::{Deserialize, Serialize};

use crate::{
    logs::CancellationToken,
    tooling::{self, escape_soql_literal},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSearchParams {
    pub target_org: Option<String>,
    pub query: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSearchResult {
    pub users: Vec<UserRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRecord {
    pub id: String,
    pub name: String,
    pub username: String,
    pub active: bool,
}

pub fn search_users_with_cancel(
    params: &UserSearchParams,
    cancellation: &CancellationToken,
) -> Result<UserSearchResult, String> {
    let safe_limit = params.limit.unwrap_or(50).clamp(1, 200);
    let query = params.query.as_deref().unwrap_or_default().trim();
    let mut clauses = vec!["IsActive = true".to_string()];
    if !query.is_empty() {
        let escaped = escape_soql_literal(query)
            .replace('%', "\\%")
            .replace('_', "\\_");
        clauses.push(format!(
            "(Name LIKE '%{escaped}%' OR Username LIKE '%{escaped}%')"
        ));
    }
    let soql = format!(
        "SELECT Id, Name, Username, IsActive FROM User WHERE {} ORDER BY Name NULLS LAST LIMIT {safe_limit}",
        clauses.join(" AND ")
    );
    let result = tooling::query_standard(params.target_org.as_deref(), &soql, cancellation)?;
    let mut users = result
        .records
        .iter()
        .filter_map(map_user_record)
        .collect::<Vec<_>>();
    if !query.is_empty() {
        let needle = query.to_ascii_lowercase();
        users.retain(|user| {
            user.name.to_ascii_lowercase().contains(&needle)
                || user.username.to_ascii_lowercase().contains(&needle)
        });
    }
    Ok(UserSearchResult { users })
}

pub fn current_user_id(
    target_org: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let auth = tooling::resolve_org_auth(target_org)?;
    let username = auth
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "unable to determine authenticated username".to_string())?;
    let soql = format!(
        "SELECT Id FROM User WHERE Username = '{}' LIMIT 1",
        escape_soql_literal(username)
    );
    let result = tooling::query_standard(target_org, &soql, cancellation)?;
    result
        .records
        .iter()
        .find_map(|record| record.get("Id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| "unable to determine current org user id".to_string())
}

fn map_user_record(record: &serde_json::Value) -> Option<UserRecord> {
    let id = record.get("Id").and_then(serde_json::Value::as_str)?;
    Some(UserRecord {
        id: id.to_string(),
        name: record
            .get("Name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(id)
            .to_string(),
        username: record
            .get("Username")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        active: record
            .get("IsActive")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}
