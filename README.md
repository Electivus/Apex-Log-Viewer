![Apex Log Viewer banner](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/apps/vscode-extension/media/banner.png)

# Electivus Apex Log Viewer

Search downloaded Salesforce Apex logs inside VS Code, jump straight to the right failure, and keep triage, log inspection, tailing, replay, and debug flags in one workflow.

[Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=electivus.apex-log-viewer) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/Electivus/Apex-Log-Viewer/issues)

![CI](https://github.com/Electivus/Apex-Log-Viewer/actions/workflows/ci.yml/badge.svg?branch=main)
![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/electivus.apex-log-viewer?label=Marketplace)
![Installs](https://img.shields.io/visual-studio-marketplace/i/electivus.apex-log-viewer)
![Downloads](https://img.shields.io/visual-studio-marketplace/d/electivus.apex-log-viewer)
![Rating](https://img.shields.io/visual-studio-marketplace/r/electivus.apex-log-viewer)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

## What It Does Best

- Search across downloaded Apex log bodies with match snippets, so you can find the right log by business terms, IDs, or exception context instead of guessing by timestamp.
- Highlight logs that deserve attention with error and triage badges directly in the list.
- Open a dedicated **Apex Log Viewer** with parsed entries, focused filters, and a diagnostics sidebar.
- Tail live logs, open the selected log, or hand it off to Apex Replay Debugger without leaving VS Code.
- Manage `USER_DEBUG` TraceFlags in a dedicated **Apex Debug Flags** screen with more room than the standard panel view.
- Switch orgs quickly and keep the workflow centered on the org you are actively investigating.

## Screenshots

![Search, snippets, triage, and local log search](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/apps/vscode-extension/media/docs/hero.png)

Search in the logs panel is optimized for locally saved log bodies, so the most effective flow is:

1. Refresh logs.
2. Search by the phrase, record ID, correlation ID, or exception detail you already know.
3. Scroll for more rows when you want to keep exploring the current result set.
4. Use **Download all logs** when the refreshed and scrolled set still did not surface what you need, or when you want to pull the whole org backlog into the workspace in one shot.
5. Open the best candidate in the dedicated viewer.

![Dedicated Apex Log Viewer with diagnostics](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/apps/vscode-extension/media/docs/log-viewer.png)

![Apex Debug Flags editor](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/apps/vscode-extension/media/docs/debug-flags.png)

![Real-time Apex log tail](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/apps/vscode-extension/media/docs/tail.png)

## Requirements

- Salesforce CLI installed and authenticated. `sf` is recommended, but legacy `sfdx` also works.
- VS Code 1.90+.
- Recommended for Replay Debugger: Salesforce Extension Pack (`salesforce.salesforcedx-vscode`).

Login example:

```bash
sf org login web
```

## Install

- From VS Code: open Extensions (`Ctrl/Cmd+Shift+X`), search for `Electivus Apex Log Viewer`, then install.
- From the Marketplace: use the install link above.
- From the CLI: `code --install-extension electivus.apex-log-viewer`

## Rust CLI

The standalone Rust CLI now exposes a local-first `logs` surface for humans and coding agents:

```bash
apex-log-viewer logs sync --target-org my-org --concurrency 6
apex-log-viewer logs status --target-org my-org
apex-log-viewer logs search "NullPointerException" --target-org my-org
```

`logs sync` reuses `sf org display` for auth, then lists `ApexLog` rows and downloads raw log bodies over the Salesforce Tooling REST API. It materializes those bodies under `apexlogs/`, keeps incremental state in `apexlogs/.alv/`, and writes the canonical org-first layout at `apexlogs/orgs/<safe-target-org>/logs/YYYY-MM-DD/<logId>.log`, where `<safe-target-org>` is the sanitized directory name derived from the resolved org username. Use `--concurrency` when you want to tune how many log bodies are downloaded in parallel; the default is `6` and `1` keeps the old serial-style troubleshooting mode. The VS Code extension and the CLI remain separate surfaces over the same shared runtime architecture, so the runtime still tolerates the legacy flat cache layout during the transition.

## Usage

The extension activates automatically when the workspace contains `sfdx-project.json`. You can also activate it on demand by opening an Apex log or running one of the commands below.

### Open the Logs Panel

1. Open the VS Code panel area.
2. Switch to **Electivus Apex Logs**.
3. Run `Electivus Apex Logs: Refresh Logs` if the panel is not already populated.

### Search Downloaded Logs

- Run **Refresh Logs** to populate the list and download the bodies used by local search.
- Use the search box to search visible metadata plus those saved log bodies.
- Match snippets appear in the `Match` column when the hit comes from the saved log file.
- Scroll to load more rows from the current list when you want to keep widening the search incrementally.
- Use **Download all logs** when the refreshed and scrolled set still is not enough, or when you want to pull all logs from the selected org into local search in one action.
- Combine search with filters by user, operation, status, code unit, and **Errors only**.

### Review Triage Faster

- Error badges and triage reasons surface logs that deserve attention before you open them.
- The `Errors only` switch is useful when you want to reduce noise to the failing paths.
- Sorting and infinite scroll still apply, so you can keep narrowing the list without leaving the panel.

### Open the Dedicated Viewer

- Press `Enter` on a selected row or open the log from the list.
- The dedicated **Apex Log Viewer** parses the log into debug, SOQL, DML, and error-oriented views.
- Use the built-in search box to jump between matching entries.
- Use the diagnostics sidebar to land on mapped failures and warnings faster.

### Tail Logs

- Run `Electivus Apex Logs: Tail Logs` to open the tail view.
- Start or stop streaming from the toolbar.
- Search live output, keep auto-scroll on, and open or replay the selected log from the same screen.

### Configure Debug Flags

- Open **Debug Flags** from either the Logs toolbar or the Tail toolbar.
- Search active users by name or username.
- Review current `USER_DEBUG` status, level, and expiration.
- Apply or remove trace flags with a custom TTL.
- Use the **Debug Level Manager** to create or tune a DebugLevel without leaving the extension.

### Replay Debugger

- Open a log from the list and launch Apex Replay Debugger from the row action when you need step-by-step inspection.
- The extension is designed to make it easier to find the right log before you replay it.

### Select an Org

- Use the org picker in Logs, Tail, or Debug Flags to switch between authenticated orgs.
- The extension can also use your CLI default org.

## Commands

- `Electivus Apex Logs: Refresh Logs` (`sfLogs.refresh`)
- `Electivus Apex Logs: Select Org` (`sfLogs.selectOrg`)
- `Electivus Apex Logs: Tail Logs` (`sfLogs.tail`)
- `Electivus Apex Logs: Show Extension Output` (`sfLogs.showOutput`)

## Settings

- `electivus.apexLogs.pageSize`: logs fetched per page.
- `electivus.apexLogs.headConcurrency`: concurrent head requests.
- `electivus.apexLogs.saveDirName`: directory used to persist downloaded logs. Default: `apexlogs`.
- `electivus.apexLogs.logsColumns`: reorder, hide, or resize list columns.
- `electivus.apexLogs.tailBufferSize`: max in-memory tail lines.
- `electivus.apexLogs.trace`: verbose extension logging to the output channel.

Legacy `sfLogs.*` keys still work for backward compatibility.

See [docs/SETTINGS.md](docs/SETTINGS.md) for the full configuration reference.

## Troubleshooting

- **Search is not finding the text I know is in the log**
  Run **Refresh Logs** first, then scroll to load more rows if needed. If the log still is not in the current local set, use **Download all logs** to bring the rest of the org backlog into the workspace search cache.
- **Salesforce CLI not found**
  Ensure `sf` or `sfdx` is installed and available on `PATH`.
- **No orgs detected**
  Authenticate with `sf org login web` and verify with `sf org list`.
- **Replay Debugger does not launch**
  Install the Salesforce Extension Pack or the standalone Apex Replay Debugger extension.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and release flow details.

Useful local commands:

- `npm run build`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run docs:screenshots`

Additional docs:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/TESTING.md](docs/TESTING.md)
- [docs/PUBLISHING.md](docs/PUBLISHING.md)
- [docs/TELEMETRY.md](docs/TELEMETRY.md)

## Privacy & Security

- Source code and Apex log content are not sent in telemetry.
- Tokens are not logged by default.
- When `electivus.apexLogs.trace` is enabled, review extension output before sharing it externally.
- The extension reuses your existing Salesforce CLI authentication and reads downloaded logs locally.

## Telemetry

The extension may emit minimal, anonymized usage and error telemetry to improve reliability and performance. Telemetry respects VS Code's `telemetry.telemetryLevel` setting and is disabled automatically in Development and Test modes.

## License

MIT © Electivus
