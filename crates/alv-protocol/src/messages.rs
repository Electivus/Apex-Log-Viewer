use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InitializeParams {
    pub client_name: String,
    pub client_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeCapabilities {
    pub orgs: bool,
    pub logs: bool,
    pub search: bool,
    pub tail: bool,
    pub debug_flags: bool,
    pub doctor: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InitializeResult {
    pub runtime_version: String,
    pub protocol_version: String,
    pub channel: String,
    pub platform: String,
    pub arch: String,
    pub capabilities: RuntimeCapabilities,
    pub state_dir: String,
    pub cache_dir: String,
}
