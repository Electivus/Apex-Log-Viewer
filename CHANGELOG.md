# Change Log

All notable changes to the "apex-log-viewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.0.2] - 2025-08-25

- Fix: Correct repository metadata (repository/homepage/bugs) to Electivus/Apex-Log-Viewer.
- Docs: Site links updated to the new repository (in separate site PR).


- Webview UI: Infinite scroll (remove “Load more” button), client-side filters (User/Operation/Status/Code Unit), and clickable column sorting (Time/Size/Strings/Code Unit) with accessibility hints.
- Org persistence: Remember last selected org across sessions.
- Tail logs: New command and view action to run `sf apex tail log` in an integrated terminal.
- API version: Read `sourceApiVersion` from workspace `sfdx-project.json` and use it for Tooling API requests.
- Security and robustness: Restrict webview `localResourceRoots` to `media/`; add cancellation guards on refresh/close; add a small LRU bound to log head cache.
- Locale: Format times using VS Code locale in the webview.
- Log persistence: Save opened/debugged logs to `apexlogs/` in the current workspace, reuse existing files to avoid re-downloads, and auto-append `apexlogs/` to `.gitignore` when present.
- File naming: Use `apexlogs/<username>_<logId>.log` to avoid collisions across orgs; still recognizes legacy `<logId>.log` if present.
- Network: Remove in-memory body cache; bodies are read from disk when available and fetched only when missing. Head cache retained for list previews.
- Fallback: When no workspace is open, logs are stored under a temp `apexlogs` directory.

## [0.0.1] - 2025-08-23

- Webview log list with search and pagination.
- Org selection (use default org or choose an authenticated org).
