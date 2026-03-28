use alv_app_server::server::handle_initialize;
use alv_app_server::transport_stdio::{
    bounded_transport_channel, TRANSPORT_QUEUE_CAPACITY,
};
use alv_protocol::messages::InitializeParams;

#[test]
fn app_server_smoke_reports_initialize_handshake() {
    let result = handle_initialize(InitializeParams {
        client_name: "apex-log-viewer-vscode".to_string(),
        client_version: "0.1.0".to_string(),
    });

    assert_eq!(result.runtime_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(result.protocol_version, "1");
    assert_eq!(result.platform, std::env::consts::OS);
    assert_eq!(result.arch, std::env::consts::ARCH);
    assert!(result.capabilities.orgs);
    assert!(result.capabilities.logs);
    assert!(result.capabilities.search);
    assert!(result.capabilities.tail);
    assert!(result.capabilities.debug_flags);
    assert!(result.capabilities.doctor);
    assert_eq!(result.state_dir, ".alv/state");
    assert_eq!(result.cache_dir, ".alv/cache");
}

#[test]
fn app_server_smoke_uses_bounded_transport_channel() {
    let (sender, mut receiver) = bounded_transport_channel::<usize>();

    for value in 0..TRANSPORT_QUEUE_CAPACITY {
        sender
            .try_send(value)
            .expect("queue should accept values up to configured capacity");
    }

    assert!(
        sender.try_send(TRANSPORT_QUEUE_CAPACITY).is_err(),
        "queue should reject writes past capacity"
    );
    assert_eq!(
        receiver.try_recv().expect("receiver should have first item"),
        0
    );
}
