use crate::cli::{AppServerArgs, Cli, Command};

pub mod logs;

pub fn run(cli: Cli) -> Result<i32, String> {
    match cli.command {
        None => Ok(0),
        Some(Command::AppServer(args)) => run_app_server(args),
        Some(Command::Logs(args)) => logs::run(args),
    }
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
