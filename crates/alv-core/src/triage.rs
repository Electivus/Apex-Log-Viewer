use crate::logs::{
    ensure_log_file_cached_with_cancel, extract_code_unit_started, find_cached_log_path,
    CancellationToken,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufRead, BufReader},
    thread,
    time::Duration,
};

const TEST_TRIAGE_LINE_DELAY_MS_ENV: &str = "ALV_TEST_TRIAGE_LINE_DELAY_MS";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogsTriageParams {
    #[serde(alias = "log_ids")]
    pub log_ids: Vec<String>,
    pub username: Option<String>,
    #[serde(alias = "workspace_root")]
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct LogTriageSummary {
    pub has_errors: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_reason: Option<String>,
    pub reasons: Vec<LogDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTriageItem {
    pub log_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_unit_started: Option<String>,
    pub summary: LogTriageSummary,
}

pub fn triage_logs(params: &LogsTriageParams) -> Result<Vec<LogTriageItem>, String> {
    triage_logs_with_cancel(params, &CancellationToken::new())
}

pub fn triage_logs_with_cancel(
    params: &LogsTriageParams,
    cancellation: &CancellationToken,
) -> Result<Vec<LogTriageItem>, String> {
    let mut items = Vec::new();

    for log_id in dedup_ids(&params.log_ids) {
        cancellation.check_cancelled()?;
        match triage_log_item(&log_id, params, cancellation) {
            Ok(item) => items.push(item),
            Err(error) => {
                if cancellation.is_cancelled() {
                    return Err(error);
                }

                items.push(LogTriageItem {
                    log_id,
                    code_unit_started: None,
                    summary: create_unreadable_summary(&error),
                });
            }
        }
    }

    Ok(items)
}

fn triage_log_item(
    log_id: &str,
    params: &LogsTriageParams,
    cancellation: &CancellationToken,
) -> Result<LogTriageItem, String> {
    let path = match find_cached_log_path(params.workspace_root.as_deref(), log_id) {
        Some(existing) => existing,
        None => ensure_log_file_cached_with_cancel(
            log_id,
            params.username.as_deref(),
            params.workspace_root.as_deref(),
            cancellation,
        )?,
    };

    let (code_unit_started, summary) = summarize_file(&path, cancellation)?;

    Ok(LogTriageItem {
        log_id: log_id.to_string(),
        code_unit_started,
        summary,
    })
}

fn summarize_file(
    path: &std::path::Path,
    cancellation: &CancellationToken,
) -> Result<(Option<String>, LogTriageSummary), String> {
    let file = File::open(path)
        .map_err(|error| format!("failed to read cached log {}: {error}", path.display()))?;
    let reader = BufReader::new(file);
    let mut code_unit_started = None::<String>;
    let mut first_diagnostic = None::<LogDiagnostic>;

    for (index, line) in reader.lines().enumerate() {
        cancellation.check_cancelled()?;
        maybe_test_delay(cancellation)?;
        let line =
            line.map_err(|error| format!("failed to read cached log {}: {error}", path.display()))?;

        if index < 10 && code_unit_started.is_none() {
            code_unit_started = extract_code_unit_started(&[line.as_str()]);
        }

        if first_diagnostic.is_none() {
            first_diagnostic = classify_line(&line, index + 1);
            if first_diagnostic.is_some() && index >= 9 {
                break;
            }
        } else if index >= 9 {
            break;
        }
    }

    let summary = match first_diagnostic {
        Some(diagnostic) => LogTriageSummary {
            has_errors: diagnostic.severity == "error",
            primary_reason: Some(diagnostic.summary.clone()),
            reasons: vec![diagnostic],
        },
        None => LogTriageSummary {
            has_errors: false,
            primary_reason: None,
            reasons: Vec::new(),
        },
    };

    Ok((code_unit_started, summary))
}

fn maybe_test_delay(cancellation: &CancellationToken) -> Result<(), String> {
    let Some(delay_ms) = std::env::var(TEST_TRIAGE_LINE_DELAY_MS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
    else {
        return Ok(());
    };

    let deadline = std::time::Instant::now() + Duration::from_millis(delay_ms);
    while std::time::Instant::now() < deadline {
        cancellation.check_cancelled()?;
        thread::sleep(Duration::from_millis(2));
    }

    cancellation.check_cancelled()
}

fn create_unreadable_summary(message: &str) -> LogTriageSummary {
    let trimmed = message.trim();
    let primary_reason = if trimmed.is_empty() {
        "Log triage unavailable".to_string()
    } else {
        format!("Log triage unavailable: {trimmed}")
    };

    LogTriageSummary {
        has_errors: true,
        primary_reason: Some(primary_reason.clone()),
        reasons: vec![LogDiagnostic {
            code: "suspicious_error_payload".to_string(),
            severity: "warning".to_string(),
            summary: primary_reason,
            line: None,
            event_type: None,
        }],
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

#[cfg(test)]
mod tests {
    use super::classify_line;

    #[test]
    fn classify_line_ignores_non_error_dml_events() {
        assert_eq!(
            classify_line("09:00:00.0|DML_BEGIN|[7]|Op:Insert|Type:Account", 1),
            None
        );
        assert_eq!(classify_line("09:00:01.0|DML_END|[7]", 2), None);
    }

    #[test]
    fn classify_line_keeps_dml_failures_when_error_token_is_present() {
        let diagnostic =
            classify_line("09:00:00.0|DML_ERROR|Insert failed", 3).expect("should classify");

        assert_eq!(diagnostic.code, "dml_failure");
        assert_eq!(diagnostic.severity, "error");
        assert_eq!(diagnostic.summary, "DML failure");
        assert_eq!(diagnostic.line, Some(3));
        assert_eq!(diagnostic.event_type.as_deref(), Some("DML_ERROR"));
    }
}
