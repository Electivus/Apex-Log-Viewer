mod cli;
mod commands;

use clap::CommandFactory;
use clap::Parser;

fn main() {
    if std::env::args_os().nth(1).is_none() {
        let mut command = cli::Cli::command();
        command
            .print_long_help()
            .expect("help output should be writable");
        println!();
        return;
    }

    let cli = cli::Cli::parse();
    let json = cli.json;

    match commands::run(cli) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            if json {
                eprintln!("{}", format_json_error(&error));
            } else {
                eprintln!("{error}");
            }
            std::process::exit(1);
        }
    }
}

fn format_json_error(error: &str) -> String {
    let payload = match serde_json::from_str::<serde_json::Value>(error) {
        Ok(serde_json::Value::Object(mut map))
            if map.get("status").and_then(serde_json::Value::as_str) == Some("error") =>
        {
            map.entry("code".to_string())
                .or_insert_with(|| serde_json::Value::String("command_failed".to_string()));
            serde_json::Value::Object(map)
        }
        _ => serde_json::json!({
            "status": "error",
            "code": "command_failed",
            "message": error,
        }),
    };

    serde_json::to_string_pretty(&payload)
        .unwrap_or_else(|_| "{\"status\":\"error\",\"code\":\"command_failed\"}".to_string())
}
