use crate::logs::find_cached_log_path;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks::UTF8, Searcher};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SearchQueryParams {
    pub query: String,
    #[serde(rename = "logIds", alias = "log_ids")]
    pub log_ids: Vec<String>,
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
    let query = params.query.trim();
    if query.is_empty() {
        return Ok(SearchQueryResult::default());
    }

    let matcher = RegexMatcherBuilder::new()
        .fixed_strings(true)
        .case_insensitive(true)
        .build(query)
        .map_err(|error| format!("failed to build search matcher: {error}"))?;

    let mut result = SearchQueryResult::default();

    for log_id in dedup_ids(&params.log_ids) {
        let Some(path) = find_cached_log_path(params.workspace_root.as_deref(), &log_id) else {
            result.pending_log_ids.push(log_id);
            continue;
        };

        let mut matched_line = None::<String>;
        Searcher::new()
            .search_path(
                &matcher,
                &path,
                UTF8(|_line_number, line| {
                    matched_line = Some(line.trim_end_matches(['\r', '\n']).to_string());
                    Ok(false)
                }),
            )
            .map_err(|error| format!("failed to search {}: {error}", path.display()))?;

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
