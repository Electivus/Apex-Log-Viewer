use crate::{
    log_store,
    logs::{CancellationToken, LogRow},
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

const INDEX_SCHEMA_VERSION: u32 = 1;
const INDEX_FILE_NAME: &str = "log-index.sqlite";
const MAX_SQL_PARAMS: usize = 900;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogIndexRecord {
    pub row: LogRow,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LogIndexSearchResult {
    pub matched_lines: BTreeMap<String, String>,
    pub indexed_log_ids: BTreeSet<String>,
}

pub fn index_path(workspace_root: Option<&str>) -> PathBuf {
    log_store::resolve_apexlogs_root(workspace_root)
        .join(".alv")
        .join(INDEX_FILE_NAME)
}

pub fn count_indexed_logs(workspace_root: Option<&str>, target_org: &str) -> Result<usize, String> {
    let path = index_path(workspace_root);
    if !path.is_file() {
        return Ok(0);
    }
    let conn = open_index(workspace_root)?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM logs WHERE target_org = ?1",
            params![target_org],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to read log index count: {error}"))?;
    Ok(count.max(0) as usize)
}

pub fn index_synced_logs(
    workspace_root: Option<&str>,
    target_org: &str,
    safe_target_org: &str,
    records: &[LogIndexRecord],
    cancellation: &CancellationToken,
) -> Result<usize, String> {
    if records.is_empty() {
        return Ok(0);
    }

    let mut conn = open_index(workspace_root)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to start log index transaction: {error}"))?;
    let indexed_at = timestamp_now();
    let mut indexed = 0usize;

    for record in records {
        cancellation.check_cancelled()?;
        let body = fs::read_to_string(&record.path).map_err(|error| {
            format!(
                "failed to read {} for indexing: {error}",
                record.path.display()
            )
        })?;
        upsert_log(
            &tx,
            target_org,
            safe_target_org,
            &record.row,
            &record.path,
            &body,
            &indexed_at,
        )?;
        indexed += 1;
    }

    tx.commit()
        .map_err(|error| format!("failed to commit log index transaction: {error}"))?;
    Ok(indexed)
}

pub fn rebuild_org_index(
    workspace_root: Option<&str>,
    target_org: &str,
    cancellation: &CancellationToken,
) -> Result<usize, String> {
    let safe_target_org = log_store::safe_target_org(target_org);
    let logs_root = log_store::org_dir(workspace_root, target_org).join("logs");
    let mut paths = Vec::new();
    collect_log_paths(&logs_root, cancellation, &mut paths)?;

    let mut conn = open_index(workspace_root)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to start log index rebuild transaction: {error}"))?;
    clear_org_index(&tx, target_org)?;
    if paths.is_empty() {
        tx.commit()
            .map_err(|error| format!("failed to commit empty log index rebuild: {error}"))?;
        return Ok(0);
    }
    let indexed_at = timestamp_now();
    let mut indexed = 0usize;

    for path in paths {
        cancellation.check_cancelled()?;
        let Some(log_id) = log_id_from_path(&path) else {
            continue;
        };
        let body = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read {} for indexing: {error}", path.display()))?;
        let row = rebuilt_row(&log_id, start_time_from_path(&path));
        upsert_log(
            &tx,
            target_org,
            &safe_target_org,
            &row,
            &path,
            &body,
            &indexed_at,
        )?;
        indexed += 1;
    }

    tx.commit()
        .map_err(|error| format!("failed to commit log index rebuild: {error}"))?;
    Ok(indexed)
}

pub fn search_index_lines(
    workspace_root: Option<&str>,
    target_org: &str,
    query: &str,
    log_ids: &[String],
    cancellation: &CancellationToken,
) -> Result<Option<LogIndexSearchResult>, String> {
    let path = index_path(workspace_root);
    if !path.is_file() {
        return Ok(None);
    }
    let query = query.trim();
    if query.chars().count() < 3 || log_ids.is_empty() {
        return Ok(None);
    }

    let conn = open_index(workspace_root)?;
    let requested = log_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();
    if requested.is_empty() {
        return Ok(Some(LogIndexSearchResult::default()));
    }

    let indexed_log_ids = indexed_log_ids(&conn, target_org, &requested, cancellation)?;
    let mut result = LogIndexSearchResult {
        indexed_log_ids,
        matched_lines: BTreeMap::new(),
    };

    let fts_query = fts_phrase_query(query);
    let mut stmt = conn
        .prepare("SELECT id, body FROM log_fts WHERE target_org = ?1 AND body MATCH ?2")
        .map_err(|error| format!("failed to prepare log index search: {error}"))?;
    let mut rows = stmt
        .query(params![target_org, fts_query])
        .map_err(|error| format!("failed to search log index: {error}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("failed to read log index search row: {error}"))?
    {
        cancellation.check_cancelled()?;
        let log_id: String = row
            .get(0)
            .map_err(|error| format!("failed to read indexed log id: {error}"))?;
        if !requested.contains(&log_id) || result.matched_lines.contains_key(&log_id) {
            continue;
        }
        let body: String = row
            .get(1)
            .map_err(|error| format!("failed to read indexed log body: {error}"))?;
        if let Some(line) = find_matching_line(&body, query) {
            result.matched_lines.insert(log_id, line);
        }
    }

    Ok(Some(result))
}

fn open_index(workspace_root: Option<&str>) -> Result<Connection, String> {
    let path = index_path(workspace_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    let conn = Connection::open(&path)
        .map_err(|error| format!("failed to open log index {}: {error}", path.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("failed to enable WAL for log index: {error}"))?;
    conn.pragma_update(None, "busy_timeout", 5000i64)
        .map_err(|error| format!("failed to set log index busy timeout: {error}"))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO metadata (key, value)
          VALUES ('schema_version', '1');
        CREATE TABLE IF NOT EXISTS logs (
          target_org TEXT NOT NULL,
          id TEXT NOT NULL,
          safe_target_org TEXT NOT NULL,
          start_time TEXT,
          operation TEXT,
          application TEXT,
          status TEXT,
          request TEXT,
          log_length INTEGER,
          log_user_name TEXT,
          path TEXT NOT NULL,
          body_size INTEGER NOT NULL DEFAULT 0,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY (target_org, id)
        );
        "#,
    )
    .map_err(|error| format!("failed to initialize log index schema: {error}"))?;

    ensure_fts_table(conn)?;
    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("failed to read log index schema version: {error}"))?;
    if version.as_deref() != Some(&INDEX_SCHEMA_VERSION.to_string()) {
        return Err("unsupported log index schema version".to_string());
    }
    Ok(())
}

fn ensure_fts_table(conn: &Connection) -> Result<(), String> {
    match conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS log_fts
        USING fts5(target_org UNINDEXED, id UNINDEXED, body, tokenize='trigram');
        "#,
    ) {
        Ok(()) => Ok(()),
        Err(first_error) => conn
            .execute_batch(
                r#"
                CREATE VIRTUAL TABLE IF NOT EXISTS log_fts
                USING fts5(target_org UNINDEXED, id UNINDEXED, body);
                "#,
            )
            .map_err(|second_error| {
                format!(
                    "failed to initialize log FTS table: {first_error}; fallback failed: {second_error}"
                )
            }),
    }
}

fn upsert_log(
    conn: &Connection,
    target_org: &str,
    safe_target_org: &str,
    row: &LogRow,
    path: &Path,
    body: &str,
    indexed_at: &str,
) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO logs (
          target_org, id, safe_target_org, start_time, operation, application,
          status, request, log_length, log_user_name, path, body_size, indexed_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(target_org, id) DO UPDATE SET
          safe_target_org = excluded.safe_target_org,
          start_time = excluded.start_time,
          operation = excluded.operation,
          application = excluded.application,
          status = excluded.status,
          request = excluded.request,
          log_length = excluded.log_length,
          log_user_name = excluded.log_user_name,
          path = excluded.path,
          body_size = excluded.body_size,
          indexed_at = excluded.indexed_at
        "#,
        params![
            target_org,
            row.id,
            safe_target_org,
            row.start_time,
            row.operation,
            row.application,
            row.status,
            row.request,
            row.log_length as i64,
            row.log_user.as_ref().and_then(|user| user.name.as_deref()),
            path.display().to_string(),
            body.len() as i64,
            indexed_at,
        ],
    )
    .map_err(|error| format!("failed to upsert log metadata into index: {error}"))?;
    conn.execute(
        "DELETE FROM log_fts WHERE target_org = ?1 AND id = ?2",
        params![target_org, row.id],
    )
    .map_err(|error| format!("failed to replace indexed log body: {error}"))?;
    conn.execute(
        "INSERT INTO log_fts (target_org, id, body) VALUES (?1, ?2, ?3)",
        params![target_org, row.id, body],
    )
    .map_err(|error| format!("failed to index log body: {error}"))?;
    Ok(())
}

fn clear_org_index(conn: &Connection, target_org: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM log_fts WHERE target_org = ?1",
        params![target_org],
    )
    .map_err(|error| format!("failed to clear indexed log bodies: {error}"))?;
    conn.execute(
        "DELETE FROM logs WHERE target_org = ?1",
        params![target_org],
    )
    .map_err(|error| format!("failed to clear indexed log metadata: {error}"))?;
    Ok(())
}

fn indexed_log_ids(
    conn: &Connection,
    target_org: &str,
    requested: &BTreeSet<String>,
    cancellation: &CancellationToken,
) -> Result<BTreeSet<String>, String> {
    let mut indexed = BTreeSet::new();
    let requested = requested.iter().collect::<Vec<_>>();
    for chunk in requested.chunks(MAX_SQL_PARAMS) {
        cancellation.check_cancelled()?;
        let placeholders = (0..chunk.len()).map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("SELECT id FROM logs WHERE target_org = ? AND id IN ({placeholders})");
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
        params.push(&target_org);
        for log_id in chunk {
            params.push(*log_id);
        }
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|error| format!("failed to prepare indexed log lookup: {error}"))?;
        let mut rows = stmt
            .query(params.as_slice())
            .map_err(|error| format!("failed to query indexed log ids: {error}"))?;
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("failed to read indexed log lookup row: {error}"))?
        {
            let log_id: String = row
                .get(0)
                .map_err(|error| format!("failed to read indexed log lookup id: {error}"))?;
            indexed.insert(log_id);
        }
    }
    Ok(indexed)
}

