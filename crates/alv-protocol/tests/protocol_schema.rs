use alv_protocol::codegen::generated_typescript;
use alv_protocol::messages::{InitializeParams, InitializeResult, RuntimeCapabilities};
use serde_json::json;

#[test]
fn protocol_schema_serializes_initialize_contract() {
    let params = InitializeParams {
        client_name: "apex-log-viewer-vscode".to_string(),
        client_version: "0.1.0".to_string(),
    };

    let result = InitializeResult {
        runtime_version: "0.1.0".to_string(),
        protocol_version: "1".to_string(),
        platform: "linux".to_string(),
        arch: "x86_64".to_string(),
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
    };

    assert_eq!(
        serde_json::to_value(params).expect("params should serialize"),
        json!({
            "client_name": "apex-log-viewer-vscode",
            "client_version": "0.1.0"
        })
    );
    assert_eq!(
        serde_json::to_value(result).expect("result should serialize"),
        json!({
            "runtime_version": "0.1.0",
            "protocol_version": "1",
            "platform": "linux",
            "arch": "x86_64",
            "capabilities": {
                "orgs": true,
                "logs": true,
                "search": true,
                "tail": true,
                "debug_flags": true,
                "doctor": true
            },
            "state_dir": ".alv/state",
            "cache_dir": ".alv/cache"
        })
    );
}

#[test]
fn protocol_schema_prints_generated_typescript_surface() {
    let generated = generated_typescript();

    assert!(generated.contains("export type InitializeParams"));
    assert!(generated.contains("export type InitializeResult"));
    assert!(generated.contains("debug_flags: boolean;"));

    println!("{generated}");
}
