# SF Plugin Apex Log Viewer MCP Server Design

## Goal
Expose the `sf apex-log-viewer logs sync` command via an MCP stdio server so IDEs can invoke the plugin through a single tool call and receive the CLI JSON output.

## Summary of Decisions
- **Location:** `apps/sf-plugin-apex-log-viewer-mcp/`.
- **Package name:** `@electivus/sf-plugin-apex-log-viewer-mcp`.
- **Bin:** `apex-log-viewer-mcp`.
- **Transport:** MCP stdio (`stdin`/`stdout`).
- **Tool:** Single tool `apexLogsSync` with params `targetOrg`, `outputDir`, `limit`.
- **Execution:** Call `sf apex-log-viewer logs sync --json` via PATH (`SF_BIN` optional override).
- **Output:** Parse and return JSON result from `sf`; propagate errors as MCP tool errors.
- **Validation:** Clamp `limit` to 1-200, resolve `outputDir`, ensure directory exists.

## Architecture
- **Entry point:** `src/index.ts` boots the MCP server and registers the tool.
- **Command layer:** `src/command.ts` handles param normalization, arg building, and output parsing.
- **Runner:** `src/run-sf.ts` executes the `sf` binary using `child_process.spawn` and returns `stdout`/`stderr`/`exitCode`.

## Tool Contract
Input schema:
- `targetOrg` (string, optional)
- `outputDir` (string, optional, default `./apexlogs`)
- `limit` (number, optional, default 100, clamped 1-200)

Output:
- Parsed JSON from `sf apex-log-viewer logs sync --json`.

## Error Handling
- Non-zero exit code or spawn errors -> MCP tool error with stderr.
- Invalid JSON in stdout -> MCP tool error with brief stdout snippet.
- Empty stdout -> treated as invalid JSON error.

## Build & Test
- Build via `tsc` to `dist/`.
- Tests with Node's test runner using a TS loader (`tsx`) for unit tests covering:
  - param normalization and clamping
  - CLI arg construction
  - JSON parsing and error cases
  - runner error handling (mocked spawn)

## Risks & Mitigations
- **Missing `sf` binary:** fail fast with clear error message.
- **Invalid CLI output:** detect and surface parsing errors.
- **Output dir issues:** create directories recursively before command execution.
