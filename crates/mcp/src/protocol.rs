use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct Request {
  pub jsonrpc: Option<String>,
  pub id: Option<Value>,
  pub method: String,
  pub params: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct RpcError {
  pub code: i64,
  pub message: String,
}

#[derive(Debug, Serialize)]
pub struct Response {
  pub jsonrpc: &'static str,
  pub id: Value,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub result: Option<Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<RpcError>,
}

impl Response {
  pub fn ok(id: Value, result: Value) -> Self {
    Self {
      jsonrpc: "2.0",
      id,
      result: Some(result),
      error: None,
    }
  }

  pub fn error(id: Value, code: i64, message: impl Into<String>) -> Self {
    Self {
      jsonrpc: "2.0",
      id,
      result: None,
      error: Some(RpcError {
        code,
        message: message.into(),
      }),
    }
  }
}
