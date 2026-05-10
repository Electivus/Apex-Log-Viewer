use crate::orgs::OrgSummary;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Default)]
struct Defaults {
    target_org: Option<String>,
    target_dev_hub: Option<String>,
}

pub(crate) fn list_local_orgs() -> Result<Vec<OrgSummary>, String> {
    let home = home_dir().ok_or_else(|| "home directory is not available".to_string())?;
    let cwd =
        env::current_dir().map_err(|error| format!("current directory is unavailable: {error}"))?;
    list_local_orgs_with_context(&home, &cwd)
}

pub(crate) fn find_alias_for_username(username: &str) -> Option<String> {
    let home = home_dir()?;
    let aliases = load_aliases(&home);
    alias_by_username(&aliases)
        .get(&normalize(username))
        .cloned()
}

fn list_local_orgs_with_context(home: &Path, cwd: &Path) -> Result<Vec<OrgSummary>, String> {
    let aliases = load_aliases(home);
    let username_aliases = alias_by_username(&aliases);
    let defaults = load_defaults(home, cwd);

    let mut orgs = BTreeMap::<String, OrgSummary>::new();
    let mut saw_auth_dir = false;
    let auth_dirs = [home.join(".sf"), home.join(".sfdx")];

    for auth_dir in &auth_dirs {
        let entries = match fs::read_dir(auth_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        saw_auth_dir = true;

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = match path.file_name().and_then(|value| value.to_str()) {
                Some(value) if is_auth_file_name(value) => value,
                _ => continue,
            };
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            let parsed: Value = match serde_json::from_str(&raw) {
                Ok(parsed) => parsed,
                Err(_) => continue,
            };
            let username = extract_string(&parsed, &["username"])
                .unwrap_or_else(|| file_name.trim_end_matches(".json").to_string());
            let username = username.trim().to_string();
            if username.is_empty() {
                continue;
            }
            let username_key = normalize(&username);
            let alias = username_aliases.get(&username_key).cloned();
            let is_dev_hub =
                extract_bool(&parsed, &["isDevHub", "isDevHubUsername"]).unwrap_or(false);
            let is_scratch_org = extract_bool(&parsed, &["isScratch", "isScratchOrg"])
                .unwrap_or(false)
                || extract_string(&parsed, &["devHubUsername"])
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false);
            if is_scratch_org && !is_active_scratch_org(&parsed) {
                continue;
            }

            orgs.entry(username_key).or_insert_with(|| OrgSummary {
                username,
                alias: alias.clone(),
                is_default_username: matches_default(
                    &parsed,
                    alias.as_deref(),
                    defaults.target_org.as_deref(),
                    &aliases,
                ),
                is_default_dev_hub_username: is_dev_hub
                    && matches_default(
                        &parsed,
                        alias.as_deref(),
                        defaults.target_dev_hub.as_deref(),
                        &aliases,
                    ),
                is_scratch_org,
                instance_url: extract_string(&parsed, &["instanceUrl", "instance_url", "loginUrl"]),
            });
        }
    }

    if !saw_auth_dir {
        return Err(format!(
            "failed reading Salesforce auth directories '{}' and '{}'",
            auth_dirs[0].display(),
            auth_dirs[1].display()
        ));
    }

    let mut orgs = orgs.into_values().collect::<Vec<_>>();
    orgs.sort_by(|left, right| {
        right
            .is_default_username
            .cmp(&left.is_default_username)
            .then_with(|| {
                let left_key = left
                    .alias
                    .as_deref()
                    .unwrap_or(&left.username)
                    .to_ascii_lowercase();
                let right_key = right
                    .alias
                    .as_deref()
                    .unwrap_or(&right.username)
                    .to_ascii_lowercase();
                left_key.cmp(&right_key)
            })
    });
    Ok(orgs)
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("USERPROFILE")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
}

fn is_auth_file_name(file_name: &str) -> bool {
    if file_name.starts_with('.')
        || !file_name.ends_with(".json")
        || file_name.contains(char::is_whitespace)
    {
        return false;
    }
    let stem = file_name.trim_end_matches(".json");
    let Some((_, domain)) = stem.split_once('@') else {
        return false;
    };
    !domain.is_empty() && domain.contains('.')
}

fn load_aliases(home: &Path) -> BTreeMap<String, String> {
    let mut aliases = BTreeMap::new();
    for path in [home.join(".sfdx/alias.json"), home.join(".sf/alias.json")] {
        let Some(parsed) = read_json_file(&path) else {
            continue;
        };
        let Some(orgs) = parsed.get("orgs").and_then(Value::as_object) else {
            continue;
        };
        for (alias, username) in orgs {
            let alias = alias.trim();
            let Some(username) = username
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if !alias.is_empty() {
                aliases.insert(alias.to_string(), username.to_string());
            }
        }
    }
    aliases
}

