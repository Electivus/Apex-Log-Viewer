use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "apex-log-viewer",
    version,
    about = "Local-first Apex log sync and analysis CLI"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    #[command(name = "app-server")]
    AppServer(AppServerArgs),
    Logs(LogsArgs),
}

#[derive(Debug, Args)]
pub struct AppServerArgs {
    #[arg(long)]
    pub stdio: bool,
}

#[derive(Debug, Args)]
pub struct LogsArgs {
    #[command(subcommand)]
    pub command: LogsCommand,
}

#[derive(Debug, Subcommand)]
pub enum LogsCommand {
    Sync(LogSyncArgs),
    Status(LogStatusArgs),
    Search(LogSearchArgs),
}

#[derive(Debug, Args)]
pub struct LogSyncArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub json: bool,
    #[arg(long)]
    pub force_full: bool,
    #[arg(long)]
    pub concurrency: Option<usize>,
}

#[derive(Debug, Args)]
pub struct LogStatusArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct LogSearchArgs {
    pub query: String,
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub json: bool,
}
