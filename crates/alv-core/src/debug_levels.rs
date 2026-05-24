use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    logs::CancellationToken,
    tooling::{self, escape_soql_literal},
};

const DEBUG_LEVEL_FIELDS: &str = "Id, DeveloperName, MasterLabel, Language, Workflow, Validation, Callout, ApexCode, ApexProfiling, Visualforce, System, Database, Wave, Nba, DataAccess";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DebugLevelRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub developer_name: String,
    #[serde(default)]
    pub master_label: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub workflow: String,
    #[serde(default)]
    pub validation: String,
    #[serde(default)]
    pub callout: String,
    #[serde(default)]
    pub apex_code: String,
    #[serde(default)]
    pub apex_profiling: String,
    #[serde(default)]
    pub visualforce: String,
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub wave: String,
    #[serde(default)]
    pub nba: String,
    #[serde(default)]
    pub data_access: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLevelListParams {
    pub target_org: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLevelGetParams {
    pub target_org: Option<String>,
    pub id: Option<String>,
    pub developer_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLevelWriteParams {
    pub target_org: Option<String>,
    pub id: Option<String>,
    pub record: DebugLevelRecord,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLevelDeleteParams {
    pub target_org: Option<String>,
    pub id: String,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLevelWriteResult {
    pub status: String,
    pub dry_run: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<DebugLevelRecord>,
}

pub fn list_debug_levels(
    params: &DebugLevelListParams,
    cancellation: &CancellationToken,
) -> Result<Vec<DebugLevelRecord>, String> {
    let soql = format!("SELECT {DEBUG_LEVEL_FIELDS} FROM DebugLevel ORDER BY DeveloperName");
    let result = tooling::query_tooling(params.target_org.as_deref(), &soql, cancellation)?;
    Ok(result.records.iter().map(map_debug_level_record).collect())
}

pub fn get_debug_level(
    params: &DebugLevelGetParams,
    cancellation: &CancellationToken,
) -> Result<Option<DebugLevelRecord>, String> {
    let where_clause = if let Some(id) = params
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        format!("Id = '{}'", escape_soql_literal(id))
    } else if let Some(name) = params
        .developer_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        format!("DeveloperName = '{}'", escape_soql_literal(name))
    } else {
        return Err("debug level get requires id or developerName".to_string());
    };
    let soql = format!("SELECT {DEBUG_LEVEL_FIELDS} FROM DebugLevel WHERE {where_clause} LIMIT 1");
    let result = tooling::query_tooling(params.target_org.as_deref(), &soql, cancellation)?;
    Ok(result.records.first().map(map_debug_level_record))
}

pub fn create_debug_level(
    params: &DebugLevelWriteParams,
    cancellation: &CancellationToken,
) -> Result<DebugLevelWriteResult, String> {
    validate_write(params)?;
    let payload = build_payload(&params.record)?;
    if params.dry_run {
        return Ok(DebugLevelWriteResult {
            status: "dry-run".to_string(),
            dry_run: true,
            id: None,
            record: Some(params.record.clone()),
        });
    }
    let result = tooling::sobject_create(
        params.target_org.as_deref(),
        true,
        "DebugLevel",
        &payload,
        cancellation,
    )?;
    Ok(DebugLevelWriteResult {
        status: if result.success { "success" } else { "error" }.to_string(),
        dry_run: false,
        id: result.id,
        record: None,
    })
}

pub fn update_debug_level(
    params: &DebugLevelWriteParams,
    cancellation: &CancellationToken,
) -> Result<DebugLevelWriteResult, String> {
    validate_write(params)?;
    let id = params
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "debug level update requires id".to_string())?;
    let payload = build_payload(&params.record)?;
    if params.dry_run {
        return Ok(DebugLevelWriteResult {
            status: "dry-run".to_string(),
            dry_run: true,
            id: Some(id.to_string()),
            record: Some(params.record.clone()),
        });
    }
    let result = tooling::sobject_update(
        params.target_org.as_deref(),
        true,
        "DebugLevel",
        id,
        &payload,
        cancellation,
    )?;
    Ok(DebugLevelWriteResult {
        status: if result.success { "success" } else { "error" }.to_string(),
        dry_run: false,
        id: Some(id.to_string()),
        record: None,
    })
}

pub fn delete_debug_level(
    params: &DebugLevelDeleteParams,
    cancellation: &CancellationToken,
) -> Result<DebugLevelWriteResult, String> {
    if !params.dry_run && !params.confirmed {
        return Err("live debug level delete requires --yes or confirmed=true".to_string());
    }
    let id = params.id.trim();
    if id.is_empty() {
        return Err("debug level delete requires id".to_string());
    }
    if params.dry_run {
        return Ok(DebugLevelWriteResult {
            status: "dry-run".to_string(),
            dry_run: true,
            id: Some(id.to_string()),
            record: None,
        });
    }
    let result = tooling::sobject_delete(
        params.target_org.as_deref(),
        true,
        "DebugLevel",
        id,
        cancellation,
    )?;
    Ok(DebugLevelWriteResult {
        status: if result.success { "success" } else { "error" }.to_string(),
        dry_run: false,
        id: Some(id.to_string()),
        record: None,
    })
}

fn validate_write(params: &DebugLevelWriteParams) -> Result<(), String> {
    if !params.dry_run && !params.confirmed {
        return Err("live debug level write requires --yes or confirmed=true".to_string());
    }
    if params.record.developer_name.trim().is_empty() {
        return Err("developerName is required".to_string());
    }
    Ok(())
}

fn build_payload(record: &DebugLevelRecord) -> Result<Value, String> {
    Ok(json!({
        "DeveloperName": record.developer_name.trim(),
        "MasterLabel": fallback(&record.master_label, &record.developer_name),
        "Language": fallback(&record.language, "None"),
        "Workflow": fallback(&record.workflow, "INFO"),
        "Validation": fallback(&record.validation, "INFO"),
        "Callout": fallback(&record.callout, "INFO"),
        "ApexCode": fallback(&record.apex_code, "DEBUG"),
        "ApexProfiling": fallback(&record.apex_profiling, "INFO"),
        "Visualforce": fallback(&record.visualforce, "INFO"),
        "System": fallback(&record.system, "DEBUG"),
        "Database": fallback(&record.database, "INFO"),
        "Wave": fallback(&record.wave, "INFO"),
        "Nba": fallback(&record.nba, "INFO"),
        "DataAccess": fallback(&record.data_access, "INFO"),
    }))
}

fn fallback<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    }
}

fn map_debug_level_record(record: &Value) -> DebugLevelRecord {
    DebugLevelRecord {
        id: string_field(record, "Id"),
        developer_name: string_field(record, "DeveloperName").unwrap_or_default(),
        master_label: string_field(record, "MasterLabel").unwrap_or_default(),
        language: string_field(record, "Language").unwrap_or_default(),
        workflow: string_field(record, "Workflow").unwrap_or_default(),
        validation: string_field(record, "Validation").unwrap_or_default(),
        callout: string_field(record, "Callout").unwrap_or_default(),
        apex_code: string_field(record, "ApexCode").unwrap_or_default(),
        apex_profiling: string_field(record, "ApexProfiling").unwrap_or_default(),
        visualforce: string_field(record, "Visualforce").unwrap_or_default(),
        system: string_field(record, "System").unwrap_or_default(),
        database: string_field(record, "Database").unwrap_or_default(),
        wave: string_field(record, "Wave").unwrap_or_default(),
        nba: string_field(record, "Nba").unwrap_or_default(),
        data_access: string_field(record, "DataAccess").unwrap_or_default(),
    }
}

fn string_field(record: &Value, key: &str) -> Option<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
