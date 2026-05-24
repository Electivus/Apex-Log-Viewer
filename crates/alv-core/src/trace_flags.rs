use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    debug_levels,
    logs::CancellationToken,
    tooling::{self, escape_soql_literal},
    users,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TraceFlagTarget {
    User {
        #[serde(rename = "userId", alias = "user_id")]
        user_id: String,
    },
    AutomatedProcess,
    PlatformIntegration,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFlagStatusParams {
    pub target_org: Option<String>,
    pub target: TraceFlagTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFlagApplyParams {
    pub target_org: Option<String>,
    pub target: TraceFlagTarget,
    pub debug_level_name: String,
    pub ttl_minutes: Option<u64>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFlagRemoveParams {
    pub target_org: Option<String>,
    pub target: TraceFlagTarget,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFlagTargetStatus {
    pub target: TraceFlagTarget,
    pub target_label: String,
    pub target_available: bool,
    pub is_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_flag_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_level_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<String>,
    pub resolved_target_count: usize,
    pub active_target_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_level_mixed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFlagApplyResult {
    pub status: String,
    pub dry_run: bool,
    pub created: bool,
    pub created_count: usize,
    pub updated_count: usize,
    pub resolved_target_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trace_flag_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFlagRemoveResult {
    pub status: String,
    pub dry_run: bool,
    pub removed_count: usize,
    pub resolved_target_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trace_flag_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct ResolvedTarget {
    label: String,
    ids: Vec<String>,
}

pub fn status(
    params: &TraceFlagStatusParams,
    cancellation: &CancellationToken,
) -> Result<TraceFlagTargetStatus, String> {
    let resolved = resolve_target(params.target_org.as_deref(), &params.target, cancellation)?;
    if resolved.ids.is_empty() {
        return Ok(TraceFlagTargetStatus {
            target: params.target.clone(),
            target_label: resolved.label,
            target_available: false,
            is_active: false,
            trace_flag_id: None,
            debug_level_name: None,
            start_date: None,
            expiration_date: None,
            resolved_target_count: 0,
            active_target_count: 0,
            debug_level_mixed: None,
        });
    }
    let records =
        latest_trace_flag_records(params.target_org.as_deref(), &resolved.ids, cancellation)?;
    Ok(build_status(params.target.clone(), resolved, records))
}

pub fn apply(
    params: &TraceFlagApplyParams,
    cancellation: &CancellationToken,
) -> Result<TraceFlagApplyResult, String> {
    if !params.dry_run && !params.confirmed {
        return Err("live trace flag apply requires --yes or confirmed=true".to_string());
    }
    let debug_level_name = params.debug_level_name.trim();
    if debug_level_name.is_empty() {
        return Err("debugLevelName is required".to_string());
    }
    let resolved = resolve_target(params.target_org.as_deref(), &params.target, cancellation)?;
    if resolved.ids.is_empty() {
        return Err(format!(
            "trace flag target '{}' was not found",
            resolved.label
        ));
    }
    let debug_level = debug_levels::get_debug_level(
        &debug_levels::DebugLevelGetParams {
            target_org: params.target_org.clone(),
            id: None,
            developer_name: Some(debug_level_name.to_string()),
        },
        cancellation,
    )?
    .ok_or_else(|| format!("debug level '{debug_level_name}' was not found"))?;
    let debug_level_id = debug_level
        .id
        .ok_or_else(|| format!("debug level '{debug_level_name}' has no id"))?;
    let ttl_minutes = params.ttl_minutes.unwrap_or(30).clamp(1, 1440);
    let now = chrono::Utc::now();
    let start = to_sf_datetime(now - chrono::Duration::seconds(1));
    let expiration = to_sf_datetime(now + chrono::Duration::minutes(ttl_minutes as i64));

    if params.dry_run {
        return Ok(TraceFlagApplyResult {
            status: "dry-run".to_string(),
            dry_run: true,
            created: false,
            created_count: 0,
            updated_count: 0,
            resolved_target_count: resolved.ids.len(),
            trace_flag_ids: Vec::new(),
        });
    }

    let mut created_count = 0usize;
    let mut updated_count = 0usize;
    let mut trace_flag_ids = Vec::new();
    for traced_entity_id in &resolved.ids {
        let existing_id =
            latest_trace_flag_id(params.target_org.as_deref(), traced_entity_id, cancellation)?;
        if let Some(existing_id) = existing_id {
            let payload = json!({
                "DebugLevelId": debug_level_id,
                "StartDate": start,
                "ExpirationDate": expiration,
            });
            let result = tooling::sobject_update(
                params.target_org.as_deref(),
                true,
                "TraceFlag",
                &existing_id,
                &payload,
                cancellation,
            )?;
            if !result.success {
                return Err(format!(
                    "failed to update USER_DEBUG TraceFlag '{existing_id}'"
                ));
            }
            updated_count += 1;
            trace_flag_ids.push(existing_id);
            continue;
        }

        let payload = json!({
            "TracedEntityId": traced_entity_id,
            "LogType": "USER_DEBUG",
            "DebugLevelId": debug_level_id,
            "StartDate": start,
            "ExpirationDate": expiration,
        });
        let result = tooling::sobject_create(
            params.target_org.as_deref(),
            true,
            "TraceFlag",
            &payload,
            cancellation,
        )?;
        if !result.success {
            return Err("failed to create USER_DEBUG TraceFlag".to_string());
        }
        created_count += 1;
        if let Some(id) = result.id {
            trace_flag_ids.push(id);
        }
    }

    Ok(TraceFlagApplyResult {
        status: "success".to_string(),
        dry_run: false,
        created: created_count > 0 && updated_count == 0,
        created_count,
        updated_count,
        resolved_target_count: resolved.ids.len(),
        trace_flag_ids,
    })
}

pub fn remove(
    params: &TraceFlagRemoveParams,
    cancellation: &CancellationToken,
) -> Result<TraceFlagRemoveResult, String> {
    if !params.dry_run && !params.confirmed {
        return Err("live trace flag remove requires --yes or confirmed=true".to_string());
    }
    let resolved = resolve_target(params.target_org.as_deref(), &params.target, cancellation)?;
    if resolved.ids.is_empty() {
        return Err(format!(
            "trace flag target '{}' was not found",
            resolved.label
        ));
    }
    let mut ids = Vec::new();
    for traced_entity_id in &resolved.ids {
        ids.extend(trace_flag_ids(
            params.target_org.as_deref(),
            traced_entity_id,
            cancellation,
        )?);
    }
    if params.dry_run {
        return Ok(TraceFlagRemoveResult {
            status: "dry-run".to_string(),
            dry_run: true,
            removed_count: 0,
            resolved_target_count: resolved.ids.len(),
            trace_flag_ids: ids,
        });
    }

    let mut removed_count = 0usize;
    for id in &ids {
        let result = tooling::sobject_delete(
            params.target_org.as_deref(),
            true,
            "TraceFlag",
            id,
            cancellation,
        )?;
        if !result.success {
            return Err(format!("failed to delete USER_DEBUG TraceFlag '{id}'"));
        }
        removed_count += 1;
    }
    Ok(TraceFlagRemoveResult {
        status: "success".to_string(),
        dry_run: false,
        removed_count,
        resolved_target_count: resolved.ids.len(),
        trace_flag_ids: ids,
    })
}

fn resolve_target(
    target_org: Option<&str>,
    target: &TraceFlagTarget,
    cancellation: &CancellationToken,
) -> Result<ResolvedTarget, String> {
    match target {
        TraceFlagTarget::User { user_id } => {
            let id = user_id.trim();
            Ok(ResolvedTarget {
                label: "User".to_string(),
                ids: if id.is_empty() {
                    vec![users::current_user_id(target_org, cancellation)?]
                } else {
                    vec![id.to_string()]
                },
            })
        }
        TraceFlagTarget::AutomatedProcess => Ok(ResolvedTarget {
            label: "Automated Process".to_string(),
            ids: query_user_ids_by_type(target_org, "AutomatedProcess", cancellation)?,
        }),
        TraceFlagTarget::PlatformIntegration => Ok(ResolvedTarget {
            label: "Platform Integration".to_string(),
            ids: query_user_ids_by_type(target_org, "CloudIntegrationUser", cancellation)?,
        }),
    }
}

fn query_user_ids_by_type(
    target_org: Option<&str>,
    user_type: &str,
    cancellation: &CancellationToken,
) -> Result<Vec<String>, String> {
    let soql = format!(
        "SELECT Id FROM User WHERE UserType = '{}' AND IsActive = true ORDER BY Id LIMIT 200",
        escape_soql_literal(user_type)
    );
    let result = tooling::query_standard(target_org, &soql, cancellation)?;
    Ok(result
        .records
        .iter()
        .filter_map(|record| record.get("Id").and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

fn latest_trace_flag_records(
    target_org: Option<&str>,
    traced_entity_ids: &[String],
    cancellation: &CancellationToken,
) -> Result<Vec<Value>, String> {
    let mut records = Vec::new();
    for id in traced_entity_ids {
        if let Some(record) = latest_trace_flag_record(target_org, id, cancellation)? {
            records.push(record);
        }
    }
    Ok(records)
}

fn latest_trace_flag_record(
    target_org: Option<&str>,
    traced_entity_id: &str,
    cancellation: &CancellationToken,
) -> Result<Option<Value>, String> {
    let soql = format!(
        "SELECT Id, DebugLevel.DeveloperName, StartDate, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '{}' AND LogType = 'USER_DEBUG' ORDER BY CreatedDate DESC LIMIT 1",
        escape_soql_literal(traced_entity_id)
    );
    let result = tooling::query_tooling(target_org, &soql, cancellation)?;
    Ok(result.records.into_iter().next())
}

fn latest_trace_flag_id(
    target_org: Option<&str>,
    traced_entity_id: &str,
    cancellation: &CancellationToken,
) -> Result<Option<String>, String> {
    Ok(
        latest_trace_flag_record(target_org, traced_entity_id, cancellation)?
            .and_then(|record| record.get("Id").and_then(Value::as_str).map(str::to_string)),
    )
}

fn trace_flag_ids(
    target_org: Option<&str>,
    traced_entity_id: &str,
    cancellation: &CancellationToken,
) -> Result<Vec<String>, String> {
    let soql = format!(
        "SELECT Id FROM TraceFlag WHERE TracedEntityId = '{}' AND LogType = 'USER_DEBUG' ORDER BY CreatedDate DESC LIMIT 200",
        escape_soql_literal(traced_entity_id)
    );
    let result = tooling::query_tooling(target_org, &soql, cancellation)?;
    Ok(result
        .records
        .iter()
        .filter_map(|record| record.get("Id").and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

fn build_status(
    target: TraceFlagTarget,
    resolved: ResolvedTarget,
    records: Vec<Value>,
) -> TraceFlagTargetStatus {
    let active = records
        .iter()
        .filter(|record| {
            is_trace_flag_active(
                record.get("StartDate").and_then(Value::as_str),
                record.get("ExpirationDate").and_then(Value::as_str),
            )
        })
        .collect::<Vec<_>>();
    let debug_level_names = active
        .iter()
        .filter_map(|record| {
            record
                .get("DebugLevel")
                .and_then(|value| value.get("DeveloperName"))
                .and_then(Value::as_str)
        })
        .collect::<std::collections::BTreeSet<_>>();
    let first = active.first().copied();
    let debug_level_mixed = active.len() > 1 && debug_level_names.len() != 1;
    TraceFlagTargetStatus {
        target,
        target_label: resolved.label,
        target_available: !resolved.ids.is_empty(),
        is_active: !active.is_empty(),
        trace_flag_id: first
            .and_then(|record| record.get("Id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        debug_level_name: if debug_level_mixed {
            None
        } else {
            debug_level_names
                .iter()
                .next()
                .map(|value| (*value).to_string())
        },
        start_date: first
            .and_then(|record| record.get("StartDate"))
            .and_then(Value::as_str)
            .map(str::to_string),
        expiration_date: first
            .and_then(|record| record.get("ExpirationDate"))
            .and_then(Value::as_str)
            .map(str::to_string),
        resolved_target_count: resolved.ids.len(),
        active_target_count: active.len(),
        debug_level_mixed: Some(debug_level_mixed).filter(|value| *value),
    }
}

fn is_trace_flag_active(start: Option<&str>, expiration: Option<&str>) -> bool {
    let now = chrono::Utc::now().timestamp_millis();
    let start_ms = start.and_then(parse_datetime).unwrap_or(i64::MIN);
    let expiration_ms = expiration.and_then(parse_datetime).unwrap_or(i64::MIN);
    start_ms <= now && now <= expiration_ms
}

fn parse_datetime(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z")
                .map(|dt| dt.timestamp_millis())
                .ok()
        })
}

fn to_sf_datetime(value: chrono::DateTime<chrono::Utc>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3f+0000").to_string()
}
