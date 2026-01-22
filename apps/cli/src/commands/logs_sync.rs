use clap::Parser;

#[derive(Parser)]
pub struct LogsSyncArgs {
  #[arg(long, default_value_t = 100)]
  pub limit: u32,
  #[arg(long, short = 'o')]
  pub target: Option<String>,
}

pub fn run(_args: LogsSyncArgs) -> Result<(), String> {
  Ok(())
}
