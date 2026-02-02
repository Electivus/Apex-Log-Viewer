use std::io::{self, BufRead, Write};

use apex_log_viewer_mcp::handlers::CliLogsSync;
use apex_log_viewer_mcp::stdio::handle_line;

fn main() {
  let stdin = io::stdin();
  let mut stdout = io::stdout();
  let provider = CliLogsSync;

  for line in stdin.lock().lines() {
    let line = match line {
      Ok(line) => line,
      Err(_) => continue,
    };

    if let Some(response) = handle_line(&line, &provider) {
      let _ = writeln!(stdout, "{response}");
      let _ = stdout.flush();
    }
  }
}
