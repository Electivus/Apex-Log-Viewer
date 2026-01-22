use std::path::{Path, PathBuf};

pub fn find_project_root(start: &Path) -> Option<PathBuf> {
  let mut current = if start.is_file() {
    start.parent()?.to_path_buf()
  } else {
    start.to_path_buf()
  };

  loop {
    if current.join("sfdx-project.json").is_file() {
      return Some(current);
    }
    if !current.pop() {
      break;
    }
  }

  None
}
