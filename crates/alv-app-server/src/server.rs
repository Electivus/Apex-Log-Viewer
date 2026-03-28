use alv_protocol::messages::{InitializeParams, InitializeResult, RuntimeCapabilities};

pub fn handle_initialize(_params: InitializeParams) -> InitializeResult {
    InitializeResult {
        runtime_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: "1".to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        capabilities: RuntimeCapabilities {
            orgs: true,
            logs: true,
            search: true,
            tail: true,
            debug_flags: true,
            doctor: true,
        },
        state_dir: ".alv/state".to_string(),
        cache_dir: ".alv/cache".to_string(),
    }
}