fn alias_by_username(aliases: &BTreeMap<String, String>) -> HashMap<String, String> {
    let mut by_username = HashMap::new();
    for (alias, username) in aliases {
        by_username
            .entry(normalize(username))
            .or_insert_with(|| alias.clone());
    }
    by_username
}

fn load_defaults(home: &Path, cwd: &Path) -> Defaults {
    let mut defaults = Defaults {
        target_org: first_env_value(&["SF_TARGET_ORG", "SFDX_DEFAULTUSERNAME"]),
        target_dev_hub: first_env_value(&["SF_TARGET_DEV_HUB", "SFDX_DEFAULTDEVHUBUSERNAME"]),
    };

    for path in config_paths(home, cwd) {
        let Some(parsed) = read_json_file(&path) else {
            continue;
        };
        if defaults.target_org.is_none() {
            defaults.target_org =
                extract_string(&parsed, &["target-org", "targetOrg", "defaultusername"]);
        }
        if defaults.target_dev_hub.is_none() {
            defaults.target_dev_hub = extract_string(
                &parsed,
                &["target-dev-hub", "targetDevHub", "defaultdevhubusername"],
            );
        }
        if defaults.target_org.is_some() && defaults.target_dev_hub.is_some() {
            break;
        }
    }

    defaults
}

fn config_paths(home: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for dir in cwd.ancestors() {
        paths.push(dir.join(".sf/config.json"));
        paths.push(dir.join(".sfdx/sfdx-config.json"));
        paths.push(dir.join(".sfdx/config.json"));
    }
    paths.push(home.join(".sf/config.json"));
    paths.push(home.join(".sfdx/sfdx-config.json"));
    paths.push(home.join(".sfdx/config.json"));
    paths
}

fn first_env_value(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn read_json_file(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn matches_default(
    auth: &Value,
    alias: Option<&str>,
    target: Option<&str>,
    aliases: &BTreeMap<String, String>,
) -> bool {
    let Some(target) = target.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let username = extract_string(auth, &["username"]).unwrap_or_default();
    if same_id(&username, target) || alias.is_some_and(|alias| same_id(alias, target)) {
        return true;
    }
    aliases
        .get(target)
        .map(|mapped_username| same_id(mapped_username, &username))
        .unwrap_or(false)
}

fn extract_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn extract_bool(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_bool))
}

fn is_active_scratch_org(auth: &Value) -> bool {
    if extract_bool(auth, &["isExpired"]).unwrap_or(false) {
        return false;
    }

    if extract_string(auth, &["status"])
        .is_some_and(|status| !status.eq_ignore_ascii_case("Active"))
    {
        return false;
    }

    if extract_string(auth, &["expirationDate"])
        .and_then(|value| parse_scratch_expiration_date(&value))
        .is_some_and(|expiration| expiration < chrono::Utc::now().date_naive())
    {
        return false;
    }

    true
}

