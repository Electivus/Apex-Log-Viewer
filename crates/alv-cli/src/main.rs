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

    match commands::run(cli) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
