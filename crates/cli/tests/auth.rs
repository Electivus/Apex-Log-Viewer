use apex_log_viewer_cli::auth::{get_auth_with_runner, parse_auth_json, AuthError};

#[test]
fn parse_auth_json_reads_sf_fields() {
  let input = r#"{
    "status": 0,
    "result": {
      "accessToken": "00Dxx0000000001!AAA",
      "instanceUrl": "https://example.my.salesforce.com",
      "username": "user@example.com"
    }
  }"#;

  let auth = parse_auth_json(input).expect("parse auth");
  assert_eq!(auth.access_token, "00Dxx0000000001!AAA");
  assert_eq!(auth.instance_url, "https://example.my.salesforce.com");
  assert_eq!(auth.username.as_deref(), Some("user@example.com"));
}

#[test]
fn parse_auth_json_reads_legacy_fields() {
  let input = r#"{
    "status": 0,
    "result": {
      "access_token": "00Dxx0000000002!BBB",
      "instance_url": "https://legacy.my.salesforce.com",
      "username": "legacy@example.com"
    }
  }"#;

  let auth = parse_auth_json(input).expect("parse auth");
  assert_eq!(auth.access_token, "00Dxx0000000002!BBB");
  assert_eq!(auth.instance_url, "https://legacy.my.salesforce.com");
  assert_eq!(auth.username.as_deref(), Some("legacy@example.com"));
}

#[test]
fn get_auth_prefers_sf_then_falls_back_to_sfdx() {
  let input = r#"{
    "status": 0,
    "result": {
      "accessToken": "00Dxx0000000003!CCC",
      "instanceUrl": "https://fallback.my.salesforce.com",
      "username": "fallback@example.com"
    }
  }"#;

  let mut calls: Vec<(String, Vec<String>)> = Vec::new();
  let auth = get_auth_with_runner(Some("alias"), |program, args| {
    calls.push((program.to_string(), args.to_vec()));
    if program == "sf" {
      return Err(AuthError::CommandFailed("sf missing".to_string()));
    }
    Ok(input.to_string())
  })
  .expect("auth resolves");

  assert_eq!(auth.access_token, "00Dxx0000000003!CCC");
  assert_eq!(auth.instance_url, "https://fallback.my.salesforce.com");
  assert_eq!(auth.username.as_deref(), Some("fallback@example.com"));

  assert_eq!(calls.len(), 2);
  assert_eq!(calls[0].0, "sf");
  assert!(calls[0].1.contains(&"org".to_string()));
  assert!(calls[0].1.contains(&"display".to_string()));
  assert!(calls[0].1.contains(&"-o".to_string()));
  assert!(calls[0].1.contains(&"alias".to_string()));

  assert_eq!(calls[1].0, "sfdx");
  assert!(calls[1].1.contains(&"force:org:display".to_string()));
  assert!(calls[1].1.contains(&"-u".to_string()));
  assert!(calls[1].1.contains(&"alias".to_string()));
}
