use apex_log_viewer_cli::commands::{run, Cli};
use clap::Parser;

fn main() {
  let cli = Cli::parse();
  if let Err(message) = run(cli) {
    eprintln!("{message}");
    std::process::exit(1);
  }
}
