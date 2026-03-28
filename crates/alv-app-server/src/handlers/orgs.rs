use alv_core::{auth::resolve_org_auth, orgs::list_orgs};

pub fn handle_org_list(force_refresh: bool) -> Result<String, String> {
    let orgs = list_orgs(force_refresh)?;
    Ok(serialize_orgs(&orgs))
}

pub fn handle_org_auth(username: Option<&str>) -> Result<String, String> {
    let auth = resolve_org_auth(username)?;
    Ok(format!(
        "{{\"accessToken\":\"{}\",\"instanceUrl\":\"{}\"{}}}",
        escape_json(&auth.access_token),
        escape_json(&auth.instance_url),
        auth.username
            .as_deref()
            .map(|value| format!(",\"username\":\"{}\"", escape_json(value)))
            .unwrap_or_default()
    ))
}

fn serialize_orgs(orgs: &[alv_core::orgs::OrgSummary]) -> String {
    let mut json = String::from("[");

    for (index, org) in orgs.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }

        json.push('{');
        json.push_str("\"username\":\"");
        json.push_str(&escape_json(&org.username));
        json.push('"');

        if let Some(alias) = &org.alias {
            json.push_str(",\"alias\":\"");
            json.push_str(&escape_json(alias));
            json.push('"');
        }

        if org.is_default_username {
            json.push_str(",\"isDefaultUsername\":true");
        }

        if org.is_default_dev_hub_username {
            json.push_str(",\"isDefaultDevHubUsername\":true");
        }

        if org.is_scratch_org {
            json.push_str(",\"isScratchOrg\":true");
        }

        if let Some(instance_url) = &org.instance_url {
            json.push_str(",\"instanceUrl\":\"");
            json.push_str(&escape_json(instance_url));
            json.push('"');
        }

        json.push('}');
    }

    json.push(']');
    json
}

fn escape_json(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    escaped
}
