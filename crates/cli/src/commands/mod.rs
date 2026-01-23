use clap::{Parser, Subcommand};

pub mod logs_sync;

#[derive(Parser)]
#[command(name = "apex-log-viewer", version, about = "Apex Log Viewer CLI")]
pub struct Cli {
  #[command(subcommand)]
  pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
  #[command(subcommand)]
  Logs(LogsCommand),
}

#[derive(Subcommand)]
pub enum LogsCommand {
  Sync(logs_sync::LogsSyncArgs),
}

pub fn run(cli: Cli) -> Result<(), String> {
  match cli.command {
    Commands::Logs(LogsCommand::Sync(args)) => logs_sync::run(args),
  }
}
