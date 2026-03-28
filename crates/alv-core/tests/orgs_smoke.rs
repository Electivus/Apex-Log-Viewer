use std::sync::{Mutex, OnceLock};

use alv_core::{auth::resolve_org_auth, cache, orgs::list_orgs};

fn test_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}

#[test]
fn orgs_smoke_lists_orgs_from_fixture_and_respects_cache_refresh() {
    let _guard = test_guard()
        .lock()
        .expect("test guard lock should not be poisoned");

    cache::clear_all();

    std::env::set_var(
        "ALV_TEST_SF_ORG_LIST_JSON",
        r#"{
          "result": {
            "nonScratchOrgs": [
              {
                "username": "default@example.com",
                "alias": "Default",
                "isDefaultUsername": true,
                "instanceUrl": "https://default.example.com"
              }
            ]
          }
        }"#,
    );

    let first = list_orgs(false).expect("fixture-backed org list should succeed");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].username, "default@example.com");
    assert_eq!(first[0].alias.as_deref(), Some("Default"));
    assert!(first[0].is_default_username);

    std::env::set_var(
        "ALV_TEST_SF_ORG_LIST_JSON",
        r#"{
          "result": {
            "nonScratchOrgs": [
              {
                "username": "changed@example.com",
                "alias": "Changed",
                "instanceUrl": "https://changed.example.com"
              }
            ]
          }
        }"#,
    );

    let cached = list_orgs(false).expect("cached org list should still be available");
    assert_eq!(cached[0].username, "default@example.com");

    let refreshed = list_orgs(true).expect("force refresh should bypass cache");
    assert_eq!(refreshed[0].username, "changed@example.com");

    std::env::remove_var("ALV_TEST_SF_ORG_LIST_JSON");
    cache::clear_all();
}

#[test]
fn orgs_smoke_resolves_org_auth_from_fixture() {
    let _guard = test_guard()
        .lock()
        .expect("test guard lock should not be poisoned");

    std::env::set_var(
        "ALV_TEST_SF_ORG_DISPLAY_JSON",
        r#"{
          "result": {
            "username": "default@example.com",
            "accessToken": "token",
            "instanceUrl": "https://default.example.com"
          }
        }"#,
    );

    let auth = resolve_org_auth(Some("default@example.com"))
        .expect("fixture-backed org auth should succeed");
    assert_eq!(auth.username.as_deref(), Some("default@example.com"));
    assert_eq!(auth.access_token, "token");
    assert_eq!(auth.instance_url, "https://default.example.com");

    std::env::remove_var("ALV_TEST_SF_ORG_DISPLAY_JSON");
}
