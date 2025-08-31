![Apex Log Viewer banner](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/media/banner.png)

# Apex Log Viewer

Fast, searchable Salesforce Apex logs — right inside VS Code. Browse, filter, open, tail, and debug logs from your default or selected org with a streamlined VS Code panel and Apex Replay integration.

[Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=electivus.apex-log-viewer) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/Electivus/Apex-Log-Viewer/issues)

![CI](https://github.com/Electivus/Apex-Log-Viewer/actions/workflows/ci.yml/badge.svg?branch=main)
![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/electivus.apex-log-viewer?label=Marketplace)
![Installs](https://img.shields.io/visual-studio-marketplace/i/electivus.apex-log-viewer)
![Downloads](https://img.shields.io/visual-studio-marketplace/d/electivus.apex-log-viewer)
![Rating](https://img.shields.io/visual-studio-marketplace/r/electivus.apex-log-viewer)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- Log explorer: Paginated table of Apex logs with columns for User, App, Operation, Time, Status, Code Unit, and Size.
- Quick find and filters: Type to filter visible rows and combine with filters by User, Operation, Status, and Code Unit.
- Sorting and infinite scroll: Click any header to sort; more logs load automatically as you scroll.
- Open and debug: Open a log in the editor or start Apex Replay Debugger directly from the list.
- Real‑time tail: Start tailing logs from the toolbar using your Salesforce CLI.
- Org selector: Quickly switch between your authenticated orgs or use the CLI default.
- Configurable: Tune `sfLogs.pageSize`, `sfLogs.headConcurrency`, and other options to fit your workflow.
- Localization: English and Brazilian Portuguese (pt‑BR).

Why developers like it

- Minimal clicks to find the right log.
- Fast, responsive UI that scales to large orgs.
- Works with both `sf` and legacy `sfdx` CLIs.

## Screenshots

![Overview](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/media/docs/hero.gif)

![Apex Tail Logs](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/media/docs/apex-tail-log.gif)

## Requirements

- Salesforce CLI: Install either `sf` (recommended) or legacy `sfdx` and authenticate to an org.
  - Login example: `sf org login web` (or `sfdx force:auth:web:login`).
- VS Code 1.90+.
- Required for Replay: Salesforce Extension Pack (salesforce.salesforcedx-vscode), which includes Apex Replay Debugger.
  - A extensão não depende nem instala o pack automaticamente; se você tentar usar Replay sem o pack, abriremos a aba de Extensões apontando para o pacote para você instalar manualmente.

## Install

- From VS Code: open Extensions (Ctrl/Cmd+Shift+X), search for “Apex Log Viewer”, and click Install.
- From the Marketplace: click “Install from Marketplace” above.
- From the CLI: `code --install-extension electivus.apex-log-viewer`

## Usage

### Open the Apex Logs panel

1. In VS Code, choose `View` > `Appearance` > `Panel`.
2. Switch to the **Apex** container and select **Apex Logs** to load recent logs.

### Refresh logs

- Click **Refresh** in the toolbar or run the command `Apex Logs: Refresh Logs`.

### Search and filter

- Type in the search box to narrow visible rows.
- Use the filter buttons to limit by User, Operation, Status, or Code Unit. Combine search and filters for precise results.

### Sort and paginate

- Click any column header to toggle ascending or descending.
- Additional logs load automatically as you scroll.

### Open or debug a log

- Double-click a row to open the log in the editor.
- Use the action button on a row to launch Apex Replay Debugger.

### Tail logs in real time

- Choose **Tail Logs** from the toolbar to start streaming new logs. Run the command again to stop.

### Select an org

- Use the toolbar dropdown to switch between authenticated orgs or choose **Default Org**.

## Commands

- Apex Logs: Refresh Logs (`sfLogs.refresh`)
- Apex Logs: Select Org (`sfLogs.selectOrg`)
- Apex Logs: Tail Logs (`sfLogs.tail`)
- Apex Logs: Show Extension Output (`sfLogs.showOutput`)

## Settings

- `sfLogs.pageSize`: Number of logs fetched per page (10–200; default 100).
- `sfLogs.headConcurrency`: Max concurrent requests to fetch log headers (1–20; default 5).
- `sfLogs.saveDirName`: Folder name used when saving logs to disk (default `apexlogs`).
- `sfLogs.trace`: Enable verbose trace logging of CLI and HTTP calls.

See [docs/SETTINGS.md](docs/SETTINGS.md) for more details on configuration.

API version is automatically taken from your workspace `sfdx-project.json` (`sourceApiVersion`).

## Localization

The extension uses localized strings for the extension UI and the in‑panel interface. English (en) and Brazilian Portuguese (pt-BR) are included.

## Troubleshooting

- “CLI not found”: Ensure `sf` (or `sfdx`) is installed and available on PATH. On macOS/Linux, ensure your login shell PATH includes the CLI (e.g., launch VS Code from the shell or configure the shell integration).
- “Failed to launch Apex Replay Debugger”: Install the Salesforce Apex Replay Debugger extension.
- “No orgs detected”: Ensure you’re authenticated (`sf org login web`) and try `sf org list`.

## Architecture

For a deeper dive into how the extension pieces fit together, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

See CONTRIBUTING.md for development setup, Conventional Commits, and our tag‑based release flow. Note: `CHANGELOG.md` is maintained manually.

### Testing

See docs/TESTING.md for how to run unit and integration tests (`npm run test:unit`, `npm run test:integration`, `npm run test:all`) and for environment variables such as `VSCODE_TEST_VERSION`, `VSCODE_TEST_INSTALL_DEPS`, `VSCODE_TEST_GREP`, and `VSCODE_TEST_TOTAL_TIMEOUT_MS`. Tests open a temporary workspace with an `sfdx-project.json` generated during the run.

## Privacy & Security

- No tokens are logged by default. When `sfLogs.trace` is enabled, verbose output is sent to the “Apex Log Viewer” output channel; review logs before sharing.
- The extension shells out to `sf`/`sfdx` for org access and reads logs locally; it does not transmit your code or logs to third‑party services.

## License

MIT © Electivus
