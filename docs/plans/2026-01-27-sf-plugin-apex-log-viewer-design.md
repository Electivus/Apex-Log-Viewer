# SF Plugin Migration — Apex Log Viewer

## Goal
Migrate the CLI functionality into a Salesforce `sf` plugin (TypeScript) using Salesforce CLI best practices and documentation. Avoid changes to the VS Code extension.

## Summary of Decisions
- **Plugin location:** `apps/sf-plugin-apex-log-viewer/`.
- **npm package name:** `@electivus/sf-plugin-apex-log-viewer`.
- **Command surface:** `sf apex-log-viewer logs sync`.
- **Org flag:** `--target-org` (`-o`), optional (uses default org).
- **Output dir:** `--output-dir` (`-d`), default `./apexlogs`.
- **Limit:** default 100, clamp 1–200.
- **Filename format:** `YYYYMMDDTHHmmssZ_<username>_<logId>.log` (UTC timestamp from `StartTime`).
- **Output format:** human-readable table by default; `--json` with new schema.
- **JSON schema:** `{ status: 0, result: { org, apiVersion, limit, outputDir, logsSaved, logsSkipped, errors } }`.
- **Concurrency:** parallel downloads with max 5 in-flight requests.
- **Partial errors:** continue execution; return status 0 and report errors/skipped items.

## References (Salesforce CLI Plugin Guide)
- Overview: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/conceptual-overview.html
- Get started: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/get-started.html
- Design guidelines: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/design-guidelines.html
- Commands & topics: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/topics.html
- Flags & arguments: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/flags.html
- Command properties: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/command-properties.html
- Command flags: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/command-flags.html
- Messages: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/messages.html
- Common coding patterns: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/common-coding-patterns.html
- Logging: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/logging.html
- Use libraries: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/use-libraries.html
- Testing: https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/test-plugin.html

## Architecture
- **Framework:** oclif-based `SfCommand` via `@salesforce/sf-plugins-core`.
- **Project awareness:** `requiresProject = true` and `SfProject` / `sfdx-project.json` parsing for `sourceApiVersion`.
- **Auth/Org:** `optionalOrgFlag` and `@salesforce/core` (`AuthInfo`, `Org`, `Connection`).
- **Messages:** Markdown messages via `Messages` with `error.*` keys.
- **Logging:** `Logger.child(...)`; respect `SF_LOG_LEVEL` and `SFDX_DISABLE_LOG_FILE`.

## Command Behavior
### Flags
- `--target-org`, `-o`: optional org username/alias (default org).
- `--output-dir`, `-d`: directory for logs; default `./apexlogs`.
- `--limit`, `-l`: integer, clamp 1–200.
- `--json`: standard `SfCommand` JSON output.

### Human Output (default)
- Table columns: `StartTime`, `User`, `LogId`, `Size`, `File`.
- Summary counts for saved, skipped, and errors.

### JSON Output
```
{
  "status": 0,
  "result": {
    "org": { "username": "...", "instanceUrl": "..." },
    "apiVersion": "...",
    "limit": 100,
    "outputDir": "apexlogs",
    "logsSaved": [ ... ],
    "logsSkipped": [ ... ],
    "errors": [ ... ]
  }
}
```

### File Naming
- `StartTime` parsed and converted to UTC format `YYYYMMDDTHHmmssZ`.
- Full name: `YYYYMMDDTHHmmssZ_<username>_<logId>.log`.
- If `StartTime` missing, record error for that log.

## Data Flow
1. Validate Salesforce project and read `sourceApiVersion`.
2. Resolve org (default or `--target-org`).
3. Query ApexLog list (limit applied).
4. Ensure `output-dir` exists.
5. Download log bodies in parallel (max 5 concurrent).
6. Write files, aggregate `logsSaved`, `logsSkipped`, and `errors`.
7. Render table or JSON.

## Error Handling
- Use `Messages.createError` for project/auth/API failures.
- Continue on per-log failures; capture in `errors`/`logsSkipped`.
- Exit code remains 0 on partial failure (as requested).

## Testing Plan
- **Unit tests:** timestamp formatting, filename generation, limit clamp, JSON normalization.
- **Command unit tests:** `stubSfCommandUx` asserts table and JSON output.
- **NUTs (optional later):** `@salesforce/cli-plugins-testkit` with real org.

## Rollout
- Publish `@electivus/sf-plugin-apex-log-viewer`.
- Document usage in plugin README and root README.

## Risks & Mitigations
- **Large log bodies:** limit concurrency (5) and write to disk incrementally.
- **API limits:** clamp limit and handle empty results gracefully.
- **Timezone confusion:** normalize `StartTime` to UTC in filenames.
