use alv_core::{
    auth::{resolve_org_auth, OrgAuth},
    orgs::{list_orgs, OrgSummary},
};

pub fn handle_org_list(force_refresh: bool) -> Result<String, String> {
    let orgs = list_orgs(force_refresh)?;
    serialize_orgs(&orgs)
}

pub fn handle_org_auth(username: Option<&str>) -> Result<String, String> {
    let auth = resolve_org_auth(username)?;
    serialize_org_auth(&auth)
}

fn serialize_org_auth(auth: &OrgAuth) -> Result<String, String> {
    serde_json::to_string(auth).map_err(|error| format!("failed to serialize org auth: {error}"))
}

fn serialize_orgs(orgs: &[OrgSummary]) -> Result<String, String> {
    serde_json::to_string(orgs).map_err(|error| format!("failed to serialize org list: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alv_core::{auth::OrgAuth, orgs::OrgSummary};

    #[test]
    fn serialize_org_auth_escapes_all_control_chars() {
        let payload = serialize_org_auth(&OrgAuth {
            access_token: "token\u{0008}value".to_string(),
            instance_url: "https://example.com/\u{000c}org".to_string(),
            username: Some("demo\u{001b}@example.com".to_string()),
        })
        .expect("org auth should serialize");

        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("org auth payload should be valid json");

        assert_eq!(parsed["accessToken"].as_str(), Some("token\u{0008}value"));
        assert_eq!(
            parsed["instanceUrl"].as_str(),
            Some("https://example.com/\u{000c}org")
        );
        assert_eq!(
            parsed["username"].as_str(),
            Some("demo\u{001b}@example.com")
        );
    }

    #[test]
    fn serialize_orgs_escapes_all_control_chars() {
        let payload = serialize_orgs(&[OrgSummary {
            username: "demo\u{0008}@example.com".to_string(),
            alias: Some("Alias\u{000c}".to_string()),
            is_default_username: true,
            is_default_dev_hub_username: false,
            is_scratch_org: true,
            instance_url: Some("https://example.com/\u{001b}org".to_string()),
        }])
        .expect("org list should serialize");

        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("org list payload should be valid json");

        assert_eq!(
            parsed[0]["username"].as_str(),
            Some("demo\u{0008}@example.com")
        );
        assert_eq!(parsed[0]["alias"].as_str(), Some("Alias\u{000c}"));
        assert_eq!(
            parsed[0]["instanceUrl"].as_str(),
            Some("https://example.com/\u{001b}org")
        );
        assert_eq!(parsed[0]["isDefaultUsername"].as_bool(), Some(true));
        assert_eq!(parsed[0]["isScratchOrg"].as_bool(), Some(true));
    }
}
