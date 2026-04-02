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
type CachedLogPathIndex = BTreeMap<String, Vec<PathBuf>>;

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
    let path_index = build_cached_log_path_index(
        params.workspace_root.as_deref(),
        raw_username_hint,
        canonical_username.as_deref(),
        cancellation,
    )?;

    for log_id in dedup_ids(&params.log_ids) {
        cancellation.check_cancelled()?;
        let Some(paths) = path_index.get(&log_id) else {
            result.pending_log_ids.push(log_id);
            continue;
        };

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

fn build_cached_log_path_index(
    workspace_root: Option<&str>,
    raw_username_hint: Option<&str>,
    canonical_username: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<CachedLogPathIndex, String> {
    match canonical_username {
        Some(username) => build_scoped_cached_log_path_index(
            workspace_root,
            raw_username_hint,
            username,
            cancellation,
        ),
        None => {
            if let Some(raw_username) = raw_username_hint
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                build_raw_scoped_cached_log_path_index(workspace_root, raw_username, cancellation)
            } else {
                build_unscoped_cached_log_path_index(workspace_root, cancellation)
            }
        }
    }
}

fn build_unscoped_cached_log_path_index(
    workspace_root: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<CachedLogPathIndex, String> {
    let root = log_store::resolve_apexlogs_root(workspace_root);
    let mut index = CachedLogPathIndex::new();

    collect_log_path_index_in_tree(&root.join("orgs"), cancellation, &mut index)?;
    collect_root_log_path_index(&root, &[], true, cancellation, &mut index)?;
    sort_and_dedup_path_index(&mut index);

    Ok(index)
}

fn build_scoped_cached_log_path_index(
    workspace_root: Option<&str>,
    raw_username: Option<&str>,
    canonical_username: &str,
    cancellation: &CancellationToken,
) -> Result<CachedLogPathIndex, String> {
    let root = log_store::resolve_apexlogs_root(workspace_root);
    let mut index = CachedLogPathIndex::new();

    collect_log_path_index_in_tree(
        &log_store::org_dir(workspace_root, canonical_username).join("logs"),
        cancellation,
        &mut index,
    )?;

    let canonical_safe = log_store::safe_target_org(canonical_username);
    let mut allowed_prefixes = vec![canonical_safe];
    if let Some(raw_username) = raw_username
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let raw_safe = log_store::safe_target_org(raw_username);
        if raw_safe != allowed_prefixes[0] {
            allowed_prefixes.push(raw_safe);
        }
    }

    collect_root_log_path_index(&root, &allowed_prefixes, true, cancellation, &mut index)?;
    sort_and_dedup_path_index(&mut index);

    Ok(index)
}

fn build_raw_scoped_cached_log_path_index(
    workspace_root: Option<&str>,
    raw_username: &str,
    cancellation: &CancellationToken,
) -> Result<CachedLogPathIndex, String> {
    let root = log_store::resolve_apexlogs_root(workspace_root);
    let mut index = CachedLogPathIndex::new();

    collect_log_path_index_in_tree(
        &log_store::org_dir(workspace_root, raw_username).join("logs"),
        cancellation,
        &mut index,
    )?;

    let raw_safe = log_store::safe_target_org(raw_username);
    let allowed_prefixes = vec![raw_safe];
    collect_root_log_path_index(&root, &allowed_prefixes, true, cancellation, &mut index)?;
    sort_and_dedup_path_index(&mut index);

    Ok(index)
}

fn collect_log_path_index_in_tree(
    root: &Path,
    cancellation: &CancellationToken,
    index: &mut CachedLogPathIndex,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }

    let Ok(entries) = fs::read_dir(root) else {
        return Ok(());
    };

    for entry in entries.flatten() {
        cancellation.check_cancelled()?;

        let path = entry.path();
        if path.is_dir() {
            collect_log_path_index_in_tree(&path, cancellation, index)?;
            continue;
        }

        let Some(file_name) = path.file_name() else {
            continue;
        };
        let file_name = file_name.to_string_lossy();
        let Some(log_id) = file_name.strip_suffix(".log").map(str::to_string) else {
            continue;
        };
        if log_id.trim().is_empty() {
            continue;
        }

        push_index_path(index, &log_id, path);
    }

    Ok(())
}

fn collect_root_log_path_index(
    root: &Path,
    allowed_prefixes: &[String],
    include_all_prefixed_paths: bool,
    cancellation: &CancellationToken,
    index: &mut CachedLogPathIndex,
) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(());
    };

    for entry in entries.flatten() {
        cancellation.check_cancelled()?;

        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(file_name) = path.file_name() else {
            continue;
        };
        let file_name = file_name.to_string_lossy();
        let Some((prefix, log_id)) = parse_root_log_file_name(&file_name) else {
            continue;
        };
        let log_id = log_id.to_string();

        if let Some(prefix) = prefix {
            let include_prefixed = include_all_prefixed_paths
                || allowed_prefixes
                    .iter()
                    .any(|allowed_prefix| allowed_prefix == prefix);
            if !include_prefixed {
                continue;
            }
        }

        if log_id.trim().is_empty() {
            continue;
        }
        push_index_path(index, &log_id, path);
    }

    Ok(())
}

fn parse_root_log_file_name(file_name: &str) -> Option<(Option<&str>, &str)> {
    let stem = file_name.strip_suffix(".log")?;
    match stem.rsplit_once('_') {
        Some((prefix, log_id)) if !prefix.is_empty() && !log_id.is_empty() => {
            Some((Some(prefix), log_id))
        }
        _ if !stem.is_empty() => Some((None, stem)),
        _ => None,
    }
}

fn push_index_path(index: &mut CachedLogPathIndex, log_id: &str, path: PathBuf) {
    index.entry(log_id.to_string()).or_default().push(path);
}

fn sort_and_dedup_path_index(index: &mut CachedLogPathIndex) {
    for paths in index.values_mut() {
        paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
        paths.dedup();
    }
}