fn collect_log_paths(
    logs_root: &Path,
    cancellation: &CancellationToken,
    paths: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !logs_root.is_dir() {
        return Ok(());
    }
    let entries = fs::read_dir(logs_root)
        .map_err(|error| format!("failed to read {}: {error}", logs_root.display()))?;
    for entry in entries.flatten() {
        cancellation.check_cancelled()?;
        let path = entry.path();
        if path.is_dir() {
            if log_store::is_supported_log_day_dir_name(
                entry.file_name().to_string_lossy().as_ref(),
            ) {
                collect_log_paths(&path, cancellation, paths)?;
            }
            continue;
        }
        if path.is_file() && log_id_from_path(&path).is_some() {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(())
}

fn log_id_from_path(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_suffix(".log"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn start_time_from_path(path: &Path) -> String {
    path.parent()
        .and_then(|parent| parent.file_name())
        .and_then(|value| value.to_str())
        .filter(|value| log_store::is_supported_log_day_dir_name(value))
        .filter(|value| *value != "unknown-date")
        .map(|day| format!("{day}T00:00:00.000Z"))
        .unwrap_or_default()
}

fn rebuilt_row(log_id: &str, start_time: String) -> LogRow {
    LogRow {
        id: log_id.to_string(),
        start_time,
        operation: String::new(),
        application: String::new(),
        duration_milliseconds: 0,
        status: String::new(),
        request: String::new(),
        log_length: 0,
        log_user: None,
    }
}

fn find_matching_line(body: &str, query: &str) -> Option<String> {
    let needle = query.to_lowercase();
    body.lines()
        .find(|line| line.to_lowercase().contains(&needle))
        .map(ToOwned::to_owned)
}

fn fts_phrase_query(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

fn timestamp_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alv-log-index-{label}-{nonce}"));
        fs::create_dir_all(&root).expect("temp workspace should be creatable");
        root
    }

    #[test]
    fn rebuild_org_index_clears_existing_rows_when_no_logs_remain() {
        let workspace_root = temp_workspace("rebuild-empty");
        let target_org = "selected@example.com";
        let log_dir = log_store::org_dir(
            Some(
                workspace_root
                    .to_str()
                    .expect("workspace path should be utf8"),
            ),
            target_org,
        )
        .join("logs")
        .join("2026-03-30");
        fs::create_dir_all(&log_dir).expect("log dir should be creatable");
        let log_path = log_dir.join("07L000000000001AA.log");
        fs::write(&log_path, "09:00:00.0|USER_INFO|stale indexed body\n")
            .expect("log file should be writable");

        let workspace_text = workspace_root
            .to_str()
            .expect("workspace path should be utf8")
            .to_string();
        let token = CancellationToken::new();
        assert_eq!(
            rebuild_org_index(Some(&workspace_text), target_org, &token)
                .expect("initial rebuild should succeed"),
            1
        );
        assert_eq!(
            count_indexed_logs(Some(&workspace_text), target_org)
                .expect("indexed count should be readable"),
            1
        );

        fs::remove_file(&log_path).expect("log file should be removable");
        assert_eq!(
            rebuild_org_index(Some(&workspace_text), target_org, &token)
                .expect("empty rebuild should succeed"),
            0
        );
        assert_eq!(
            count_indexed_logs(Some(&workspace_text), target_org)
                .expect("indexed count should be readable after empty rebuild"),
            0
        );
        let search = search_index_lines(
            Some(&workspace_text),
            target_org,
            "stale indexed body",
            &["07L000000000001AA".to_string()],
            &token,
        )
        .expect("search should query index")
        .expect("index should exist");
        assert!(search.indexed_log_ids.is_empty());
        assert!(search.matched_lines.is_empty());

        fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    }

    #[test]
    fn open_index_rejects_existing_unsupported_schema_version() {
        let workspace_root = temp_workspace("unsupported-version");
        let workspace_text = workspace_root
            .to_str()
            .expect("workspace path should be utf8")
            .to_string();
        let path = index_path(Some(&workspace_text));
        fs::create_dir_all(path.parent().expect("index path should have parent"))
            .expect("index parent should be creatable");
        let conn = Connection::open(&path).expect("sqlite index should be creatable");
        conn.execute_batch(
            r#"
            CREATE TABLE metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            INSERT INTO metadata (key, value) VALUES ('schema_version', '999');
            "#,
        )
        .expect("unsupported metadata should be writable");
        drop(conn);

        let error = count_indexed_logs(Some(&workspace_text), "selected@example.com")
            .expect_err("unsupported schema version should be rejected");
        assert!(error.contains("unsupported log index schema version"));

        fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
    }
}
