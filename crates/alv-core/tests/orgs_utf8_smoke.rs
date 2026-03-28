use alv_core::orgs::list_orgs_from_json;

#[test]
fn orgs_smoke_preserves_utf8_aliases_from_sf_json() {
    let orgs = list_orgs_from_json(
        r#"{
          "result": {
            "nonScratchOrgs": [
              {
                "username": "default@example.com",
                "alias": "São José",
                "isDefaultUsername": true,
                "instanceUrl": "https://default.example.com"
              }
            ]
          }
        }"#,
    )
    .expect("utf8 org list should parse");

    assert_eq!(orgs.len(), 1);
    assert_eq!(orgs[0].alias.as_deref(), Some("São José"));
}
