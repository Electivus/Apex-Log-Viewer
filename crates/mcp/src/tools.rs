use serde_json::json;

pub const APEX_LOGS_SYNC_TOOL: &str = "apex_logs_sync";

pub fn list_tools() -> serde_json::Value {
  json!({
    "tools": [
      {
        "name": APEX_LOGS_SYNC_TOOL,
        "title": "Sync Apex Logs",
        "description": "Sync Apex logs to the local apexlogs directory.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Max logs to fetch (1-200).",
              "minimum": 1,
              "maximum": 200
            },
            "target": {
              "type": "string",
              "description": "Org username or alias."
            }
          }
        }
      }
    ],
    "nextCursor": null
  })
}
