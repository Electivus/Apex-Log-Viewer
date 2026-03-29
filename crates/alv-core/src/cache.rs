use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct CacheEntry {
    value: String,
    expires_at: Instant,
}

fn cache_store() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static STORE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn get_string(key: &str) -> Option<String> {
    let mut store = cache_store().lock().ok()?;
    match store.get(key) {
        Some(entry) if entry.expires_at > Instant::now() => Some(entry.value.clone()),
        Some(_) => {
            store.remove(key);
            None
        }
        None => None,
    }
}

pub fn put_string(key: impl Into<String>, value: String, ttl: Duration) {
    if ttl.is_zero() {
        return;
    }

    if let Ok(mut store) = cache_store().lock() {
        store.insert(
            key.into(),
            CacheEntry {
                value,
                expires_at: Instant::now() + ttl,
            },
        );
    }
}

pub fn clear_all() {
    if let Ok(mut store) = cache_store().lock() {
        store.clear();
    }
}
