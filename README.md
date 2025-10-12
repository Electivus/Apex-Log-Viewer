![Electivus Apex Log Viewer banner](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/media/banner.png)

# Electivus Apex Log Viewer

Fast, searchable, telemetry-conscious Salesforce Apex logs—right inside Visual Studio Code. Browse, filter, search, open, tail, and debug org logs in a workspace tailored to Salesforce developers.

[Install on Marketplace](https://marketplace.visualstudio.com/items?itemName=electivus.apex-log-viewer) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/Electivus/Apex-Log-Viewer/issues)

![CI](https://github.com/Electivus/Apex-Log-Viewer/actions/workflows/ci.yml/badge.svg?branch=main)
![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/electivus.apex-log-viewer?label=Marketplace)
![Installs](https://img.shields.io/visual-studio-marketplace/i/electivus.apex-log-viewer)
![Downloads](https://img.shields.io/visual-studio-marketplace/d/electivus.apex-log-viewer)
![Rating](https://img.shields.io/visual-studio-marketplace/r/electivus.apex-log-viewer)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

> Updated on October 12, 2025 — release automation applies the semantic version during packaging; the repository stays at 0.0.0 between releases.

## Why Salesforce developers choose Electivus

- Results in sight: locate long-running logs in seconds with text search, composable filters, and sorting on every column—including duration.
- Context without friction: open directly in the editor or launch Apex Replay Debugger without leaving the panel.
- Always-on productivity: keep a resilient tail using the Salesforce CLI (`sf` or `sfdx`) with smart autoscroll and a configurable buffer.
- Org switching that behaves: move between authenticated orgs while honoring project defaults and CLI aliases.
- Team-ready: localized interface (en, pt-BR), minimal telemetry, and settings you can manage via `settings.json` or the VS Code UI.

## Core capabilities

- **Log explorer** with a paginated table, columns for User, App, Operation, Status, Duration, Code Unit, and Size.
- **Instant header search** plus filters by User, Operation, Status, Code Unit, and Duration with infinite scroll.
- **Full log-body search (enabled by default)** powered by ripgrep, with highlighted matches, match previews, and intelligent preloading that you can disable via `electivus.apexLogs.enableFullLogSearch`.
- **Real-time tail** via the `/systemTopic/Logging` Streaming API, featuring a virtualized view with pause/resume.
- **Apex Replay Debugger integration**: launch debugging from the grid or from saved `.log` files.
- **Optional CLI cache** to reuse org lists and credentials while keeping a manual refresh within reach.
- **Automatic detection** of both `sf` (recommended) and legacy `sfdx` CLIs.

## What's new

### 0.15.x (October 2025)

- Full log-body search now loads Apex log content by default, adds a dedicated match preview column, and keeps the Code Unit column available when you disable the feature.
- Refined virtualized table defaults ensure load-more triggers reliably when full-body search is active.

### 0.14.x (October 2025)

- Opt-in full log-body search with highlighted terms and incremental downloads for very large logs.
- Preloaded log bodies, manual auto-load toggles, and explicit pagination controls when combining complex filters.
- Rebuilt org selection that syncs aliases, respects the project `defaultusername`, and prevents stale selections after refresh.
- Intelligent reopening of saved log files by resolving the log ID from the local path.
- Unified duration formatting for consistent units, backed by targeted unit tests.
- Smarter reuse of Salesforce CLI caches, skipping resets on activation to speed up org discovery.

Check the [CHANGELOG](CHANGELOG.md) for the full breakdown.

## Requirements

- **Salesforce CLI**: `sf` (preferred) or the legacy `sfdx`, authenticated to the orgs you plan to inspect (`sf org login web`).
- **Visual Studio Code 1.90 or newer**.
- **Apex Replay Debugger** (bundled in the Salesforce Extension Pack) for guided debugging; we prompt you to install it on first use if missing.
- **Node.js 20+** is required only when developing the extension, not for regular usage.

## Installation

- **Inside VS Code**: open the Extensions view (`Ctrl/Cmd+Shift+X`), search for “Electivus Apex Log Viewer”, and click `Install`.
- **Marketplace web**: click the “Install” button on the Visual Studio Marketplace listing.
- **Command line**: `code --install-extension electivus.apex-log-viewer`.

## Quick start

1. Open the **Electivus Apex Logs** panel (`View > Appearance > Panel`, then pick the extension tab).
2. Hit **Refresh** to load the latest logs for the current org.
3. Type in the search box and combine filters for User, Operation, Status, or Code Unit to refine results.
4. Click any column header to sort; keep scrolling to fetch more entries on demand.
5. Double-click a row to open the log, or use the action button to launch Apex Replay Debugger.

![Main panel with filters, search, and pagination](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/media/docs/hero.gif)

## Full log-body search

Full log-body search ships enabled by default. Toggle `electivus.apexLogs.enableFullLogSearch` if you prefer lean, header-only queries. While the feature is on:

- Log bodies download and cache as needed, and the cache is refreshed whenever filters change.
- A dedicated Match column surfaces highlighted snippets so you can jump directly to the relevant sections.
- Opening saved `.log` files resolves the Salesforce log ID first, ensuring you inspect the freshest copy in the viewer or Replay.

## Real-time tail

Trigger **Apex Logs: Tail Logs** or the toolbar button to start streaming new logs. While tailing you can:

- Pause and resume without losing history thanks to the configurable buffer (`electivus.apexLogs.tailBufferSize`).
- Filter and search within the in-memory buffer instantly.
- Switch orgs from the dropdown at the top of the view.

![Real-time tail with filters and smart autoscroll](https://raw.githubusercontent.com/Electivus/Apex-Log-Viewer/main/media/docs/apex-tail-log.gif)

## Productivity and reliability helpers

- **Configurable CLI caches**: tune TTLs (`electivus.apexLogs.cliCache.*`) for org lists, auth info, and debug levels; force a refresh with “Reset CLI Cache”.
- **CLI detection and guidance**: we warn when `sf`/`sfdx` is missing on `PATH` and offer remediation tips.
- **Localization**: UI strings ship in English and Brazilian Portuguese and follow your VS Code language settings.
- **On-device processing**: log data stays local; the extension shells out to the official Salesforce CLIs and never uploads log content or credentials.

## Available commands

- `Electivus Apex Logs: Refresh Logs` (`sfLogs.refresh`)
- `Electivus Apex Logs: Select Org` (`sfLogs.selectOrg`)
- `Electivus Apex Logs: Tail Logs` (`sfLogs.tail`)
- `Electivus Apex Logs: Show Extension Output` (`sfLogs.showOutput`)
- `Electivus Apex Logs: Reset CLI Cache` (`sfLogs.resetCliCache`)
- `Electivus Apex Logs: Open Log in Viewer` (`sfLogs.openLogInViewer`)

Use `Ctrl/Cmd+Shift+P` and type “Apex Logs” to discover every command.

## Key settings

| Key | Description |
| --- | ----------- |
| `electivus.apexLogs.pageSize` | Logs fetched per page (default 100). |
| `electivus.apexLogs.headConcurrency` | Concurrent header fetches (default 5). |
| `electivus.apexLogs.enableFullLogSearch` | Enables full log-body search (default `true`). |
| `electivus.apexLogs.tailBufferSize` | Lines retained in the tail buffer (default 10000). |
| `electivus.apexLogs.saveDirName` | Directory used when saving logs (`apexlogs`). |
| `electivus.apexLogs.cliCache.enabled` | Toggles the CLI cache. |
| `electivus.apexLogs.cliCache.orgListTtlSeconds` | TTL for org lists (default 86400 s). |
| `electivus.apexLogs.cliCache.authTtlSeconds` / `authPersistentTtlSeconds` | TTLs for in-memory and on-disk auth data. |
| `electivus.apexLogs.cliCache.debugLevelsTtlSeconds` | TTL for debug level metadata (default 300 s). |
| `electivus.apexLogs.trace` | Verbose CLI/HTTP tracing for troubleshooting. |

Explore [`docs/SETTINGS.md`](docs/SETTINGS.md) for the full catalog.

## Telemetry, privacy, and security

- Minimal, anonymized telemetry (command counts and coarse error categories) that honors VS Code’s `telemetry.telemetryLevel`. Set it to `off` to disable telemetry entirely.
- No log content, source code, tokens, usernames, or instance URLs leave your environment.
- Trace logs stay local in the “Electivus Apex Log Viewer” output channel—review before sharing.
- Dive deeper in [`docs/TELEMETRY.md`](docs/TELEMETRY.md).

## Need help?

- Open a [GitHub issue](https://github.com/Electivus/Apex-Log-Viewer/issues) with reproduction steps, extension version, and VS Code version.
- Check the [testing guide](docs/TESTING.md) and [architecture overview](docs/ARCHITECTURE.md) if you plan to contribute.
- If the extension helps your team, consider leaving a Marketplace review.

---

MIT © Electivus — contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).
