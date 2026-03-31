use crate::{auth, log_store, logs::CancellationToken};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

const TEST_SEARCH_LINE_DELAY_MS_ENV: &str = "ALV_TEST_SEARCH_LINE_DELAY_MS";
const CANCELLED_MESSAGE: &str = "request cancelled";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SearchQueryParams {
    pub query: String,
    #[serde(rename = "logIds", alias = "log_ids")]
    pub log_ids: Vec<String>,
    pub username: Option<String>,
    #[serde(rename = "rawUsername", alias = "raw_username")]
    pub raw_username: Option<String>,
    #[serde(rename = "workspaceRoot", alias = "workspace_root")]
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchSnippet {
    pub text: String,
    pub ranges: Vec<[usize; 2]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SearchQueryResult {
    #[serde(rename = "logIds")]
    pub log_ids: Vec<String>,
    pub snippets: BTreeMap<String, SearchSnippet>,
    #[serde(rename = "pendingLogIds")]
    pub pending_log_ids: Vec<String>,
}

pub fn search_query(params: &SearchQueryParams) -> Result<SearchQueryResult, String> {
    search_query_with_cancel(params, &CancellationToken::new())
}

pub fn search_query_with_cancel(
    params: &SearchQueryParams,
    cancellation: &CancellationToken,
) -> Result<SearchQueryResult, String> {
    let query = params.query.trim();
    if query.is_empty() {
        return Ok(SearchQueryResult::default());
    }

    cancellation.check_cancelled()?;
    let matcher = RegexMatcherBuilder::new()
        .fixed_strings(true)
        .case_insensitive(true)
        .build(query)
        .map_err(|error| format!("failed to build search matcher: {error}"))?;

    let mut result = SearchQueryResult::default();
    let canonical_username = resolve_canonical_username(params.username.as_deref())
        .ok()
        .flatten();
    let raw_username_hint = params
        .raw_username
        .as_deref()
        .or(params.username.as_deref());

    for log_id in dedup_ids(&params.log_ids) {
        cancellation.check_cancelled()?;
        let paths = match canonical_username.as_deref() {
            Some(username) => find_scoped_cached_log_paths(
                params.workspace_root.as_deref(),
                &log_id,
                raw_username_hint,
                username,
            ),
            None => {
                if let Some(raw_username) = raw_username_hint
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    find_raw_scoped_cached_log_paths(
                        params.workspace_root.as_deref(),
                        &log_id,
                        raw_username,
                    )
                } else {
                    find_cached_log_paths(params.workspace_root.as_deref(), &log_id)
                }
            }
        };
        if paths.is_empty() {
            result.pending_log_ids.push(log_id);
            continue;
        }

        let mut matched_line = None::<String>;
        for path in paths {
            let file = File::open(&path)
                .map_err(|error| format!("failed to search {}: {error}", path.display()))?;
            let reader = BufReader::new(file);
            for line in reader.lines() {
                maybe_test_delay(cancellation).map_err(|error| error.to_string())?;
                cancellation.check_cancelled()?;
                let line =
                    line.map_err(|error| format!("failed to search {}: {error}", path.display()))?;
                if matcher
                    .find(line.as_bytes())
                    .map_err(|error| format!("failed to search {}: {error}", path.display()))?
                    .is_some()
                {
                    matched_line = Some(line);
                    break;
                }
            }

            if matched_line.is_some() {
                break;
            }
        }

        let Some(line) = matched_line else {
            continue;
        };

        result.log_ids.push(log_id.clone());
        if let Some(snippet) = build_snippet(&matcher, &line) {
            result.snippets.insert(log_id, snippet);
        }
    }

    Ok(result)
}

fn maybe_test_delay(cancellation: &CancellationToken) -> io::Result<()> {
    let Some(delay_ms) = std::env::var(TEST_SEARCH_LINE_DELAY_MS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
    else {
        return Ok(());
    };

    let deadline = std::time::Instant::now() + Duration::from_millis(delay_ms);
    while std::time::Instant::now() < deadline {
        if cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                CANCELLED_MESSAGE,
            ));
        }
        thread::sleep(Duration::from_millis(2));
    }

    if cancellation.is_cancelled() {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            CANCELLED_MESSAGE,
        ));
    }

    Ok(())
}

