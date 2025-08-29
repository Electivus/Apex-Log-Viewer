# Change Log

Note: This file is managed by Release Please and generated via GitHub Actions. Do not edit it manually; use Conventional Commits and the release PR flow.

All notable changes to the "apex-log-viewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.3.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.2.0...v0.3.0) (2025-08-29)


### Miscellaneous Chores

* prepare pre-release 0.3.0 ([#40](https://github.com/Electivus/Apex-Log-Viewer/issues/40)) ([2936e2e](https://github.com/Electivus/Apex-Log-Viewer/commit/2936e2e19f885331c89480e190144f06d45e3f3d))

## [0.2.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.1.1...v0.2.0) (2025-08-28)

- Promote the 0.1.1 pre‑release to stable; no functional changes since 0.1.1.

## [0.1.1](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.1.0...v0.1.1) (2025-08-28) — Pre‑release

### Added

- Tail: add "Somente USER_DEBUG" filter to live output (System.debug) to focus on user‑level debug lines. (#20 / 2e6fa1c)

### Changed

- Localization: localize Tail view and backend messages; add/adjust i18n keys and generate NLS assets. (#21 / e47f72b)
- Providers: refactor to extract shared workspace/org helpers and common webview HTML. (#19 / 47432e9)

### Fixed

- Webview table: wrap long text and support variable row heights to prevent column overlap. (#18 / 9183bfb)

### Docs

- Marketplace‑first README and docs with screenshots; CI/publishing documentation updates. (#22, #23, #24)

## [0.0.8-pre.1](https://github.com/Electivus/Apex-Log-Viewer/compare/apex-log-viewer-v0.0.7-pre.1...apex-log-viewer-v0.0.8-pre.1) (2025-08-27)

### Features

- Add loading state handling and new configuration options for Apex Log Viewer ([cc2692f](https://github.com/Electivus/Apex-Log-Viewer/commit/cc2692f28305237ef158f5d355e64c32dd524b91))
- Enhance CI workflow to auto-detect release channel and update packaging process for stable and pre-release versions ([d0780f9](https://github.com/Electivus/Apex-Log-Viewer/commit/d0780f94f81b7f65abc0884749db5e51fa0b81ae))
- Implement background warm-up for Apex Replay Debugger and enhance log viewing experience ([141b1e3](https://github.com/Electivus/Apex-Log-Viewer/commit/141b1e392c0aa7bd971d956177be5d84f570ddf0))
- Implement log viewing and tailing features ([896ac6c](https://github.com/Electivus/Apex-Log-Viewer/commit/896ac6c14a2dcf100f9d5201fc90ee43847c9932))
- Refactor publish job in CI workflow to enhance version handling and differentiate between stable and pre-release publishing ([5f3f601](https://github.com/Electivus/Apex-Log-Viewer/commit/5f3f6018d825e7676229aa77743ab6244e69a605))

## [Unreleased]

### Changed

=======
### Fixed

- Validate selected org against available list.
- Release output channel when extension deactivates to free resources.
- Tail: reset caches on stop or org switch to avoid stale logs.
- Localize Salesforce CLI error messages for org auth and listing.

## [0.0.2] - 2025-08-25

- Fix: Correct repository metadata (repository/homepage/bugs) to Electivus/Apex-Log-Viewer.
- Docs: Site links updated to the new repository (in separate site PR).

- Webview UI: Infinite scroll (remove “Load more” button), client-side filters (User/Operation/Status/Code Unit), and clickable column sorting (Time/Size/Strings/Code Unit) with accessibility hints.
- Org persistence: Remember last selected org across sessions.
- Tail logs: New command and view action to run `sf apex tail log` in an integrated terminal.
- Tail: Ensure a TraceFlag for the current user at start if none is active (uses selected Debug Level).
- Tail: Remove server-side filtering by `Application` to avoid dropping valid logs.
- API version: Read `sourceApiVersion` from workspace `sfdx-project.json` and use it for Tooling API requests.
- Security and robustness: Restrict webview `localResourceRoots` to `media/`; add cancellation guards on refresh/close; add a small LRU bound to log head cache.
- Locale: Format times using VS Code locale in the webview.
- Log persistence: Save opened/debugged logs to `apexlogs/` in the current workspace, reuse existing files to avoid re-downloads, and auto-append `apexlogs/` to `.gitignore` when present.
- File naming: Use `apexlogs/<username>_<logId>.log` to avoid collisions across orgs; still recognizes legacy `<logId>.log` if present.
- Network: Remove in-memory body cache; bodies are read from disk when available and fetched only when missing. Head cache retained for list previews.
- Fallback: When no workspace is open, logs are stored under a temp `apexlogs` directory.

## [0.0.3] - 2025-08-25

- Fix: remove server-side log filtering by `Application` to avoid missing logs.
- Tail: ensure a TraceFlag for the current user if none is active (uses selected Debug Level); 30 min TTL.
- Tail: limit in-memory live buffer to ~10k lines to prevent memory growth.
- Tail: auto-stop after 30 minutes to prevent runaway sessions.
- Orgs: remove “Default Org” sentinel and always show/select real org usernames/aliases.

## [0.0.1] - 2025-08-23

- Webview log list with search and pagination.
- Org selection (use default org or choose an authenticated org).
