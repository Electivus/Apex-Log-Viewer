use std::env;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.len() == 2 && args[0] == "app-server" && args[1] == "--stdio" {
        alv_app_server::server::run_stdio().expect("app-server failed");
        return;
    }

    println!("apex-log-viewer");
}
