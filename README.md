![Apex Log Viewer banner](media/banner.png)

# Apex Log Viewer

View and work with Salesforce Apex logs directly in VS Code. The extension adds an Apex Logs panel with a fast, searchable table of recent logs from your default or selected org, and integrates with the Apex Replay Debugger.

## Features

- Webview log list: Paginated table of recent Apex logs with columns for User, Application, Operation, Time, Status, Code Unit (from log head), and Size.
- Quick search: Client-side search box to filter visible logs.
- Filters: Filter by User, Operation, Status, and Code Unit.
- Sorting: Click column headers to sort (Time/Size default descending); includes Code Unit.
- Open logs: Double-click a row to open the log in an editor.
- Apex Replay: Launch the Apex Replay Debugger for a log via the row action.
- Tail Logs: Start real-time tailing with Salesforce CLI from the panel actions.
- Org selection: Use the toolbar dropdown or the “Select Org” command to switch between authenticated orgs or use the CLI default.
- Infinite scroll: Scroll to the end to automatically fetch the next page.
- Configurable: `sfLogs.pageSize` (page size) and `sfLogs.headConcurrency` (log-head fetch parallelism).
- Localization: Extension strings and webview UI available in English and pt-BR.

## Prerequisites

- Salesforce CLI: Install either `sf` (recommended) or legacy `sfdx` and authenticate to an org.
  - Login example: `sf org login web` (or `sfdx force:auth:web:login`).
- VS Code 1.87+.
- Optional for Replay: “Salesforce Apex Replay Debugger” (part of Salesforce Extensions for VS Code).

## Installation

Option A — Development

1. Clone this repo and install dependencies: `npm install`.
2. Build the extension and webview: `npm run build`.
3. Press `F5` in VS Code to launch the Extension Development Host.

Option B — VSIX package

1. Package a `.vsix`: `npm run vsce:package`.
2. In VS Code, run “Extensions: Install from VSIX…” and select the generated file.

## Usage

- Open the Apex Logs panel: View > Appearance > Panel, then switch to the “Apex” container and the “Apex Logs” view.
- Refresh logs: Click “Refresh” in the toolbar or run the `Apex Logs: Refresh Logs` command.
- Select org: Use the toolbar dropdown or run `Apex Logs: Select Org`. Choose an authenticated org or “Default Org”.
- Search: Type in the search box to filter visible rows; combine with filters.
- Filters: Filter by User, Operation, Status, and Code Unit; clear quickly with “Clear filters”.
- Sorting: Click a header to sort (toggle asc/desc).
- Infinite scroll: Scroll to the bottom to load the next page.
- Open or Replay: Double‑click a row to open the log; click the action button to launch Apex Replay Debugger.

## Settings

- `sfLogs.pageSize`: Number of logs fetched per page (10–200; default 100).
- `sfLogs.headConcurrency`: Max concurrent requests to fetch log headers (1–20; default 5).

API version is automatically taken from your workspace `sfdx-project.json` (`sourceApiVersion`).

## Localization

The extension uses `vscode-nls` for extension strings and a lightweight runtime for webview strings. English (en) and Brazilian Portuguese (pt-BR) are included.

## Troubleshooting

- “CLI not found”: Ensure `sf` (or `sfdx`) is installed and available on PATH. On macOS/Linux, ensure your login shell PATH includes the CLI (e.g., launch VS Code from the shell or configure the shell integration).
- “Failed to launch Apex Replay Debugger”: Install the Salesforce Apex Replay Debugger extension.
- “No orgs detected”: Ensure you’re authenticated (`sf org login web`) and try `sf org list`.

## Development

- Build: `npm run build`
- Test: `npm test`

Per repository guidelines, changes should pass both build and test before committing or opening a PR.

## Continuous Integration

- Workflow: GitHub Actions at `.github/workflows/ci.yml` runs on `push` (to `main`), `pull_request`, manual `workflow_dispatch`, and tags matching `v*`.
- Build & Test: Matrix across `ubuntu-latest`, `macos-latest`, and `windows-latest` on Node 20.
  - Installs deps with `npm ci` (with Node/NPM cache enabled).
  - On Linux, installs Electron test dependencies via `scripts/install-linux-deps.sh`.
  - Runs `npm run build` then `npm test` (the test step clears `CI` env to avoid scratch‑org attempts).
- Packaging: For tags `v*`, a `package` job runs `npm run package` and creates a VSIX. The job auto-detects release channel:
  - Odd minor (e.g., 0.7.x) → pre-release → uses `vsce --pre-release`.
  - Even minor (e.g., 0.6.x) → stable.
  The uploaded artifact is named `apex-log-viewer-${{ github.ref_name }}-(pre|stable)-vsix`.
- Optional Publish: If the repository/org secret `VSCE_PAT` is set (Marketplace token), the workflow publishes to the Marketplace using the detected channel (stable or pre-release).
- Concurrency: The workflow cancels in‑progress runs for the same ref to keep results tidy.

Release flow

- Bump version in `package.json`, update `CHANGELOG.md`.
- Create and push a tag like `v0.0.4` to trigger packaging (and publish if `VSCE_PAT` is present). Use odd minor versions for pre-releases and even minor for stable.
  - Example: `git tag v0.0.4 && git push origin v0.0.4`.
- Download the built `.vsix` from the workflow artifacts when needed.

Setup `VSCE_PAT`

- Create a Personal Access Token with publish rights for the Visual Studio Marketplace.
- Add it as a GitHub secret named `VSCE_PAT` in the repository (Settings → Secrets and variables → Actions → New repository secret).
- Publishing is optional; without the secret, the workflow still builds, tests, and attaches the VSIX artifact to the run.

## Integration tests: scratch org setup

To avoid activation errors from Salesforce extensions during tests, the test runner can authenticate a Dev Hub and create a default scratch org automatically using environment variables. This runs before the VS Code test host launches and sets the created scratch org as the default.

- `SF_DEVHUB_AUTH_URL`: SFDX auth URL for your Dev Hub (works with `sf` or `sfdx`).
- `SF_DEVHUB_ALIAS` (optional): Dev Hub alias; default `DevHub`.
- `SF_SCRATCH_ALIAS` (optional): Scratch org alias; default `ALV_Test_Scratch`.
- `SF_SCRATCH_DURATION` (optional): Scratch org duration (days); default `1`.
- `SF_SETUP_SCRATCH` (optional): Set to `1`/`true` to force scratch setup even without an auth URL.
- `SF_TEST_KEEP_ORG` (optional): Set to `1`/`true` to skip deleting the scratch org after tests.

Example:

```
export SF_DEVHUB_AUTH_URL="<paste your SFDX auth URL>"
export SF_DEVHUB_ALIAS=DevHub
export SF_SCRATCH_ALIAS=ALV_Test_Scratch
npm test
```

If `sf` is not found, the runner falls back to `sfdx` for compatible commands.
If neither is present, the test runner attempts to `npm install` a local `@salesforce/cli` and adds `node_modules/.bin` to `PATH` for the session.

## Publishing

See `docs/PUBLISHING.md` for the full Marketplace publishing flow, including pre‑release guidance.
