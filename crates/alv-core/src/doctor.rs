use serde::{Deserialize, Serialize};
use std::{env, fs, process::Command};

use crate::{auth, log_store};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorResult {
    pub status: String,
    pub runtime_version: String,
    pub platform: String,
    pub arch: String,
    pub workspace_root: String,
    pub apexlogs_root: String,
    pub sf: DoctorCheck,
    pub cache_layout: DoctorCheck,
    pub writable_apexlogs: DoctorCheck,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_auth: Option<DoctorCheck>,
}

pub fn run_doctor(target_org: Option<&str>, runtime_version: &str) -> DoctorResult {
    let workspace_root = env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("(unavailable: {error})"));
    let apexlogs_root = log_store::resolve_apexlogs_root(Some(&workspace_root));
    let sf = check_sf();
    let cache_layout = check_cache_layout(Some(&workspace_root));
    let writable_apexlogs = check_writable_apexlogs(Some(&workspace_root));
    let org_auth = target_org
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(check_org_auth);
    let ok = sf.ok
        && cache_layout.ok
        && writable_apexlogs.ok
        && org_auth.as_ref().is_none_or(|check| check.ok);

    DoctorResult {
        status: if ok { "ok" } else { "warning" }.to_string(),
        runtime_version: runtime_version.to_string(),
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        workspace_root,
        apexlogs_root: apexlogs_root.display().to_string(),
        sf,
        cache_layout,
        writable_apexlogs,
        org_auth,
    }
}

fn check_sf() -> DoctorCheck {
    match Command::new("sf").arg("--version").output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            DoctorCheck {
                ok: true,
                message: if stdout.is_empty() {
                    "sf is available".to_string()
                } else {
                    stdout
                },
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            DoctorCheck {
                ok: false,
                message: if stderr.is_empty() {
                    format!("sf exited with status {}", output.status)
                } else {
                    stderr
                },
            }
        }
        Err(error) => DoctorCheck {
            ok: false,
            message: format!("sf was not found or failed to start: {error}"),
        },
    }
}

fn check_cache_layout(workspace_root: Option<&str>) -> DoctorCheck {
    let version_path = log_store::version_file_path(workspace_root);
    match log_store::read_version_file(workspace_root) {
        Ok(version) => DoctorCheck {
            ok: version == log_store::LOG_STORE_LAYOUT_VERSION,
            message: format!(
                "layout version {version}; expected {}; version file {}",
                log_store::LOG_STORE_LAYOUT_VERSION,
                version_path.display()
            ),
        },
        Err(error) => DoctorCheck {
            ok: false,
            message: error,
        },
    }
}

fn check_writable_apexlogs(workspace_root: Option<&str>) -> DoctorCheck {
    let root = log_store::resolve_apexlogs_root(workspace_root).join(".alv");
    match fs::create_dir_all(&root) {
        Ok(()) => DoctorCheck {
            ok: true,
            message: format!("{} is writable", root.display()),
        },
        Err(error) => DoctorCheck {
            ok: false,
            message: format!("{} is not writable: {error}", root.display()),
        },
    }
}

fn check_org_auth(target_org: &str) -> DoctorCheck {
    match auth::resolve_org_auth(Some(target_org)) {
        Ok(auth) => DoctorCheck {
            ok: true,
            message: format!(
                "auth resolved for {} at {}",
                auth.username.unwrap_or_else(|| target_org.to_string()),
                auth.instance_url
            ),
        },
        Err(error) => DoctorCheck {
            ok: false,
            message: error,
        },
    }
}
