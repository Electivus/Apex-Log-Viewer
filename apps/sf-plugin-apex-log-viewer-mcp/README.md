# Apex Log Viewer MCP Server

Exposes `sf apex-log-viewer logs sync` as an MCP stdio tool.

## Prerequisites
- `sf` on PATH
- `@electivus/sf-plugin-apex-log-viewer` installed or linked

## Run

```bash
npm --prefix apps/sf-plugin-apex-log-viewer-mcp run build
node apps/sf-plugin-apex-log-viewer-mcp/dist/cli.js --project-dir /path/to/sf-project
apex-log-viewer-mcp --project-dir /path/to/sf-project --sf-bin /path/to/sf
```

## Tool

`apexLogsSync` inputs:
- `targetOrg` (string, optional)
- `outputDir` (string, optional, default `./apexlogs`)
- `limit` (number, optional, clamped 1-200)

Returns: JSON output from `sf apex-log-viewer logs sync --json`.

## LLM / Agent Usage

### Tool name
- `apexLogsSync`

### When to use
- Sync Apex logs for local inspection or troubleshooting.

### Inputs
- `targetOrg` (string, optional): username or alias.
- `outputDir` (string, optional): directory to write logs. Defaults to `./apexlogs` relative to server cwd.
- `limit` (number, optional): max logs to sync. Clamped 1–200.

### Behavior
- Creates the output directory if missing.
- Executes `sf apex-log-viewer logs sync --json`.
- Returns the parsed JSON in `structuredContent` and stringified JSON in `content`.

### Example

```json
{"tool":"apexLogsSync","args":{"targetOrg":"my-org","outputDir":"/tmp/apexlogs","limit":50}}
```
