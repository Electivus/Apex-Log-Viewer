use std::process::Command;

pub const TEST_ORG_LIST_JSON_ENV: &str = "ALV_TEST_SF_ORG_LIST_JSON";
pub const TEST_ORG_DISPLAY_JSON_ENV: &str = "ALV_TEST_SF_ORG_DISPLAY_JSON";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgAuth {
    pub access_token: String,
    pub instance_url: String,
    pub username: Option<String>,
}

pub fn run_sf_org_list_json() -> Result<String, String> {
    if let Ok(fixture) = std::env::var(TEST_ORG_LIST_JSON_ENV) {
        return Ok(fixture);
    }

    let attempts: [(&str, &[&str]); 2] = [
        ("sf", &["org", "list", "--json", "--skip-connection-status"]),
        ("sfdx", &["force:org:list", "--json"]),
    ];

    let mut last_error = String::from("Salesforce CLI not found");

    for (program, args) in attempts {
        match run_command(program, args) {
            Ok(stdout) => return Ok(stdout),
            Err(error) => {
                last_error = error;
            }
        }
    }

    Err(last_error)
}

pub fn resolve_org_auth(target_username_or_alias: Option<&str>) -> Result<OrgAuth, String> {
    if let Ok(fixture) = std::env::var(TEST_ORG_DISPLAY_JSON_ENV) {
        return resolve_org_auth_from_json(&fixture);
    }

    resolve_org_auth_with_runner(
        build_org_auth_attempts(target_username_or_alias),
        run_command,
    )
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
        ("sfdx", vec!["force:org:display", "--json"]),
    ];

    if let Some(value) = target_username_or_alias {
        attempts[0].1.extend(["-o", value]);
        attempts[1].1.extend(["-o", value]);
        attempts[2].1.extend(["-o", value]);
        attempts[3].1.extend(["-o", value]);
        attempts[4].1.extend(["-u", value]);
    }

    attempts
}

fn resolve_org_auth_with_runner<'a, F>(
    attempts: Vec<(&'static str, Vec<&'a str>)>,
    mut runner: F,
) -> Result<OrgAuth, String>
where
    F: FnMut(&str, &[&'a str]) -> Result<String, String>,
{
    let mut last_error = String::from("Salesforce CLI not found");

    for (program, args) in attempts {
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
    let output = Command::new(program)
        .args(args)
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

pub fn resolve_org_auth_from_json(json: &str) -> Result<OrgAuth, String> {
    let access_token = extract_json_string(json, &["result", "accessToken"])
        .or_else(|| extract_json_string(json, &["result", "access_token"]))
        .ok_or_else(|| "CLI JSON missing access token".to_string())?;
    let instance_url = extract_json_string(json, &["result", "instanceUrl"])
        .or_else(|| extract_json_string(json, &["result", "instance_url"]))
        .or_else(|| extract_json_string(json, &["result", "loginUrl"]))
        .ok_or_else(|| "CLI JSON missing instance URL".to_string())?;
    let username = extract_json_string(json, &["result", "username"]);

    Ok(OrgAuth {
        access_token,
        instance_url,
        username,
    })
}

fn extract_json_string(source: &str, path: &[&str]) -> Option<String> {
    let mut current = source.to_string();
    for key in path.iter().take(path.len().saturating_sub(1)) {
        current = extract_json_object(&current, key)?;
    }
    extract_json_leaf_string(&current, path.last().copied()?)
}

fn extract_json_object(source: &str, key: &str) -> Option<String> {
    let key_marker = format!("\"{key}\"");
    let key_index = source.find(&key_marker)?;
    let after_key = &source[key_index + key_marker.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon = after_key[colon_index + 1..].trim_start();
    let object_start = after_colon.find('{')?;
    let mut depth = 0usize;
    let mut escaped = false;
    let mut in_string = false;

    for (offset, ch) in after_colon[object_start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        match ch {
            '\\' if in_string => escaped = true,
            '"' => in_string = !in_string,
            '{' if !in_string => depth += 1,
            '}' if !in_string => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(after_colon[object_start..=object_start + offset].to_string());
                }
            }
            _ => {}
        }
    }

    None
}

fn extract_json_leaf_string(source: &str, key: &str) -> Option<String> {
    let key_marker = format!("\"{key}\"");
    let key_index = source.find(&key_marker)?;
    let after_key = &source[key_index + key_marker.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon = after_key[colon_index + 1..].trim_start();
    let mut chars = after_colon.chars();
    if chars.next()? != '"' {
        return None;
    }

    let mut value = String::new();
    let mut escaped = false;
    for ch in chars {
        if escaped {
            value.push(match ch {
                '"' => '"',
                '\\' => '\\',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
            continue;
        }

        match ch {
            '\\' => escaped = true,
            '"' => return Some(value),
            other => value.push(other),
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
                "sf org display --json --verbose -o demo@example.com",
                "sf org user display --json --verbose -o demo@example.com",
                "sf org user display --json -o demo@example.com",
                "sf org display --json -o demo@example.com",
                "sfdx force:org:display --json -u demo@example.com",
            ]
        );
    }

    #[test]
    fn resolve_org_auth_with_runner_falls_back_when_first_payload_lacks_token() {
        let mut invocations = Vec::new();
        let attempts = build_org_auth_attempts(Some("ALV_E2E_Scratch"));
        let auth = resolve_org_auth_with_runner(attempts, |program, args| {
            invocations.push(format!("{program} {}", args.join(" ")));
            match invocations.len() {
                1 => Ok(
                    r#"{"status":0,"result":{"username":"ALV_E2E_Scratch","instanceUrl":"https://example.my.salesforce.com"}}"#
                        .to_string(),
                ),
                2 => Ok(
                    r#"{"status":0,"result":{"accessToken":"00D-token","instanceUrl":"https://example.my.salesforce.com","username":"ALV_E2E_Scratch"}}"#
                        .to_string(),
                ),
                _ => Err("unexpected extra attempt".to_string()),
            }
        })
        .expect("expected auth fallback to succeed");

        assert_eq!(auth.access_token, "00D-token");
        assert_eq!(auth.instance_url, "https://example.my.salesforce.com");
        assert_eq!(auth.username.as_deref(), Some("ALV_E2E_Scratch"));
        assert_eq!(
            invocations,
            vec![
                "sf org display --json --verbose -o ALV_E2E_Scratch",
                "sf org user display --json --verbose -o ALV_E2E_Scratch",
            ]
        );
    }
}
