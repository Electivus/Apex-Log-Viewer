use crate::cli::{AppServerArgs, Cli, Command};

pub mod debug_levels;
pub mod doctor;
pub mod logs;
pub mod orgs;
pub mod skills;
pub mod tooling;
pub mod trace_flags;
pub mod users;

#[derive(Debug, Clone, Copy)]
pub struct OutputMode {
    pub json: bool,
}

pub fn run(cli: Cli) -> Result<i32, String> {
    let output = OutputMode { json: cli.json };
    match cli.command {
        None => Ok(0),
        Some(Command::AppServer(args)) => run_app_server(args),
        Some(Command::Doctor(args)) => doctor::run(args, output),
        Some(Command::Orgs(args)) => orgs::run(args, output),
        Some(Command::Logs(args)) => logs::run(args, output),
        Some(Command::Users(args)) => users::run(args, output),
        Some(Command::TraceFlags(args)) => trace_flags::run(args, output),
        Some(Command::DebugLevels(args)) => debug_levels::run(args, output),
        Some(Command::Tooling(args)) => tooling::run(args, output),
        Some(Command::Skills(args)) => skills::run(args, output),
    }
}

pub fn print_json<T: serde::Serialize>(value: &T) -> Result<(), String> {
    let output = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    println!("{output}");
    Ok(())
}

fn run_app_server(args: AppServerArgs) -> Result<i32, String> {
    if !args.stdio {
        return Err("app-server requires --stdio".to_string());
    }

    std::env::set_var(
        alv_app_server::server::CLI_VERSION_ENV,
        env!("CARGO_PKG_VERSION"),
    );
    alv_app_server::server::run_stdio()?;
    Ok(0)
}