fn build_snippet(matcher: &grep_regex::RegexMatcher, line: &str) -> Option<SearchSnippet> {
    if line.is_empty() {
        return None;
    }

    let mat = matcher
        .find(line.as_bytes())
        .map_err(io::Error::other)
        .ok()
        .flatten()?;

    let char_start = byte_offset_to_string_index(line, mat.start());
    let char_end = byte_offset_to_string_index(line, mat.end());

    let context = 60usize;
    let slice_start = char_start.saturating_sub(context);
    let slice_end = std::cmp::min(line.chars().count(), char_end.saturating_add(context));
    let core = slice_chars(line, slice_start, slice_end);
    let prefix = if slice_start > 0 { "..." } else { "" };
    let suffix = if slice_end < line.chars().count() {
        "..."
    } else {
        ""
    };
    let prefix_length = prefix.chars().count();
    let adjusted_start = char_start
        .saturating_sub(slice_start)
        .saturating_add(prefix_length);
    let adjusted_end = char_end
        .saturating_sub(slice_start)
        .saturating_add(prefix_length);

    Some(SearchSnippet {
        text: format!("{prefix}{core}{suffix}"),
        ranges: vec![[adjusted_start, std::cmp::max(adjusted_start, adjusted_end)]],
    })
}

fn byte_offset_to_string_index(text: &str, byte_offset: usize) -> usize {
    if byte_offset == 0 {
        return 0;
    }

    let mut byte_tally = 0usize;
    let mut index = 0usize;
    while index < text.len() {
        let Some(code_point) = text[index..].chars().next() else {
            break;
        };
        let utf8_length = code_point.len_utf8();
        if byte_tally + utf8_length > byte_offset {
            break;
        }
        byte_tally += utf8_length;
        index += utf8_length;
    }

    text[..index].chars().count()
}

fn slice_chars(text: &str, start: usize, end: usize) -> String {
    text.chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
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

fn find_cached_log_paths(workspace_root: Option<&str>, log_id: &str) -> Vec<PathBuf> {
    let root = log_store::resolve_apexlogs_root(workspace_root);
    let mut paths = Vec::new();

    collect_log_paths_in_tree(&root.join("orgs"), log_id, &mut paths);

    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name() else {
                continue;
            };
            let file_name = file_name.to_string_lossy();
            if file_name == format!("{log_id}.log")
                || file_name.ends_with(&format!("_{log_id}.log"))
            {
                paths.push(path);
            }
        }
    }

    paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    paths.dedup();
    paths
}

fn find_scoped_cached_log_paths(
    workspace_root: Option<&str>,
    log_id: &str,
    raw_username: Option<&str>,
    canonical_username: &str,
) -> Vec<PathBuf> {
    let root = log_store::resolve_apexlogs_root(workspace_root);
    let mut paths = Vec::new();

    collect_log_paths_in_tree(
        &log_store::org_dir(workspace_root, canonical_username).join("logs"),
        log_id,
        &mut paths,
    );

    push_legacy_scoped_paths(&mut paths, &root, log_id, raw_username, canonical_username);

    paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    paths.dedup();
    paths
}

fn find_raw_scoped_cached_log_paths(
    workspace_root: Option<&str>,
    log_id: &str,
    raw_username: &str,
) -> Vec<PathBuf> {
    let root = log_store::resolve_apexlogs_root(workspace_root);
    let mut paths = Vec::new();

    collect_log_paths_in_tree(
        &log_store::org_dir(workspace_root, raw_username).join("logs"),
        log_id,
        &mut paths,
    );

    let raw_safe = log_store::safe_target_org(raw_username);
    for candidate in [
        root.join(format!("{raw_safe}_{log_id}.log")),
        root.join(format!("{log_id}.log")),
    ] {
        if candidate.is_file() {
            paths.push(candidate);
        }
    }

    paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    paths.dedup();
    paths
}

fn push_legacy_scoped_paths(
    paths: &mut Vec<PathBuf>,
    root: &Path,
    log_id: &str,
    raw_username: Option<&str>,
    canonical_username: &str,
) {
    for candidate in legacy_scoped_paths(root, log_id, raw_username, canonical_username) {
        if candidate.is_file() {
            paths.push(candidate);
        }
    }
}

fn legacy_scoped_paths(
    root: &Path,
    log_id: &str,
    raw_username: Option<&str>,
    canonical_username: &str,
) -> Vec<PathBuf> {
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

fn collect_log_paths_in_tree(root: &Path, log_id: &str, paths: &mut Vec<PathBuf>) {
    if !root.exists() {
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_log_paths_in_tree(&path, log_id, paths);
            continue;
        }

        if path
            .file_name()
            .is_some_and(|file_name| file_name.to_string_lossy() == format!("{log_id}.log"))
        {
            paths.push(path);
        }
    }
}
