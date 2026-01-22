use apex_log_viewer_cli::sfdx_project::find_project_root;
use std::fs;

#[test]
fn find_project_root_returns_none_when_missing() {
  let dir = tempfile::tempdir().expect("tempdir");
  assert!(find_project_root(dir.path()).is_none());
}

#[test]
fn find_project_root_finds_nearest_parent() {
  let dir = tempfile::tempdir().expect("tempdir");
  let root = dir.path().join("root");
  fs::create_dir_all(&root).expect("create root");
  fs::write(
    root.join("sfdx-project.json"),
    r#"{ "sourceApiVersion": "64.0" }"#,
  )
  .expect("write sfdx-project.json");

  let nested = root.join("a/b/c");
  fs::create_dir_all(&nested).expect("create nested");

  let found = find_project_root(&nested).expect("expected project root");
  assert_eq!(found, root);
}