fn parse_scratch_expiration_date(value: &str) -> Option<chrono::NaiveDate> {
    let date = value.trim().get(..10)?;
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn same_id(left: &str, right: &str) -> bool {
    normalize(left) == normalize(right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Mutex, OnceLock},
        time::{SystemTime, UNIX_EPOCH},
    };

    const DEFAULT_ENV_KEYS: &[&str] = &[
        "SF_TARGET_ORG",
        "SFDX_DEFAULTUSERNAME",
        "SF_TARGET_DEV_HUB",
        "SFDX_DEFAULTDEVHUBUSERNAME",
    ];

    struct EnvRestore(Vec<(&'static str, Option<String>)>);

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (key, value) in self.0.drain(..) {
                match value {
                    Some(value) => env::set_var(key, value),
                    None => env::remove_var(key),
                }
            }
        }
    }

    fn env_test_guard() -> &'static Mutex<()> {
        static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
        GUARD.get_or_init(|| Mutex::new(()))
    }

    fn clear_default_env() -> EnvRestore {
        let saved = DEFAULT_ENV_KEYS
            .iter()
            .map(|key| (*key, env::var(key).ok()))
            .collect::<Vec<_>>();
        for key in DEFAULT_ENV_KEYS {
            env::remove_var(key);
        }
        EnvRestore(saved)
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        let dir = env::temp_dir().join(format!("alv-org-inventory-{name}-{nonce}"));
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
    fn list_local_orgs_reads_auth_alias_and_defaults_without_secret_fields() {
        let _guard = env_test_guard()
            .lock()
            .expect("env test guard should not be poisoned");
        let _env_restore = clear_default_env();
        let home = temp_dir("home");
        let cwd = temp_dir("cwd");
        write(
            &home.join(".sfdx/alias.json"),
            r#"{"orgs":{"Demo":"demo@example.com","Hub":"hub@example.com"}}"#,
        );
        write(
            &cwd.join(".sf/config.json"),
            r#"{"target-org":"Demo","target-dev-hub":"Hub"}"#,
        );
        write(
            &home.join(".sfdx/demo@example.com.json"),
            r#"{
              "username": "demo@example.com",
              "instanceUrl": "https://demo.example.com",
              "devHubUsername": "hub@example.com",
              "refreshToken": "secret",
              "clientSecret": "secret"
            }"#,
        );
        write(
            &home.join(".sfdx/hub@example.com.json"),
            r#"{
              "username": "hub@example.com",
              "instanceUrl": "https://hub.example.com",
              "isDevHub": true,
              "accessToken": "secret"
            }"#,
        );

        let orgs = list_local_orgs_with_context(&home, &cwd).expect("local orgs should load");
        assert_eq!(orgs.len(), 2);
        assert_eq!(orgs[0].username, "demo@example.com");
        assert_eq!(orgs[0].alias.as_deref(), Some("Demo"));
        assert!(orgs[0].is_default_username);
        assert!(orgs[0].is_scratch_org);
        assert_eq!(orgs[1].username, "hub@example.com");
        assert_eq!(orgs[1].alias.as_deref(), Some("Hub"));
        assert!(orgs[1].is_default_dev_hub_username);

        let serialized = serde_json::to_string(&orgs).expect("orgs should serialize");
        assert!(!serialized.contains("secret"));

        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn list_local_orgs_reads_sf_auth_dir_and_prefers_it_over_sfdx_duplicates() {
        let _guard = env_test_guard()
            .lock()
            .expect("env test guard should not be poisoned");
        let _env_restore = clear_default_env();
        let home = temp_dir("home");
        let cwd = temp_dir("cwd");
        write(
            &home.join(".sfdx/alias.json"),
            r#"{"orgs":{"Shared":"shared@example.com","New":"new@example.com"}}"#,
        );
        write(
            &home.join(".sfdx/shared@example.com.json"),
            r#"{
              "username": "shared@example.com",
              "instanceUrl": "https://old.example.com"
            }"#,
        );
        write(
            &home.join(".sf/shared@example.com.json"),
            r#"{
              "username": "shared@example.com",
              "instanceUrl": "https://new.example.com"
            }"#,
        );
        write(
            &home.join(".sf/new@example.com.json"),
            r#"{
              "username": "new@example.com",
              "instanceUrl": "https://only-new.example.com"
            }"#,
        );

        let orgs = list_local_orgs_with_context(&home, &cwd).expect("local orgs should load");
        assert_eq!(orgs.len(), 2);

        let shared = orgs
            .iter()
            .find(|org| org.username == "shared@example.com")
            .expect("shared org should load once");
        assert_eq!(shared.alias.as_deref(), Some("Shared"));
        assert_eq!(
            shared.instance_url.as_deref(),
            Some("https://new.example.com")
        );

        let new = orgs
            .iter()
            .find(|org| org.username == "new@example.com")
            .expect(".sf-only org should load");
        assert_eq!(new.alias.as_deref(), Some("New"));

        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn list_local_orgs_filters_inactive_scratch_orgs() {
        let _guard = env_test_guard()
            .lock()
            .expect("env test guard should not be poisoned");
        let _env_restore = clear_default_env();
        let home = temp_dir("home");
        let cwd = temp_dir("cwd");
        write(
            &home.join(".sfdx/active@example.com.json"),
            r#"{
              "username": "active@example.com",
              "instanceUrl": "https://active.example.com",
              "isScratch": true,
              "status": "Active",
              "expirationDate": "2999-01-01"
            }"#,
        );
        write(
            &home.join(".sfdx/deleted@example.com.json"),
            r#"{
              "username": "deleted@example.com",
              "instanceUrl": "https://deleted.example.com",
              "isScratch": true,
              "status": "Deleted",
              "expirationDate": "2999-01-01"
            }"#,
        );
        write(
            &home.join(".sfdx/expired@example.com.json"),
            r#"{
              "username": "expired@example.com",
              "instanceUrl": "https://expired.example.com",
              "isScratch": true,
              "status": "Active",
              "expirationDate": "2000-01-01"
            }"#,
        );
        write(
            &home.join(".sfdx/flagged@example.com.json"),
            r#"{
              "username": "flagged@example.com",
              "instanceUrl": "https://flagged.example.com",
              "isScratch": true,
              "isExpired": true,
              "expirationDate": "2999-01-01"
            }"#,
        );

        let orgs = list_local_orgs_with_context(&home, &cwd).expect("local orgs should load");

        assert_eq!(orgs.len(), 1);
        assert_eq!(orgs[0].username, "active@example.com");

        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn auth_file_name_filter_excludes_org_id_and_hidden_json_files() {
        assert!(is_auth_file_name("demo@example.com.json"));
        assert!(!is_auth_file_name("00D000000000001.json"));
        assert!(!is_auth_file_name(".hidden@example.com.json"));
        assert!(!is_auth_file_name("alias.json"));
    }
}
