use crate::{
    auth, log_store,
    logs::{download_log_to_path_with_cancel, extract_code_unit_started, CancellationToken},
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
    let canonical_username = resolve_canonical_username(params.username.as_deref())
        .ok()
        .flatten();

    for log_id in dedup_ids(&params.log_ids) {
        cancellation.check_cancelled()?;
        let item = triage_log_item(&log_id, params, canonical_username.as_deref(), cancellation);

        match item {
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
    canonical_username: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<LogTriageItem, String> {
    let existing_path = match canonical_username {
        Some(username) => find_scoped_cached_log_path(
            params.workspace_root.as_deref(),
            log_id,
            params.username.as_deref(),
            username,
        ),
        None => {
            if let Some(raw_username) = params
                .username
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                find_raw_scoped_cached_log_path(
                    params.workspace_root.as_deref(),
                    log_id,
                    Some(raw_username),
                )
            } else {
                log_store::find_cached_log_path(params.workspace_root.as_deref(), log_id, None)
            }
        }
    };

    let path = match existing_path {
        Some(existing) => existing,
        None => {
            let resolved_username = canonical_username.unwrap_or("default");
            let target_path = log_store::unknown_date_log_path(
                params.workspace_root.as_deref(),
                resolved_username,
                log_id,
            );
            download_log_to_path_with_cancel(
                log_id,
                params.username.as_deref(),
                &target_path,
                cancellation,
            )?
        }
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

fn resolve_canonical_username(username: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw_username) = username.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if raw_username.contains('@') {
        return Ok(Some(raw_username.to_string()));
    }

    let auth = auth::resolve_org_auth(Some(raw_username))?;
    Ok(Some(
        auth.username.unwrap_or_else(|| raw_username.to_string()),
    ))
}

fn find_scoped_cached_log_path(
    workspace_root: Option<&str>,
    log_id: &str,
    raw_username: Option<&str>,
    canonical_username: &str,
) -> Option<std::path::PathBuf> {
    let scoped_root = log_store::org_dir(workspace_root, canonical_username).join("logs");
    if let Some(found) = find_log_in_tree(&scoped_root, log_id) {
        return Some(found);
    }

    for candidate in legacy_scoped_paths(workspace_root, log_id, raw_username, canonical_username) {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn find_raw_scoped_cached_log_path(
    workspace_root: Option<&str>,
    log_id: &str,
    raw_username: Option<&str>,
) -> Option<std::path::PathBuf> {
    let raw_username = raw_username
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let scoped_root = log_store::org_dir(workspace_root, raw_username).join("logs");
    if let Some(found) = find_log_in_tree(&scoped_root, log_id) {
        return Some(found);
    }

    let root = log_store::resolve_apexlogs_root(workspace_root);
    let raw_safe = log_store::safe_target_org(raw_username);
    for candidate in [
        root.join(format!("{raw_safe}_{log_id}.log")),
        root.join(format!("{log_id}.log")),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn legacy_scoped_paths(
    workspace_root: Option<&str>,
    log_id: &str,
    raw_username: Option<&str>,
    canonical_username: &str,
) -> Vec<std::path::PathBuf> {
    let root = log_store::resolve_apexlogs_root(workspace_root);
    let mut candidates = Vec::new();
    let canonical_safe = log_store::safe_target_org(canonical_username);
    candidates.push(root.join(format!("{canonical_safe}_{log_id}.log")));

    if let Some(raw_username) = raw_username
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let raw_safe = log_store::safe_target_org(raw_username);
        if raw_safe != canonical_safe {
            candidates.push(root.join(format!("{raw_safe}_{log_id}.log")));
        }
    }

    candidates.push(root.join(format!("{log_id}.log")));
    candidates
}

fn find_log_in_tree(root: &std::path::Path, log_id: &str) -> Option<std::path::PathBuf> {
    if !root.exists() {
        return None;
    }

    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_log_in_tree(&path, log_id) {
                return Some(found);
            }
            continue;
        }

        if path
            .file_name()
            .is_some_and(|file_name| file_name.to_string_lossy() == format!("{log_id}.log"))
        {
            return Some(path);
        }
    }

    None
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
    use super::{classify_line, summarize_file, CancellationToken};
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

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

    #[test]
    fn summarize_file_detects_diagnostics_after_the_first_ten_lines() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("alv-triage-{}-{unique}.log", std::process::id()));
        let mut content = String::new();
        for index in 0..10 {
            content.push_str(&format!("09:00:{index:02}.0|USER_DEBUG|[1]|noop\n"));
        }
        content.push_str("09:00:10.0|EXCEPTION_THROWN|System.NullPointerException: boom\n");
        fs::write(&path, content).expect("fixture log should be writable");

        let (_, summary) =
            summarize_file(&path, &CancellationToken::new()).expect("triage should succeed");

        let _ = fs::remove_file(&path);

        assert!(summary.has_errors);
        assert_eq!(summary.primary_reason.as_deref(), Some("Fatal exception"));
        assert_eq!(summary.reasons.len(), 1);
        assert_eq!(summary.reasons[0].line, Some(11));
    }
}
