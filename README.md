![Apex Log Viewer banner](media/banner.png)

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

![Overview](media/docs/hero.gif)

![Apex Tail Logs](media/docs/apex-tail-log.gif)

## Requirements

- Salesforce CLI: Install either `sf` (recommended) or legacy `sfdx` and authenticate to an org.
  - Login example: `sf org login web` (or `sfdx force:auth:web:login`).
- VS Code 1.87+.
- Optional for Replay: “Salesforce Apex Replay Debugger” (part of Salesforce Extensions for VS Code).

## Install

- From VS Code: open Extensions (Ctrl/Cmd+Shift+X), search for “Apex Log Viewer”, and click Install.
- From the Marketplace: click “Install from Marketplace” above.
- From the CLI: `code --install-extension electivus.apex-log-viewer`

## Usage

- Open the Apex Logs panel: View > Appearance > Panel, then switch to the “Apex” container and the “Apex Logs” view.
- Refresh logs: Click “Refresh” in the toolbar or run the `Apex Logs: Refresh Logs` command.
- Select org: Use the toolbar dropdown or run `Apex Logs: Select Org`. Choose an authenticated org or “Default Org”.
- Search: Type in the search box to filter visible rows; combine with filters.
- Filters: Filter by User, Operation, Status, and Code Unit; clear quickly with “Clear filters”.
- Sorting: Click a header to sort (toggle asc/desc).
- Infinite scroll: Scroll to the bottom to load the next page.
- Open or Replay: Double‑click a row to open the log; click the action button to launch Apex Replay Debugger.

## Commands

- Apex Logs: Refresh Logs (`sfLogs.refresh`)
- Apex Logs: Select Org (`sfLogs.selectOrg`)
- Apex Logs: Tail Logs (`sfLogs.tail`)
- Apex Logs: Show Extension Output (`sfLogs.showOutput`)

## Settings

- `sfLogs.pageSize`: Number of logs fetched per page (10–200; default 100).
- `sfLogs.headConcurrency`: Max concurrent requests to fetch log headers (1–20; default 5).

API version is automatically taken from your workspace `sfdx-project.json` (`sourceApiVersion`).

 

## Localization

The extension uses localized strings for the extension UI and the in‑panel interface. English (en) and Brazilian Portuguese (pt-BR) are included.

## Troubleshooting

- “CLI not found”: Ensure `sf` (or `sfdx`) is installed and available on PATH. On macOS/Linux, ensure your login shell PATH includes the CLI (e.g., launch VS Code from the shell or configure the shell integration).
- “Failed to launch Apex Replay Debugger”: Install the Salesforce Apex Replay Debugger extension.
- “No orgs detected”: Ensure you’re authenticated (`sf org login web`) and try `sf org list`.

## Contributing

- Dev setup: clone, `npm install`, `npm run build`, press `F5` to launch the Extension Development Host.
- Build & test: `npm run build` and `npm test` (runs type‑check and lint via pretest).
- Lint & format: `npm run lint` and `npm run format`.
- Please use Conventional Commits for PR titles and commit messages so that releases and the changelog are generated automatically by Release Please.

### Conventional Commits

We follow https://www.conventionalcommits.org/en/v1.0.0/.

- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`.
- Scope (optional): e.g., `feat(logs): add status filter`.
- Breaking changes: use `!` after the type/scope (`feat!: ...`) or add a `BREAKING CHANGE:` footer.

Examples:

```
feat(logs): add filter by status and code unit

fix(tail): handle CLI not found with actionable message

docs: update README with Marketplace badges and usage
```

### Releasing

Releases are automated via Google’s Release Please GitHub Action and Conventional Commits:

- Merge PRs to `main` using Conventional Commits. Do not edit `CHANGELOG.md` manually.
- Release Please opens/updates a release PR with the next version and changelog.
- When the release PR is merged, a tag and GitHub Release are created automatically.
- Our CI builds, packages, and (when `VSCE_PAT` is configured) publishes the extension to the Marketplace.

For manual packaging (if needed):

- Stable: `npm run vsce:package` then `npm run vsce:publish`.
- Pre‑release: `npm run vsce:package:pre` then `npm run vsce:publish:pre`.

## Privacy & Security

- No tokens are logged by default. When `sfLogs.trace` is enabled, verbose output is sent to the “Apex Log Viewer” output channel; review logs before sharing.
- The extension shells out to `sf`/`sfdx` for org access and reads logs locally; it does not transmit your code or logs to third‑party services.

## License

MIT © Electivus
