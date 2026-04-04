use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use alv_core::log_store::{
    find_cached_log_path, log_file_path_for_start_time, org_metadata_path, read_sync_state,
    read_version_file, safe_target_org, sync_state_path, version_file_path, write_org_metadata,
    write_sync_state, write_version_file, OrgMetadata, SyncState, SyncStateOrgEntry,
};

fn make_temp_workspace(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("alv-log-store-{label}-{nonce}"));
    fs::create_dir_all(&root).expect("temp workspace should be creatable");
    root
}

#[test]
fn log_store_places_logs_under_org_and_day_directory() {
    let workspace_root = make_temp_workspace("org-first");
    let safe_org = safe_target_org("Default Org@example.com");
    let file_path = log_file_path_for_start_time(
        Some(
            workspace_root
                .to_str()
                .expect("workspace path should be utf8"),
        ),
        "Default Org@example.com",
        "2026-03-30T18:39:58.000Z",
        "07L000000000003AA",
    );

    assert_eq!(
        file_path,
        workspace_root
            .join("apexlogs")
            .join("orgs")
            .join(&safe_org)
            .join("logs")
            .join("2026-03-30")
            .join("07L000000000003AA.log")
    );

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_finds_new_layout_before_legacy_flat_files() {
    let workspace_root = make_temp_workspace("find-cache");
    let safe_org = safe_target_org("default@example.com");
    let new_path = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join(&safe_org)
        .join("logs")
        .join("2026-03-30")
        .join("07L000000000001AA.log");
    fs::create_dir_all(new_path.parent().expect("log parent should exist"))
        .expect("new layout dir should be creatable");
    fs::write(&new_path, "new-layout").expect("new layout log should be writable");

    let legacy_path = workspace_root
        .join("apexlogs")
        .join("default_07L000000000001AA.log");
    fs::write(&legacy_path, "legacy-layout").expect("legacy log should be writable");

    let found = find_cached_log_path(
        Some(
            workspace_root
                .to_str()
                .expect("workspace path should be utf8"),
        ),
        "07L000000000001AA",
        Some("default@example.com"),
    )
    .expect("cache lookup should return a path");

    assert_eq!(found, new_path);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_falls_back_to_legacy_flat_files_when_new_layout_is_absent() {
    let workspace_root = make_temp_workspace("legacy-only");
    fs::create_dir_all(workspace_root.join("apexlogs"))
        .expect("legacy cache dir should be creatable");
    let legacy_path = workspace_root
        .join("apexlogs")
        .join("default_07L000000000002AA.log");
    fs::write(&legacy_path, "legacy-layout").expect("legacy log should be writable");

    let found = find_cached_log_path(
        Some(
            workspace_root
                .to_str()
                .expect("workspace path should be utf8"),
        ),
        "07L000000000002AA",
        None,
    )
    .expect("cache lookup should return a legacy path");

    assert_eq!(found, legacy_path);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_scoped_lookup_uses_matching_legacy_flat_file_without_cross_org_leakage() {
    let workspace_root = make_temp_workspace("scoped-legacy-only");
    let apexlogs_root = workspace_root.join("apexlogs");
    fs::create_dir_all(
        apexlogs_root
            .join("orgs")
            .join("other@example.com")
            .join("logs")
            .join("2026-03-30"),
    )
    .expect("other org dir should be creatable");
    let log_id = "07L0000000000SCO";
    fs::write(
        apexlogs_root
            .join("orgs")
            .join("other@example.com")
            .join("logs")
            .join("2026-03-30")
            .join(format!("{log_id}.log")),
        "other-org",
    )
    .expect("other org cached log should be writable");
    let scoped_legacy = apexlogs_root.join(format!("selected@example.com_{log_id}.log"));
    fs::write(&scoped_legacy, "scoped-legacy").expect("scoped legacy log should be writable");

    let found = find_cached_log_path(
        Some(
            workspace_root
                .to_str()
                .expect("workspace path should be utf8"),
        ),
        log_id,
        Some("selected@example.com"),
    )
    .expect("scoped lookup should return the matching legacy flat path");

    assert_eq!(found, scoped_legacy);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_scoped_lookup_does_not_scan_other_org_trees_when_scope_misses() {
    let workspace_root = make_temp_workspace("scoped-no-cross-org");
    let other_org_dir = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("other@example.com")
        .join("logs")
        .join("2026-03-30");
    fs::create_dir_all(&other_org_dir).expect("other org dir should be creatable");
    let log_id = "07L0000000000MIS";
    fs::write(other_org_dir.join(format!("{log_id}.log")), "other-org")
        .expect("other org cached log should be writable");

    let found = find_cached_log_path(
        Some(
            workspace_root
                .to_str()
                .expect("workspace path should be utf8"),
        ),
        log_id,
        Some("selected@example.com"),
    );

    assert!(
        found.is_none(),
        "scoped lookup should not leak into other org trees"
    );
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_ignores_matching_files_outside_logs_day_directories() {
    let workspace_root = make_temp_workspace("bounded-layout");
    let off_layout = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com")
        .join("logs")
        .join("archive")
        .join("2026-03-30");
    fs::create_dir_all(&off_layout).expect("archive dir should be creatable");
    fs::write(off_layout.join("07L0000000000BAD.log"), "off-layout")
        .expect("off-layout file should be writable");

    let found = find_cached_log_path(
        Some(
            workspace_root
                .to_str()
                .expect("workspace path should be utf8"),
        ),
        "07L0000000000BAD",
        Some("default@example.com"),
    );

    assert!(
        found.is_none(),
        "lookup should ignore files outside logs/<day>/"
    );
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_ignores_matching_files_in_unsupported_logs_subdirectories() {
    let workspace_root = make_temp_workspace("unsupported-log-dir");
    let off_layout = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com")
        .join("logs")
        .join("archive");
    fs::create_dir_all(&off_layout).expect("archive dir should be creatable");
    fs::write(off_layout.join("07L0000000000ARC.log"), "off-layout")
        .expect("off-layout file should be writable");

    let found = find_cached_log_path(
        Some(
            workspace_root
                .to_str()
                .expect("workspace path should be utf8"),
        ),
        "07L0000000000ARC",
        Some("default@example.com"),
    );

    assert!(
        found.is_none(),
        "lookup should ignore unsupported logs subdirectories like archive/"
    );
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_unscoped_lookup_ignores_matching_files_outside_logs_day_directories() {
    let workspace_root = make_temp_workspace("bounded-unscoped");
    let off_layout = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("other@example.com")
        .join("tmp")
        .join("2026-03-30");
    fs::create_dir_all(&off_layout).expect("tmp dir should be creatable");
    fs::write(off_layout.join("07L0000000000OFF.log"), "off-layout")
        .expect("off-layout file should be writable");

    let found = find_cached_log_path(
        Some(
            workspace_root
                .to_str()
                .expect("workspace path should be utf8"),
        ),
        "07L0000000000OFF",
        None,
    );

    assert!(
        found.is_none(),
        "unscoped lookup should still respect the supported layout"
    );
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_finds_unknown_date_layout_files() {
    let workspace_root = make_temp_workspace("unknown-date");
    let unknown_date = workspace_root
        .join("apexlogs")
        .join("orgs")
        .join("default@example.com")
        .join("logs")
        .join("unknown-date")
        .join("07L0000000000UNK.log");
    fs::create_dir_all(
        unknown_date
            .parent()
            .expect("unknown-date parent should exist"),
    )
    .expect("unknown-date dir should be creatable");
    fs::write(&unknown_date, "unknown-date").expect("unknown-date log should be writable");

    let found = find_cached_log_path(
        Some(
            workspace_root
                .to_str()
                .expect("workspace path should be utf8"),
        ),
        "07L0000000000UNK",
        Some("default@example.com"),
    )
    .expect("lookup should find unknown-date layout");

    assert_eq!(found, unknown_date);
    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_ignores_empty_log_ids() {
    let workspace_root = make_temp_workspace("empty-log-id");
    let workspace_text = workspace_root
        .to_str()
        .expect("workspace path should be utf8");

    assert!(find_cached_log_path(Some(workspace_text), "", None).is_none());
    assert!(
        find_cached_log_path(Some(workspace_text), "   ", Some("default@example.com")).is_none()
    );

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_round_trips_version_state_and_org_metadata() {
    let workspace_root = make_temp_workspace("state");
    let workspace_text = workspace_root
        .to_str()
        .expect("workspace path should be utf8");
    let safe_org = safe_target_org("default@example.com");

    write_version_file(Some(workspace_text), 1).expect("version file should write");
    write_sync_state(
        Some(workspace_text),
        &SyncState {
            version: 1,
            orgs: [(
                "default@example.com".to_string(),
                SyncStateOrgEntry {
                    target_org: "default@example.com".to_string(),
                    safe_target_org: safe_org.clone(),
                    org_dir: format!("apexlogs/orgs/{safe_org}"),
                    last_sync_started_at: Some("2026-03-30T18:40:00.000Z".to_string()),
                    last_sync_completed_at: Some("2026-03-30T18:40:04.000Z".to_string()),
                    last_synced_log_id: Some("07L000000000003AA".to_string()),
                    last_synced_start_time: Some("2026-03-30T18:39:58.000Z".to_string()),
                    downloaded_count: 3,
                    cached_count: 12,
                    last_error: None,
                },
            )]
            .into_iter()
            .collect(),
        },
    )
    .expect("sync state should write");
    write_org_metadata(
        Some(workspace_text),
        &OrgMetadata {
            target_org: "default@example.com".to_string(),
            safe_target_org: safe_org.clone(),
            resolved_username: "default@example.com".to_string(),
            alias: Some("Default".to_string()),
            instance_url: Some("https://default.example.com".to_string()),
            updated_at: "2026-03-30T18:40:04.000Z".to_string(),
        },
    )
    .expect("org metadata should write");

    assert_eq!(
        read_version_file(Some(workspace_text)).expect("version should load"),
        1
    );
    let state = read_sync_state(Some(workspace_text)).expect("sync state should load");
    assert_eq!(state.orgs["default@example.com"].downloaded_count, 3);
    let metadata_path = org_metadata_path(Some(workspace_text), "default@example.com");
    let metadata_bytes = fs::read(&metadata_path).expect("org metadata file should exist");
    let metadata: OrgMetadata =
        serde_json::from_slice(&metadata_bytes).expect("org metadata should parse");
    assert_eq!(metadata.target_org, "default@example.com");
    assert_eq!(metadata.safe_target_org, safe_org);
    assert_eq!(metadata.resolved_username, "default@example.com");
    assert_eq!(metadata.alias.as_deref(), Some("Default"));
    assert_eq!(
        metadata.instance_url.as_deref(),
        Some("https://default.example.com")
    );
    assert_eq!(metadata.updated_at, "2026-03-30T18:40:04.000Z");
    assert!(version_file_path(Some(workspace_text)).is_file());
    assert!(sync_state_path(Some(workspace_text)).is_file());

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}

#[test]
fn log_store_writes_org_metadata_under_resolved_username_for_aliases() {
    let workspace_root = make_temp_workspace("alias-metadata");
    let workspace_text = workspace_root
        .to_str()
        .expect("workspace path should be utf8");

    let metadata = OrgMetadata {
        target_org: "my-alias".to_string(),
        safe_target_org: safe_target_org("my-alias"),
        resolved_username: "default@example.com".to_string(),
        alias: Some("my-alias".to_string()),
        instance_url: Some("https://default.example.com".to_string()),
        updated_at: "2026-03-30T18:41:00.000Z".to_string(),
    };

    write_org_metadata(Some(workspace_text), &metadata).expect("org metadata should write");

    let resolved_path = org_metadata_path(Some(workspace_text), "default@example.com");
    let alias_path = org_metadata_path(Some(workspace_text), "my-alias");
    assert!(resolved_path.is_file());
    assert!(!alias_path.is_file());

    let bytes = fs::read(&resolved_path).expect("resolved org metadata should exist");
    let written: OrgMetadata =
        serde_json::from_slice(&bytes).expect("resolved org metadata should parse");
    assert_eq!(written.target_org, "my-alias");
    assert_eq!(written.safe_target_org, safe_target_org("my-alias"));
    assert_eq!(written.resolved_username, "default@example.com");
    assert_eq!(written.alias.as_deref(), Some("my-alias"));
    assert_eq!(
        written.instance_url.as_deref(),
        Some("https://default.example.com")
    );
    assert_eq!(written.updated_at, "2026-03-30T18:41:00.000Z");

    fs::remove_dir_all(workspace_root).expect("temp workspace should be removable");
}
