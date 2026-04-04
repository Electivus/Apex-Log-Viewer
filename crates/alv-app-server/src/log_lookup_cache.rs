use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
    workspace_root: Option<String>,
    username: Option<String>,
    log_id: String,
}

static LOG_PATH_CACHE: OnceLock<Mutex<HashMap<CacheKey, String>>> = OnceLock::new();

pub fn resolve_cached_log_path(
    workspace_root: Option<&str>,
    log_id: &str,
    username: Option<&str>,
) -> Option<String> {
    let key = CacheKey {
        workspace_root: workspace_root
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        username: username
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        log_id: log_id.trim().to_string(),
    };

    if key.log_id.is_empty() {
        return None;
    }

    let cache = LOG_PATH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut guard) = cache.lock() {
        if let Some(existing) = guard.get(&key).cloned() {
            if Path::new(&existing).is_file() {
                return Some(existing);
            }

            guard.remove(&key);
        }
    }

    let resolved = alv_core::log_store::find_cached_log_path(
        key.workspace_root.as_deref(),
        &key.log_id,
        key.username.as_deref(),
    )?
    .to_string_lossy()
    .into_owned();

    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, resolved.clone());
    }

    Some(resolved)
}
