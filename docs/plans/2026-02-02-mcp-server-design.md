# MCP Server Design

**Goal:** Provide an MCP server that exposes `apex-log-viewer logs sync` as a tool, similar to the Codex extension pattern, using a dedicated Rust binary.

## Context
We have a Rust CLI in `crates/cli` that already returns structured JSON for `logs sync`. The VS Code extension currently shells out to Salesforce CLI directly. We want an MCP server that can be launched over stdio and call the CLI logic without invoking an external process.

## Decisions
1. **New crate:** Add `crates/mcp` producing the `apex-log-viewer-mcp` binary.
2. **Shared CLI logic:** Refactor `crates/cli` to expose a pure `logs_sync` function that returns `Result<SyncOutput, ErrorOutput>`.
3. **Tools surface:** Expose a single tool `apex_logs_sync` with inputs `{ limit?: number, target?: string }`.
4. **Transport:** Implement MCP over stdio with JSON-RPC 2.0 messages.

## Architecture & Data Flow
- The extension (or any MCP client) spawns `apex-log-viewer-mcp` and exchanges JSON-RPC over stdio.
- `tools/list` advertises `apex_logs_sync` with its input schema.
- `tools/call` parses arguments, calls the shared CLI function, and returns the same JSON shape as the CLI.
- The CLI binary remains a thin wrapper that calls the shared function, prints JSON, and exits with the correct status.

## Protocol & Schema
- **Methods supported:** `initialize`, `tools/list`, `tools/call`.
- **Tool name:** `apex_logs_sync`.
- **Input schema:**
  - `limit` (number, optional, default 100)
  - `target` (string, optional; username or alias)
- **Output:** `SyncOutput` JSON on success; `ErrorOutput` JSON on failure.

## Error Handling
- CLI domain errors are represented as `ErrorOutput` and returned inside successful JSON-RPC responses.
- Protocol errors (invalid JSON, unknown method) use JSON-RPC error responses and do not terminate the server.

## Testing Strategy
- Unit tests in `crates/mcp` for JSON-RPC parsing and tool registry.
- Handler tests using a fake CLI implementation to avoid Salesforce dependencies.
- One CLI test to ensure the shared function output matches the CLI JSON format.

## Non-Goals
- Replacing the existing Salesforce CLI integration in the extension.
- Adding new CLI commands beyond `logs sync`.
- Shipping a Node-based MCP server.
