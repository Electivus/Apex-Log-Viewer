use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::cli::build_command_invocation;
use crate::cli_json::extract_json_object;

pub const TEST_ORG_LIST_JSON_ENV: &str = "ALV_TEST_SF_ORG_LIST_JSON";
pub const TEST_ORG_DISPLAY_JSON_ENV: &str = "ALV_TEST_SF_ORG_DISPLAY_JSON";
// Salesforce access tokens are typically valid for roughly two hours, but the
// CLI does not expose a token expiry in org display or local auth JSON. Keep the
// optimistic cache comfortably below that and force a fresh sf lookup on 401.
const ORG_AUTH_CACHE_TTL: Duration = Duration::from_secs(90 * 60);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgAuth {
    pub access_token: String,
    pub instance_url: String,
    pub username: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OrgAuthMetadata {
    instance_url: String,
    username: Option<String>,
}

#[derive(Clone)]
struct OrgAuthCacheEntry {
    auth: OrgAuth,
    expires_at: Instant,
    fingerprint: Option<OrgAuthCacheFingerprint>,
}

#[derive(Clone, PartialEq, Eq)]
struct OrgAuthCacheFingerprint {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

type OrgAuthResult = Result<OrgAuth, String>;

struct OrgAuthInflight {
    result: Mutex<Option<OrgAuthResult>>,
    completed: Condvar,
}

fn org_auth_cache() -> &'static Mutex<HashMap<String, OrgAuthCacheEntry>> {
    static STORE: OnceLock<Mutex<HashMap<String, OrgAuthCacheEntry>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn org_auth_inflight() -> &'static Mutex<HashMap<String, Arc<OrgAuthInflight>>> {
    static STORE: OnceLock<Mutex<HashMap<String, Arc<OrgAuthInflight>>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn clear_org_auth_cache() {
    if let Ok(mut cache) = org_auth_cache().lock() {
        cache.clear();
    }
    if let Ok(mut inflight) = org_auth_inflight().lock() {
        inflight.clear();
    }
}

pub fn clear_cached_org_auth_for_username(username: Option<&str>) {
    let Some(key) = org_auth_cache_key(username) else {
        return;
    };
    if let Ok(mut cache) = org_auth_cache().lock() {
        cache.remove(&key);
    }
}

pub fn run_sf_org_list_json() -> Result<String, String> {
    if let Ok(fixture) = std::env::var(TEST_ORG_LIST_JSON_ENV) {
        return Ok(fixture);
    }

    run_sf_org_list_json_with_runner(run_command)
}

pub fn resolve_org_auth(target_username_or_alias: Option<&str>) -> Result<OrgAuth, String> {
    if let Ok(fixture) = std::env::var(TEST_ORG_DISPLAY_JSON_ENV) {
        return resolve_org_auth_from_json(&fixture);
    }

    resolve_org_auth_cached_with_runner(target_username_or_alias, run_command)
}

pub fn run_sf_org_display_json(target_username_or_alias: Option<&str>) -> Result<String, String> {
    if let Ok(fixture) = std::env::var(TEST_ORG_DISPLAY_JSON_ENV) {
        return Ok(fixture);
    }

    let attempts = build_org_auth_attempts(target_username_or_alias);

    let mut last_error = String::from("Salesforce CLI not found");

    for (program, args) in attempts {
        match run_command(program, &args) {
            Ok(stdout) => return Ok(stdout),
            Err(error) => {
                last_error = error;
            }
        }
    }

    Err(last_error)
}

fn build_org_auth_attempts<'a>(
    target_username_or_alias: Option<&'a str>,
) -> Vec<(&'static str, Vec<&'a str>)> {
    let mut attempts = vec![
        ("sf", vec!["org", "display", "--json", "--verbose"]),
        ("sf", vec!["org", "user", "display", "--json", "--verbose"]),
        ("sf", vec!["org", "user", "display", "--json"]),
        ("sf", vec!["org", "display", "--json"]),
    ];

    if let Some(value) = target_username_or_alias {
        attempts[0].1.extend(["--target-org", value]);
        attempts[1].1.extend(["--target-org", value]);
        attempts[2].1.extend(["--target-org", value]);
        attempts[3].1.extend(["--target-org", value]);
    }

    attempts
}

fn build_org_display_args(target_username_or_alias: Option<&str>) -> Vec<&str> {
    let mut args = vec!["org", "display", "--json"];
    if let Some(value) = target_username_or_alias {
        args.extend(["--target-org", value]);
    }
    args
}

fn build_show_access_token_args(target_username_or_alias: Option<&str>) -> Vec<&str> {
    let mut args = vec!["org", "auth", "show-access-token", "--json", "--no-prompt"];
    if let Some(value) = target_username_or_alias {
        args.extend(["--target-org", value]);
    }
    args
}

fn org_auth_cache_key(target_username_or_alias: Option<&str>) -> Option<String> {
    let target = target_username_or_alias
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    if !target.contains('@') {
        return None;
    }

    Some(format!("username:{}", target.to_ascii_lowercase()))
}

fn get_cached_org_auth(key: &str) -> Option<OrgAuth> {
    let mut cache = org_auth_cache().lock().ok()?;
    match cache.get(key) {
        Some(entry)
            if entry.expires_at > Instant::now() && org_auth_fingerprint_matches(key, entry) =>
        {
            Some(entry.auth.clone())
        }
        Some(_) => {
            cache.remove(key);
            None
        }
        None => None,
    }
}

fn put_cached_org_auth(key: String, auth: OrgAuth) {
    let fingerprint = org_auth_fingerprint_for_cache_key(&key);
    if let Ok(mut cache) = org_auth_cache().lock() {
        cache.insert(
            key,
            OrgAuthCacheEntry {
                auth,
                expires_at: Instant::now() + ORG_AUTH_CACHE_TTL,
                fingerprint,
            },
        );
    }
}

fn org_auth_fingerprint_matches(key: &str, entry: &OrgAuthCacheEntry) -> bool {
    match (
        entry.fingerprint.as_ref(),
        org_auth_fingerprint_for_cache_key(key).as_ref(),
    ) {
        (Some(cached), Some(current)) => cached == current,
        (Some(_), None) | (None, Some(_)) => false,
        (None, None) => true,
    }
}

fn org_auth_fingerprint_for_cache_key(key: &str) -> Option<OrgAuthCacheFingerprint> {
    let username = key.strip_prefix("username:")?;
    let home = home_dir()?;
    for dir in [".sf", ".sfdx"] {
        let path = home.join(dir).join(format!("{username}.json"));
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.is_file() {
            return Some(OrgAuthCacheFingerprint {
                path,
                len: metadata.len(),
                modified: metadata.modified().ok(),
            });
        }
    }
    None
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
}

fn resolve_org_auth_cached_with_runner<'a, F>(
    target_username_or_alias: Option<&'a str>,
    runner: F,
) -> Result<OrgAuth, String>
where
    F: FnMut(&str, &[&'a str]) -> Result<String, String>,
{
    let Some(key) = org_auth_cache_key(target_username_or_alias) else {
        let result = resolve_org_auth_with_runner(target_username_or_alias, runner);
        if let Ok(auth) = result.as_ref() {
            if let Some(key) = org_auth_cache_key(auth.username.as_deref()) {
                put_cached_org_auth(key, auth.clone());
            }
        }
        return result;
    };

    if let Some(auth) = get_cached_org_auth(&key) {
        return Ok(auth);
    }

    resolve_org_auth_singleflight(key, || {
        resolve_org_auth_with_runner(target_username_or_alias, runner)
    })
}

fn resolve_org_auth_singleflight<F>(key: String, compute: F) -> Result<OrgAuth, String>
where
    F: FnOnce() -> Result<OrgAuth, String>,
{
    if let Some(auth) = get_cached_org_auth(&key) {
        return Ok(auth);
    }

    let (flight, owner) = {
        let mut inflight = org_auth_inflight()
            .lock()
            .map_err(|_| "org auth inflight cache lock poisoned".to_string())?;
        if let Some(flight) = inflight.get(&key) {
            (Arc::clone(flight), false)
        } else {
            let flight = Arc::new(OrgAuthInflight {
                result: Mutex::new(None),
                completed: Condvar::new(),
            });
            inflight.insert(key.clone(), Arc::clone(&flight));
            (flight, true)
        }
    };

    if !owner {
        let mut state = flight
            .result
            .lock()
            .map_err(|_| "org auth inflight result lock poisoned".to_string())?;
        loop {
            if let Some(result) = state.clone() {
                return result;
            }
            state = flight
                .completed
                .wait(state)
                .map_err(|_| "org auth inflight wait lock poisoned".to_string())?;
        }
    }

    let result = match panic::catch_unwind(AssertUnwindSafe(compute)) {
        Ok(result) => result,
        Err(payload) => {
            finish_org_auth_flight(
                &key,
                &flight,
                Err("org auth resolution panicked".to_string()),
            );
            panic::resume_unwind(payload);
        }
    };

    finish_org_auth_flight(&key, &flight, result.clone());
    result
}

fn finish_org_auth_flight(key: &str, flight: &Arc<OrgAuthInflight>, result: OrgAuthResult) {
    if let Ok(auth) = result.clone() {
        if let Some(cache_key) = org_auth_cache_key(auth.username.as_deref()) {
            put_cached_org_auth(cache_key, auth);
        }
    }

    let mut state = match flight.result.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };
    *state = Some(result);
    flight.completed.notify_all();
    drop(state);

    if let Ok(mut inflight) = org_auth_inflight().lock() {
        if let Some(current) = inflight.get(key) {
            if Arc::ptr_eq(current, &flight) {
                inflight.remove(key);
            }
        }
    }
}

fn resolve_org_auth_with_runner<'a, F>(
    target_username_or_alias: Option<&'a str>,
    mut runner: F,
) -> Result<OrgAuth, String>
where
    F: FnMut(&str, &[&'a str]) -> Result<String, String>,
{
    let display_args = build_org_display_args(target_username_or_alias);
    let mut last_error = match runner("sf", &display_args) {
        Ok(stdout) => match resolve_org_metadata_from_json(&stdout) {
            Ok(metadata) => {
                let token_args = build_show_access_token_args(target_username_or_alias);
                match runner("sf", &token_args) {
                    Ok(stdout) => match resolve_access_token_from_json(&stdout) {
                        Ok(access_token) => {
                            return Ok(OrgAuth {
                                access_token,
                                instance_url: metadata.instance_url,
                                username: metadata.username,
                            });
                        }
                        Err(error) => error,
                    },
                    Err(error) => error,
                }
            }
            Err(error) => error,
        },
        Err(error) => error,
    };

    for (program, args) in build_org_auth_attempts(target_username_or_alias) {
        match runner(program, &args) {
            Ok(stdout) => match resolve_org_auth_from_json(&stdout) {
                Ok(auth) => return Ok(auth),
                Err(error) => {
                    last_error = error;
                }
            },
            Err(error) => {
                last_error = error;
            }
        }
    }

    Err(last_error)
}

fn run_command(program: &str, args: &[&str]) -> Result<String, String> {
    let invocation = build_command_invocation(program, args)?;
    let mut command = Command::new(&invocation.program);
    command.args(&invocation.args);
    configure_sf_command_env(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("{program} failed to start: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        if stdout.is_empty() {
            return Err(format!("{program} returned empty output"));
        }
        return Ok(stdout);
    }

    if !stderr.is_empty() {
        return Err(stderr);
    }

    if !stdout.is_empty() {
        return Err(stdout);
    }

    Err(format!("{program} exited with status {}", output.status))
}

fn configure_sf_command_env(command: &mut Command) {
    for (key, value) in [
        ("SF_SKIP_NEW_VERSION_CHECK", "true"),
        ("SF_DISABLE_TELEMETRY", "true"),
        ("SFDX_DISABLE_TELEMETRY", "true"),
        ("SF_DISABLE_LOG_FILE", "true"),
        ("SFDX_DISABLE_LOG_FILE", "true"),
        ("SF_AUTOUPDATE_DISABLE", "true"),
        ("SFDX_AUTOUPDATE_DISABLE", "true"),
        ("SF_DISABLE_AUTOUPDATE", "true"),
        ("SFDX_DISABLE_AUTOUPDATE", "true"),
    ] {
        if std::env::var_os(key).is_none() {
            command.env(key, value);
        }
    }
}

fn run_sf_org_list_json_with_runner<F>(mut runner: F) -> Result<String, String>
where
    F: FnMut(&str, &[&str]) -> Result<String, String>,
{
    runner("sf", &["org", "list", "--json", "--skip-connection-status"])
}

pub fn resolve_org_auth_from_json(json: &str) -> Result<OrgAuth, String> {
    let normalized = extract_json_object(json);
    let parsed: Value = serde_json::from_str(&normalized)
        .map_err(|error| format!("invalid org auth JSON: {error}"))?;

    let mut sources = vec![&parsed];
    if let Some(result) = parsed.get("result") {
        sources.insert(0, result);
    }

    let access_token = extract_secret_string(&sources, &["accessToken", "access_token"])
        .ok_or_else(|| "CLI JSON missing access token".to_string())?;
    let instance_url = extract_value_string(&sources, &["instanceUrl", "instance_url", "loginUrl"])
        .ok_or_else(|| "CLI JSON missing instance URL".to_string())?;
    let username = extract_value_string(&sources, &["username"]);

    Ok(OrgAuth {
        access_token,
        instance_url,
        username,
    })
}

fn resolve_org_metadata_from_json(json: &str) -> Result<OrgAuthMetadata, String> {
    let normalized = extract_json_object(json);
    let parsed: Value = serde_json::from_str(&normalized)
        .map_err(|error| format!("invalid org display JSON: {error}"))?;

    let mut sources = vec![&parsed];
    if let Some(result) = parsed.get("result") {
        sources.insert(0, result);
    }

    let instance_url = extract_value_string(&sources, &["instanceUrl", "instance_url", "loginUrl"])
        .ok_or_else(|| "CLI JSON missing instance URL".to_string())?;
    let username = extract_value_string(&sources, &["username"]);

    Ok(OrgAuthMetadata {
        instance_url,
        username,
    })
}

fn resolve_access_token_from_json(json: &str) -> Result<String, String> {
    let normalized = extract_json_object(json);
    let parsed: Value = serde_json::from_str(&normalized)
        .map_err(|error| format!("invalid access token JSON: {error}"))?;

    let mut sources = vec![&parsed];
    if let Some(result) = parsed.get("result") {
        sources.insert(0, result);
    }

    extract_secret_string(&sources, &["accessToken", "access_token"])
        .ok_or_else(|| "CLI JSON missing access token".to_string())
}

fn extract_value_string(sources: &[&Value], keys: &[&str]) -> Option<String> {
    for source in sources {
        for key in keys {
            let value = source
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if value.is_some() {
                return value;
            }
        }
    }
    None
}

fn extract_secret_string(sources: &[&Value], keys: &[&str]) -> Option<String> {
    extract_value_string(sources, keys).filter(|value| is_usable_secret(value))
}

fn is_usable_secret(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("[redacted]") || lower.starts_with("redacted") {
        return false;
    }
    !lower.contains("use 'sf org auth") && !lower.contains("use \"sf org auth")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{
        build_windows_sf_invocation, parse_where_candidates, pick_windows_sf_candidate,
    };
    use std::{
        ffi::{OsStr, OsString},
        path::Path,
        time::UNIX_EPOCH,
    };

    struct EnvVarRestore {
        key: &'static str,
        value: Option<OsString>,
    }

    impl EnvVarRestore {
        fn capture(key: &'static str) -> Self {
            Self {
                key,
                value: std::env::var_os(key),
            }
        }
    }

    impl Drop for EnvVarRestore {
        fn drop(&mut self) {
            match self.value.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn auth_cache_test_guard() -> &'static std::sync::Mutex<()> {
        static GUARD: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        GUARD.get_or_init(|| std::sync::Mutex::new(()))
    }

    fn explicit_command_env(command: &Command, key: &str) -> Option<Option<String>> {
        command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new(key))
            .map(|(_, value)| value.map(|value| value.to_string_lossy().to_string()))
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("alv-auth-{name}-{nonce}"));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn write(path: &Path, raw: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir should be created");
        }
        fs::write(path, raw).expect("file should be written");
    }

    #[test]
    fn build_org_auth_attempts_includes_non_verbose_sf_fallbacks() {
        let attempts = build_org_auth_attempts(Some("demo@example.com"));
        let commands = attempts
            .into_iter()
            .map(|(program, args)| format!("{program} {}", args.join(" ")))
            .collect::<Vec<_>>();

        assert_eq!(
            commands,
            vec![
                "sf org display --json --verbose --target-org demo@example.com",
                "sf org user display --json --verbose --target-org demo@example.com",
                "sf org user display --json --target-org demo@example.com",
                "sf org display --json --target-org demo@example.com",
            ]
        );
    }

    #[test]
    fn resolve_org_auth_with_runner_uses_explicit_access_token_command() {
        let mut invocations = Vec::new();
        let auth = resolve_org_auth_with_runner(Some("ALV_E2E_Scratch"), |program, args| {
            invocations.push(format!("{program} {}", args.join(" ")));
            match invocations.len() {
                1 => Ok(
                    r#"{"status":0,"result":{"username":"ALV_E2E_Scratch","instanceUrl":"https://example.my.salesforce.com"}}"#
                        .to_string(),
                ),
                2 => Ok(
                    r#"{"status":0,"result":{"accessToken":"00D-token"}}"#
                        .to_string(),
                ),
                _ => Err("unexpected extra attempt".to_string()),
            }
        })
        .expect("expected explicit auth resolution to succeed");

        assert_eq!(auth.access_token, "00D-token");
        assert_eq!(auth.instance_url, "https://example.my.salesforce.com");
        assert_eq!(auth.username.as_deref(), Some("ALV_E2E_Scratch"));
        assert_eq!(
            invocations,
            vec![
                "sf org display --json --target-org ALV_E2E_Scratch",
                "sf org auth show-access-token --json --no-prompt --target-org ALV_E2E_Scratch",
            ]
        );
    }

    #[test]
    fn resolve_org_auth_with_runner_falls_back_to_legacy_when_explicit_token_command_fails() {
        let mut invocations = Vec::new();
        let auth = resolve_org_auth_with_runner(Some("ALV_E2E_Scratch"), |program, args| {
            invocations.push(format!("{program} {}", args.join(" ")));
            match invocations.len() {
                1 => Ok(
                    r#"{"status":0,"result":{"username":"ALV_E2E_Scratch","instanceUrl":"https://example.my.salesforce.com"}}"#
                        .to_string(),
                ),
                2 => Err("Warning: org auth show-access-token is not a sf command".to_string()),
                3 => Ok(
                    r#"{"status":0,"result":{"accessToken":"00D-legacy","instanceUrl":"https://legacy.example.com","username":"ALV_E2E_Scratch"}}"#
                        .to_string(),
                ),
                _ => Err("unexpected extra attempt".to_string()),
            }
        })
        .expect("expected legacy auth fallback to succeed");

        assert_eq!(auth.access_token, "00D-legacy");
        assert_eq!(auth.instance_url, "https://legacy.example.com");
        assert_eq!(
            invocations,
            vec![
                "sf org display --json --target-org ALV_E2E_Scratch",
                "sf org auth show-access-token --json --no-prompt --target-org ALV_E2E_Scratch",
                "sf org display --json --verbose --target-org ALV_E2E_Scratch",
            ]
        );
    }

    #[test]
    fn resolve_org_auth_cached_with_runner_reuses_successful_auth() {
        let _guard = auth_cache_test_guard()
            .lock()
            .expect("auth cache test guard should not be poisoned");
        clear_org_auth_cache();

        let mut calls = 0usize;
        let first = resolve_org_auth_cached_with_runner(Some("Demo@Example.com"), |_, _| {
            calls += 1;
            Ok(
                r#"{"result":{"accessToken":"token","instanceUrl":"https://example.com","username":"demo@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("first auth should resolve");
        let second = resolve_org_auth_cached_with_runner(Some("demo@example.com"), |_, _| {
            calls += 1;
            Err("should not be called".to_string())
        })
        .expect("second auth should use cache");

        assert_eq!(calls, 2);
        assert_eq!(first, second);
        clear_org_auth_cache();
    }

    #[test]
    fn resolve_org_auth_cached_with_runner_does_not_cache_implicit_default_org() {
        let _guard = auth_cache_test_guard()
            .lock()
            .expect("auth cache test guard should not be poisoned");
        clear_org_auth_cache();

        let mut calls = 0usize;
        let first = resolve_org_auth_cached_with_runner(None, |_, _| {
            calls += 1;
            Ok(
                r#"{"result":{"accessToken":"first","instanceUrl":"https://first.example.com","username":"first@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("first default auth should resolve");
        let second = resolve_org_auth_cached_with_runner(None, |_, _| {
            calls += 1;
            Ok(
                r#"{"result":{"accessToken":"second","instanceUrl":"https://second.example.com","username":"second@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("second default auth should resolve");

        assert_eq!(calls, 4);
        assert_eq!(first.username.as_deref(), Some("first@example.com"));
        assert_eq!(second.username.as_deref(), Some("second@example.com"));
        clear_org_auth_cache();
    }

    #[test]
    fn resolve_org_auth_cached_with_runner_does_not_cache_alias_targets() {
        let _guard = auth_cache_test_guard()
            .lock()
            .expect("auth cache test guard should not be poisoned");
        clear_org_auth_cache();

        let mut calls = 0usize;
        let first = resolve_org_auth_cached_with_runner(Some("Demo"), |_, _| {
            calls += 1;
            Ok(
                r#"{"result":{"accessToken":"first","instanceUrl":"https://first.example.com","username":"demo@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("first alias auth should resolve");
        let second = resolve_org_auth_cached_with_runner(Some("Demo"), |_, _| {
            calls += 1;
            Ok(
                r#"{"result":{"accessToken":"second","instanceUrl":"https://second.example.com","username":"demo@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("second alias auth should resolve");

        assert_eq!(calls, 4);
        assert_eq!(first.access_token, "first");
        assert_eq!(second.access_token, "second");
        clear_org_auth_cache();
    }

    #[test]
    fn resolve_org_auth_cached_with_runner_uses_resolved_username_cache_key() {
        let _guard = auth_cache_test_guard()
            .lock()
            .expect("auth cache test guard should not be poisoned");
        clear_org_auth_cache();

        let mut alias_calls = 0usize;
        let first = resolve_org_auth_cached_with_runner(Some("alias@example.com"), |_, _| {
            alias_calls += 1;
            Ok(
                r#"{"result":{"accessToken":"first","instanceUrl":"https://first.example.com","username":"real@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("first auth should resolve");
        let second_alias = resolve_org_auth_cached_with_runner(Some("alias@example.com"), |_, _| {
            alias_calls += 1;
            Ok(
                r#"{"result":{"accessToken":"second","instanceUrl":"https://second.example.com","username":"real@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("second alias-shaped auth should resolve fresh");
        let username_hit = resolve_org_auth_cached_with_runner(Some("real@example.com"), |_, _| {
            Err("username should hit resolved cache key".to_string())
        })
        .expect("resolved username should use cache");

        assert_eq!(alias_calls, 4);
        assert_eq!(first.access_token, "first");
        assert_eq!(second_alias.access_token, "second");
        assert_eq!(username_hit.access_token, "second");
        clear_org_auth_cache();
    }

    #[test]
    fn clear_cached_org_auth_for_username_removes_username_entry() {
        let _guard = auth_cache_test_guard()
            .lock()
            .expect("auth cache test guard should not be poisoned");
        clear_org_auth_cache();

        let mut calls = 0usize;
        let first = resolve_org_auth_cached_with_runner(Some("demo@example.com"), |_, _| {
            calls += 1;
            Ok(
                r#"{"result":{"accessToken":"first","instanceUrl":"https://first.example.com","username":"demo@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("first auth should resolve");
        clear_cached_org_auth_for_username(Some("demo@example.com"));
        let second = resolve_org_auth_cached_with_runner(Some("demo@example.com"), |_, _| {
            calls += 1;
            Ok(
                r#"{"result":{"accessToken":"second","instanceUrl":"https://second.example.com","username":"demo@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("second auth should resolve after cache clear");

        assert_eq!(calls, 4);
        assert_eq!(first.access_token, "first");
        assert_eq!(second.access_token, "second");
        clear_org_auth_cache();
    }

    #[test]
    fn resolve_org_auth_cached_with_runner_invalidates_changed_auth_file() {
        let _guard = auth_cache_test_guard()
            .lock()
            .expect("auth cache test guard should not be poisoned");
        clear_org_auth_cache();
        let _home_restore = EnvVarRestore::capture("HOME");
        let _userprofile_restore = EnvVarRestore::capture("USERPROFILE");
        let home = temp_dir("home");
        std::env::set_var("HOME", &home);
        std::env::remove_var("USERPROFILE");
        let auth_path = home.join(".sfdx/demo@example.com.json");
        write(&auth_path, r#"{"username":"demo@example.com"}"#);

        let mut calls = 0usize;
        let first = resolve_org_auth_cached_with_runner(Some("demo@example.com"), |_, _| {
            calls += 1;
            Ok(
                r#"{"result":{"accessToken":"first","instanceUrl":"https://first.example.com","username":"demo@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("first auth should resolve");
        let second = resolve_org_auth_cached_with_runner(Some("demo@example.com"), |_, _| {
            calls += 1;
            Err("unchanged auth file should use cache".to_string())
        })
        .expect("second auth should use cache while auth file is unchanged");

        write(
            &auth_path,
            r#"{"username":"demo@example.com","refreshToken":"changed"}"#,
        );
        let third = resolve_org_auth_cached_with_runner(Some("demo@example.com"), |_, _| {
            calls += 1;
            Ok(
                r#"{"result":{"accessToken":"refreshed","instanceUrl":"https://refreshed.example.com","username":"demo@example.com"}}"#
                    .to_string(),
            )
        })
        .expect("changed auth file should invalidate cache");

        assert_eq!(calls, 4);
        assert_eq!(first.access_token, "first");
        assert_eq!(second.access_token, "first");
        assert_eq!(third.access_token, "refreshed");
        clear_org_auth_cache();
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn resolve_org_auth_cached_with_runner_coalesces_concurrent_requests() {
        use std::{
            sync::{
                atomic::{AtomicUsize, Ordering},
                Barrier,
            },
            thread,
            time::Duration,
        };

        let _guard = auth_cache_test_guard()
            .lock()
            .expect("auth cache test guard should not be poisoned");
        clear_org_auth_cache();

        let calls = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(6));
        let mut handles = Vec::new();

        for _ in 0..6 {
            let calls = Arc::clone(&calls);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                resolve_org_auth_cached_with_runner(Some("demo@example.com"), |_, _| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(100));
                    Ok(
                        r#"{"result":{"accessToken":"token","instanceUrl":"https://example.com","username":"demo@example.com"}}"#
                            .to_string(),
                    )
                })
            }));
        }

        for handle in handles {
            let auth = handle
                .join()
                .expect("auth worker should not panic")
                .expect("auth should resolve");
            assert_eq!(auth.username.as_deref(), Some("demo@example.com"));
        }

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        clear_org_auth_cache();
    }

    #[test]
    fn resolve_org_auth_singleflight_cleans_up_after_panic() {
        let _guard = auth_cache_test_guard()
            .lock()
            .expect("auth cache test guard should not be poisoned");
        clear_org_auth_cache();

        let key = "username:panic@example.com".to_string();
        let result = std::panic::catch_unwind({
            let key = key.clone();
            move || {
                let _ = resolve_org_auth_singleflight(key, || -> Result<OrgAuth, String> {
                    panic!("boom");
                });
            }
        });

        assert!(result.is_err());
        assert!(!org_auth_inflight()
            .lock()
            .expect("inflight cache should not be poisoned")
            .contains_key(&key));
        clear_org_auth_cache();
    }

    #[test]
    fn resolve_org_auth_from_json_accepts_top_level_auth_fields() {
        let auth = resolve_org_auth_from_json(
            r#"{
                "accessToken": "00D-top-level",
                "instanceUrl": "https://top-level.example.com",
                "username": "top-level@example.com"
            }"#,
        )
        .expect("top-level auth fields should parse");

        assert_eq!(auth.access_token, "00D-top-level");
        assert_eq!(auth.instance_url, "https://top-level.example.com");
        assert_eq!(auth.username.as_deref(), Some("top-level@example.com"));
    }

    #[test]
    fn resolve_org_auth_from_json_accepts_update_warning_preamble() {
        let auth = resolve_org_auth_from_json(
            r#" »   Warning: @salesforce/cli update available from 2.127.2 to 2.128.5.
{
  "status": 0,
  "result": {
    "accessToken": "00D-warning-token",
    "instanceUrl": "https://warning.example.com",
    "username": "warning@example.com"
  }
}"#,
        )
        .expect("warning-prefixed auth payload should parse");

        assert_eq!(auth.access_token, "00D-warning-token");
        assert_eq!(auth.instance_url, "https://warning.example.com");
        assert_eq!(auth.username.as_deref(), Some("warning@example.com"));
    }

    #[test]
    fn run_sf_org_list_json_only_uses_sf() {
        let mut invocations = Vec::new();

        let error = run_sf_org_list_json_with_runner(|program, args| {
            invocations.push(format!("{program} {}", args.join(" ")));
            Err("sf failed to start: program not found".to_string())
        })
        .expect_err("expected sf failure to propagate");

        assert_eq!(error, "sf failed to start: program not found");
        assert_eq!(
            invocations,
            vec!["sf org list --json --skip-connection-status"]
        );
    }

    #[test]
    fn configure_sf_command_env_respects_parent_overrides() {
        let _guard = auth_cache_test_guard()
            .lock()
            .expect("auth cache test guard should not be poisoned");
        let _skip_restore = EnvVarRestore::capture("SF_SKIP_NEW_VERSION_CHECK");
        let _telemetry_restore = EnvVarRestore::capture("SF_DISABLE_TELEMETRY");

        std::env::remove_var("SF_SKIP_NEW_VERSION_CHECK");
        std::env::set_var("SF_DISABLE_TELEMETRY", "false");

        let mut command = Command::new("sf");
        configure_sf_command_env(&mut command);

        assert_eq!(
            explicit_command_env(&command, "SF_SKIP_NEW_VERSION_CHECK"),
            Some(Some("true".to_string()))
        );
        assert_eq!(explicit_command_env(&command, "SF_DISABLE_TELEMETRY"), None);
    }

    #[test]
    fn pick_windows_sf_candidate_prefers_cmd_wrapper() {
        let candidates = parse_where_candidates(
            "C:\\Users\\k2\\AppData\\Roaming\\fnm\\aliases\\default\\sf\nC:\\Users\\k2\\AppData\\Roaming\\fnm\\aliases\\default\\sf.cmd\n",
        );

        let selected = pick_windows_sf_candidate(&candidates);

        assert_eq!(
            selected.as_deref(),
            Some("C:\\Users\\k2\\AppData\\Roaming\\fnm\\aliases\\default\\sf.cmd")
        );
    }

    #[test]
    fn build_windows_sf_invocation_wraps_cmd_shim() {
        let invocation = build_windows_sf_invocation(
            "C:\\Users\\k2\\AppData\\Roaming\\fnm\\aliases\\default\\sf.cmd",
            &["org", "list", "--json"],
        );

        assert_eq!(invocation.program, "cmd.exe");
        assert_eq!(
            invocation.args,
            vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "C:\\Users\\k2\\AppData\\Roaming\\fnm\\aliases\\default\\sf.cmd".to_string(),
                "org".to_string(),
                "list".to_string(),
                "--json".to_string(),
            ]
        );
    }
}
