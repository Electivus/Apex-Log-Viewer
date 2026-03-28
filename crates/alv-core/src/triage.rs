use crate::logs::{ensure_log_file_cached, extract_code_unit_started, find_cached_log_path};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LogsTriageParams {
    #[serde(rename = "logIds", alias = "log_ids")]
    pub log_ids: Vec<String>,
    pub username: Option<String>,
    #[serde(rename = "workspaceRoot", alias = "workspace_root")]
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogDiagnostic {
    pub code: String,
    pub severity: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogTriageSummary {
    #[serde(rename = "hasErrors")]
    pub has_errors: bool,
    #[serde(rename = "primaryReason", skip_serializing_if = "Option::is_none")]
    pub primary_reason: Option<String>,
    pub reasons: Vec<LogDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogTriageItem {
    #[serde(rename = "logId")]
    pub log_id: String,
    #[serde(rename = "codeUnitStarted", skip_serializing_if = "Option::is_none")]
    pub code_unit_started: Option<String>,
    pub summary: LogTriageSummary,
}

pub fn triage_logs(params: &LogsTriageParams) -> Result<Vec<LogTriageItem>, String> {
    let mut items = Vec::new();

    for log_id in dedup_ids(&params.log_ids) {
        let path = match find_cached_log_path(params.workspace_root.as_deref(), &log_id) {
            Some(existing) => existing,
            None => ensure_log_file_cached(
                &log_id,
                params.username.as_deref(),
                params.workspace_root.as_deref(),
            )?,
        };

        let contents = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read cached log {}: {error}", path.display()))?;
        let lines = contents.lines().collect::<Vec<_>>();
        let code_unit_started =
            extract_code_unit_started(&lines.iter().take(10).copied().collect::<Vec<_>>());
        let summary = summarize_lines(&lines);

        items.push(LogTriageItem {
            log_id,
            code_unit_started,
            summary,
        });
    }

    Ok(items)
}

fn summarize_lines(lines: &[&str]) -> LogTriageSummary {
    for (index, line) in lines.iter().enumerate() {
        if let Some(diagnostic) = classify_line(line, index + 1) {
            let primary_reason = Some(diagnostic.summary.clone());
            return LogTriageSummary {
                has_errors: diagnostic.severity == "error",
                primary_reason,
                reasons: vec![diagnostic],
            };
        }
    }

    LogTriageSummary {
        has_errors: false,
        primary_reason: None,
        reasons: Vec::new(),
    }
}

fn classify_line(line: &str, line_number: usize) -> Option<LogDiagnostic> {
    let event_type = extract_log_event_type(line)?;
    let tokens = tokenize_event_type(&event_type);
    if !tokens.iter().any(|token| is_error_token(token)) {
        return None;
    }

    let (code, severity, summary) = if tokens
        .iter()
        .any(|token| *token == "ASSERT" || *token == "ASSERTION")
    {
        (
            "assertion_failure".to_string(),
            "error".to_string(),
            "Assertion failure".to_string(),
        )
    } else if tokens.iter().any(|token| *token == "VALIDATION") {
        (
            "validation_failure".to_string(),
            "error".to_string(),
            "Validation failure".to_string(),
        )
    } else if tokens.iter().any(|token| *token == "DML") {
        (
            "dml_failure".to_string(),
            "error".to_string(),
            "DML failure".to_string(),
        )
    } else if tokens.iter().any(|token| *token == "ROLLBACK") {
        (
            "rollback_detected".to_string(),
            "warning".to_string(),
            "Rollback detected".to_string(),
        )
    } else if tokens
        .iter()
        .any(|token| *token == "EXCEPTION" || *token == "FATAL")
    {
        (
            "fatal_exception".to_string(),
            "error".to_string(),
            "Fatal exception".to_string(),
        )
    } else {
        (
            "suspicious_error_payload".to_string(),
            "warning".to_string(),
            format!("Potential error event ({event_type})"),
        )
    };

    Some(LogDiagnostic {
        code,
        severity,
        summary,
        line: Some(line_number as u64),
        event_type: Some(event_type),
    })
}

fn extract_log_event_type(line: &str) -> Option<String> {
    let mut parts = line.split('|');
    let _timestamp = parts.next()?;
    let event_type = parts.next()?.trim();
    if event_type.is_empty() {
        None
    } else {
        Some(event_type.to_string())
    }
}

fn tokenize_event_type(event_type: &str) -> Vec<String> {
    event_type
        .split(|character: char| !character.is_ascii_alphabetic())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_uppercase())
        .collect()
}

fn is_error_token(token: &str) -> bool {
    matches!(
        token,
        "EXCEPTION"
            | "ERROR"
            | "FATAL"
            | "FAIL"
            | "FAILED"
            | "FAILURE"
            | "FAULT"
            | "ASSERT"
            | "ASSERTION"
            | "VALIDATION"
            | "DML"
            | "ROLLBACK"
    )
}

fn dedup_ids(log_ids: &[String]) -> Vec<String> {
    let mut deduped = Vec::new();
    for log_id in log_ids {
        let trimmed = log_id.trim();
        if trimmed.is_empty() || deduped.iter().any(|existing| existing == trimmed) {
            continue;
        }
        deduped.push(trimmed.to_string());
    }
    deduped
}
