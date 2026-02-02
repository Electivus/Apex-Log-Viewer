use serde_json::Value;

use crate::handlers::{handle_request, LogsSyncProvider};
use crate::protocol::Response;

pub fn handle_line(line: &str, provider: &impl LogsSyncProvider) -> Option<String> {
  let trimmed = line.trim();
  if trimmed.is_empty() {
    return None;
  }

  match serde_json::from_str(trimmed) {
    Ok(request) => handle_request(request, provider)
      .and_then(|response| serde_json::to_string(&response).ok()),
    Err(err) => {
      let response = Response::error(Value::Null, -32700, format!("Parse error: {err}"));
      serde_json::to_string(&response).ok()
    }
  }
}
