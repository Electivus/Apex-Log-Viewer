# Changelog

## Unreleased

### Features

- Testing: add Playwright E2E coverage against a real scratch org (Dev Hub + seeded Apex log). Also adds a manual GitHub Actions workflow for opt-in validation.

### Bug Fixes

- CLI: add an optional `electivus.apexLogs.cliPath` setting to help VS Code find the Salesforce CLI (`sf`) when PATH inheritance is limited (for example when launched from the OS GUI).

### Chores

- Repo: revert monorepo layout back to a single-root extension structure.
- CLI: remove the Rust CLI package, Cargo workspace files, and CLI npm release workflow.

## [0.22.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.20.0...v0.22.0) (2026-02-13)

### ⚠ BREAKING CHANGES

- Build: require Node 22 and VS Code 1.101 for extension development and installation compatibility. ([#412](https://github.com/Electivus/Apex-Log-Viewer/pull/412)) ([bc8acb7](https://github.com/Electivus/Apex-Log-Viewer/commit/bc8acb7))

### Features

- Repo: migrate to a monorepo layout and add the Rust CLI package `apex-log-viewer-cli`. ([#439](https://github.com/Electivus/Apex-Log-Viewer/pull/439)) ([230d324](https://github.com/Electivus/Apex-Log-Viewer/commit/230d324))
- Distribution: add Open VSX publishing support to workflows and documentation. ([#386](https://github.com/Electivus/Apex-Log-Viewer/pull/386)) ([5042e14](https://github.com/Electivus/Apex-Log-Viewer/commit/5042e14))

### Bug Fixes

- API versioning: automatically fall back to each org's max supported Salesforce API version when `sourceApiVersion` is higher, preventing 404 failures in logs and trace-flag calls and surfacing a warning in Output + Logs UI. ([#497](https://github.com/Electivus/Apex-Log-Viewer/pull/497)) ([7c91387](https://github.com/Electivus/Apex-Log-Viewer/commit/7c91387))
- CLI: recover gracefully from an empty persisted org cache. ([#496](https://github.com/Electivus/Apex-Log-Viewer/pull/496)) ([1749cd7](https://github.com/Electivus/Apex-Log-Viewer/commit/1749cd7))
- Workflows: roll back prerelease state when publish fails. ([#416](https://github.com/Electivus/Apex-Log-Viewer/pull/416)) ([4c9771d](https://github.com/Electivus/Apex-Log-Viewer/commit/4c9771d))

### Refactors

- Webview: remove unused components and styles. ([64a3690](https://github.com/Electivus/Apex-Log-Viewer/commit/64a3690))

### Build

- CLI: add npm release workflow for platform packages and wrapper package publishing. ([#459](https://github.com/Electivus/Apex-Log-Viewer/pull/459)) ([4ab71fe](https://github.com/Electivus/Apex-Log-Viewer/commit/4ab71fe))
- Workflows: prevent `vsce` from packaging the workspace root during release packaging. ([#458](https://github.com/Electivus/Apex-Log-Viewer/pull/458)) ([ced9280](https://github.com/Electivus/Apex-Log-Viewer/commit/ced9280))
- Workflows: publish VSIX artifacts to Open VSX when `OVSX_PAT` is configured. ([#386](https://github.com/Electivus/Apex-Log-Viewer/pull/386)) ([5042e14](https://github.com/Electivus/Apex-Log-Viewer/commit/5042e14))
- Dependencies: upgrade runtime/dev dependencies and GitHub Actions versions across the extension toolchain.

### Chores

- Repo hygiene: ignore generated docs artifacts and Rust build output, and remove outdated internal docs files. ([2f2c245](https://github.com/Electivus/Apex-Log-Viewer/commit/2f2c245)) ([7980a78](https://github.com/Electivus/Apex-Log-Viewer/commit/7980a78)) ([05326a5](https://github.com/Electivus/Apex-Log-Viewer/commit/05326a5)) ([a4e82ec](https://github.com/Electivus/Apex-Log-Viewer/commit/a4e82ec))

## [0.20.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.18.0...v0.20.0) (2025-10-22)

### Features

- Logs: add an error filter toggle to spotlight entries with error-level log lines. ([#351](https://github.com/Electivus/Apex-Log-Viewer/pull/351)) ([5a03c2c](https://github.com/Electivus/Apex-Log-Viewer/commit/5a03c2c))
- Logs: support in-log navigation controls so search results can jump between matches. ([#350](https://github.com/Electivus/Apex-Log-Viewer/pull/350)) ([dd5203d](https://github.com/Electivus/Apex-Log-Viewer/commit/dd5203d))

## [0.18.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.17.0...v0.18.0) (2025-10-16)

### Miscellaneous

- Promote v0.17.0 changes to the stable channel without additional code updates.

## [0.17.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.16.0...v0.17.0) (2025-10-15)

### Bug Fixes

- LogsTable: keep the Code Unit column visible so filtered views stay aligned. ([#347](https://github.com/Electivus/Apex-Log-Viewer/pull/347)) ([480c1bb](https://github.com/Electivus/Apex-Log-Viewer/commit/480c1bb087c9871fc836b27cce6210f123f61260))

## [0.14.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.12.0...v0.14.0) (2025-10-02)

### Features

- Logs: enable optional full log body search backed by ripgrep, with improved query handling, highlighted matches, and packaging updates for architecture-specific binaries. ([#273](https://github.com/Electivus/Apex-Log-Viewer/pull/273)) ([55b04fd](https://github.com/Electivus/Apex-Log-Viewer/commit/55b04fd))
- Logs: preload log bodies and purge caches to keep filtered results fresh during search workflows. ([#280](https://github.com/Electivus/Apex-Log-Viewer/pull/280)) ([c87e304](https://github.com/Electivus/Apex-Log-Viewer/commit/c87e304))
- Logs: track missing downloads, offer auto-load toggles, and expose manual pagination for filtered tables. ([#292](https://github.com/Electivus/Apex-Log-Viewer/pull/292)) ([68bf881](https://github.com/Electivus/Apex-Log-Viewer/commit/68bf881))
- Orgs: rebuild selection by removing persisted global state, resolving aliases, and honoring project default orgs when picking connections. ([#276](https://github.com/Electivus/Apex-Log-Viewer/pull/276), [#293](https://github.com/Electivus/Apex-Log-Viewer/pull/293)) ([408a1dd](https://github.com/Electivus/Apex-Log-Viewer/commit/408a1dd), [e84ad02](https://github.com/Electivus/Apex-Log-Viewer/commit/e84ad02))
- Logs: detect log IDs from saved file paths to support reopening local log files. ([#295](https://github.com/Electivus/Apex-Log-Viewer/pull/295)) ([233f9d5](https://github.com/Electivus/Apex-Log-Viewer/commit/233f9d5))
- Logs: refine duration formatting for consistent units and add targeted unit tests. ([#298](https://github.com/Electivus/Apex-Log-Viewer/pull/298)) ([ccbec2c](https://github.com/Electivus/Apex-Log-Viewer/commit/ccbec2c))

### Bug Fixes

- Logs: keep header-only loading as the default so full content search remains opt-in. ([#277](https://github.com/Electivus/Apex-Log-Viewer/pull/277)) ([c7c0794](https://github.com/Electivus/Apex-Log-Viewer/commit/c7c0794))
- Logs: ensure load-more uses the latest callback to prevent stale pagination in the table. ([#297](https://github.com/Electivus/Apex-Log-Viewer/pull/297)) ([436de1d](https://github.com/Electivus/Apex-Log-Viewer/commit/436de1d))
- Logs: reuse `ensureLogFile` when launching replay debugging so the viewer opens the freshest copy. ([#283](https://github.com/Electivus/Apex-Log-Viewer/pull/283)) ([05d5119](https://github.com/Electivus/Apex-Log-Viewer/commit/05d5119))
- Config: scope the tail head concurrency setting under the `electivus` namespace for compatibility. ([#294](https://github.com/Electivus/Apex-Log-Viewer/pull/294)) ([87654ef](https://github.com/Electivus/Apex-Log-Viewer/commit/87654ef))
- Orgs: sync the selected org with the list to avoid dangling selections after refresh. ([#282](https://github.com/Electivus/Apex-Log-Viewer/pull/282)) ([efcf1aa](https://github.com/Electivus/Apex-Log-Viewer/commit/efcf1aa))

### Performance

- Extension: stop resetting the Salesforce CLI org cache on activation to reuse cached org listings. ([#291](https://github.com/Electivus/Apex-Log-Viewer/pull/291)) ([80e97c7](https://github.com/Electivus/Apex-Log-Viewer/commit/80e97c7))

### Build

- Workflows: inject `GITHUB_TOKEN` into release and prerelease jobs to unblock publishing. ([#275](https://github.com/Electivus/Apex-Log-Viewer/pull/275)) ([7ae70ca](https://github.com/Electivus/Apex-Log-Viewer/commit/7ae70ca))
- Workflows: streamline release versioning logic and channel determination. ([#278](https://github.com/Electivus/Apex-Log-Viewer/pull/278)) ([e265394](https://github.com/Electivus/Apex-Log-Viewer/commit/e265394))

### Tests

- Coverage: add c8-based coverage reporting and improve cleanup of VS Code test instances. ([#252](https://github.com/Electivus/Apex-Log-Viewer/pull/252)) ([ceac94d](https://github.com/Electivus/Apex-Log-Viewer/commit/ceac94d))
- Webview: add comprehensive unit tests for log and tail components and supporting utilities. ([#255](https://github.com/Electivus/Apex-Log-Viewer/pull/255)) ([04344dc](https://github.com/Electivus/Apex-Log-Viewer/commit/04344dc))

### Chores

- Dependabot: remove grouped update configuration to resume individual dependency alerts. ([#264](https://github.com/Electivus/Apex-Log-Viewer/pull/264)) ([fa80fd0](https://github.com/Electivus/Apex-Log-Viewer/commit/fa80fd0))

## [0.12.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.10.0...v0.12.0) (2025-09-20)

### ⚠ BREAKING CHANGES

- Webview: remove the Diagram and Call Tree experiences along with related commands to simplify maintenance. If you need these experimental views back, please open an issue to discuss alternatives. ([#195](https://github.com/Electivus/Apex-Log-Viewer/pull/195)) ([f47b863](https://github.com/Electivus/Apex-Log-Viewer/commit/f47b863))

### Features

- Logs: add a duration column to the Apex Logs view so you can quickly spot longer executions. ([#194](https://github.com/Electivus/Apex-Log-Viewer/pull/194)) ([13ed564](https://github.com/Electivus/Apex-Log-Viewer/commit/13ed564))
- Webview: introduce a shared `LabeledSelect` control and refresh toolbars for consistent filtering UX. ([#196](https://github.com/Electivus/Apex-Log-Viewer/pull/196)) ([f5318cc](https://github.com/Electivus/Apex-Log-Viewer/commit/f5318cc))
- UI: migrate webview components to a new Tailwind-powered design system with updated buttons, inputs, and tables. ([#230](https://github.com/Electivus/Apex-Log-Viewer/pull/230)) ([8b28816](https://github.com/Electivus/Apex-Log-Viewer/commit/8b28816))
- Log Viewer: add a dedicated log detail panel with filters, status bar, and structured entry list. ([#231](https://github.com/Electivus/Apex-Log-Viewer/pull/231)) ([20ddcd1](https://github.com/Electivus/Apex-Log-Viewer/commit/20ddcd1))
- VS Code: add a command and CodeLens to open Apex logs directly in the viewer. ([#237](https://github.com/Electivus/Apex-Log-Viewer/pull/237)) ([38e5c52](https://github.com/Electivus/Apex-Log-Viewer/commit/38e5c52))

### Bug Fixes

- Webview: avoid showing duplicate org entries when the tail view loads. ([#238](https://github.com/Electivus/Apex-Log-Viewer/pull/238)) ([53d518b](https://github.com/Electivus/Apex-Log-Viewer/commit/53d518b))

### Styling

- Webview: align toolbar controls to share a consistent height. ([#249](https://github.com/Electivus/Apex-Log-Viewer/pull/249)) ([9935366](https://github.com/Electivus/Apex-Log-Viewer/commit/9935366))

### Build

- deps-dev: bump @typescript-eslint/eslint-plugin. ([#223](https://github.com/Electivus/Apex-Log-Viewer/pull/223)) ([2bd6752](https://github.com/Electivus/Apex-Log-Viewer/commit/2bd6752))
- deps-dev: bump @types/node from 24.3.1 to 24.5.2. ([#232](https://github.com/Electivus/Apex-Log-Viewer/pull/232)) ([24431a9](https://github.com/Electivus/Apex-Log-Viewer/commit/24431a9))
- deps-dev: bump jsdom from 26.1.0 to 27.0.0. ([#233](https://github.com/Electivus/Apex-Log-Viewer/pull/233)) ([f29ab0f](https://github.com/Electivus/Apex-Log-Viewer/commit/f29ab0f))
- deps-dev: bump react-window from 2.1.0 to 2.1.1. ([#234](https://github.com/Electivus/Apex-Log-Viewer/pull/234)) ([8790fbb](https://github.com/Electivus/Apex-Log-Viewer/commit/8790fbb))
- deps-dev: bump esbuild from 0.25.9 to 0.25.10. ([#236](https://github.com/Electivus/Apex-Log-Viewer/pull/236)) ([ac8d547](https://github.com/Electivus/Apex-Log-Viewer/commit/ac8d547))
- deps-dev: bump tailwindcss from 3.4.17 to 4.1.13. ([#240](https://github.com/Electivus/Apex-Log-Viewer/pull/240)) ([a99104a](https://github.com/Electivus/Apex-Log-Viewer/commit/a99104a))
- deps: bump @salesforce/apex-node in the salesforce-sdk group. ([#245](https://github.com/Electivus/Apex-Log-Viewer/pull/245)) ([6c2c3da](https://github.com/Electivus/Apex-Log-Viewer/commit/6c2c3da))
- deps-dev: bump eslint in the linting-and-formatting group. ([#246](https://github.com/Electivus/Apex-Log-Viewer/pull/246)) ([0127fbb](https://github.com/Electivus/Apex-Log-Viewer/commit/0127fbb))
- deps-dev: bump sharp from 0.34.3 to 0.34.4 in the tooling group. ([#247](https://github.com/Electivus/Apex-Log-Viewer/pull/247)) ([7994558](https://github.com/Electivus/Apex-Log-Viewer/commit/7994558))

### Chores

- Repo: add the Visual Prototype for Apex Log directory to `.gitignore`. ([2596895](https://github.com/Electivus/Apex-Log-Viewer/commit/2596895))
- Dependabot: configure grouped updates for React and VS Code types. ([#244](https://github.com/Electivus/Apex-Log-Viewer/pull/244)) ([47d851c](https://github.com/Electivus/Apex-Log-Viewer/commit/47d851c))
- Dependabot: define update groups across the repo. ([#241](https://github.com/Electivus/Apex-Log-Viewer/pull/241)) ([f20e95d](https://github.com/Electivus/Apex-Log-Viewer/commit/f20e95d))
- CI: restrict workflow permissions to the minimum required. ([#248](https://github.com/Electivus/Apex-Log-Viewer/pull/248)) ([d0962ed](https://github.com/Electivus/Apex-Log-Viewer/commit/d0962ed))
- Dependabot: cap simultaneous npm and GitHub Actions pull requests. ([fa4e2bd](https://github.com/Electivus/Apex-Log-Viewer/commit/fa4e2bd))

## [0.10.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.8.0...v0.10.0) (2025-09-12)

### Features

- Call Tree: add Call Tree + Flame Graph for Apex logs ([#190](https://github.com/Electivus/Apex-Log-Viewer/pull/190)) ([b6361fe](https://github.com/Electivus/Apex-Log-Viewer/commit/b6361fe))

### Bug Fixes

- Webview: allow worker-src in CSP to avoid service worker registration error in VS Code webviews ([#193](https://github.com/Electivus/Apex-Log-Viewer/pull/193)) ([cd40b0d](https://github.com/Electivus/Apex-Log-Viewer/commit/cd40b0d))
- Logs: use cursor-based pagination to bypass SOQL OFFSET 2000 ([#192](https://github.com/Electivus/Apex-Log-Viewer/pull/192)) ([d34df8e](https://github.com/Electivus/Apex-Log-Viewer/commit/d34df8e))

### Refactoring

- Provider: extract log services and handlers ([#191](https://github.com/Electivus/Apex-Log-Viewer/pull/191)) ([3565a03](https://github.com/Electivus/Apex-Log-Viewer/commit/3565a03))
- Parser: modularize types, levels, and graph; update imports; add unit tests ([#189](https://github.com/Electivus/Apex-Log-Viewer/pull/189)) ([4d7ac75](https://github.com/Electivus/Apex-Log-Viewer/commit/4d7ac75))

### Build

- deps-dev: bump @typescript-eslint/eslint-plugin ([#182](https://github.com/Electivus/Apex-Log-Viewer/pull/182)) ([c46b53d](https://github.com/Electivus/Apex-Log-Viewer/commit/c46b53d))
- deps-dev: bump react-window from 2.0.2 to 2.1.0 ([#183](https://github.com/Electivus/Apex-Log-Viewer/pull/183)) ([c990fe2](https://github.com/Electivus/Apex-Log-Viewer/commit/c990fe2))
- CI: prerelease tags use v<version> + USER_DEBUG TraceFlag ([#180](https://github.com/Electivus/Apex-Log-Viewer/pull/180)) ([0eceb02](https://github.com/Electivus/Apex-Log-Viewer/commit/0eceb02))

### Tests

- Salesforce: stabilize CLI utils tests ([#184](https://github.com/Electivus/Apex-Log-Viewer/pull/184)) ([a911d6b](https://github.com/Electivus/Apex-Log-Viewer/commit/a911d6b))

## [0.8.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.6.2...v0.8.0) (2025-09-08)

### Features

- Telemetry: add coarse performance timings and avoid error message PII ([d291053](https://github.com/Electivus/Apex-Log-Viewer/commit/d291053))

## [0.6.2](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.6.1...v0.6.2) (2025-09-07)

### Features

- CLI: surface command and exit codes in errors ([5732f7e](https://github.com/Electivus/Apex-Log-Viewer/commit/5732f7e))
- Traceflags: cache debug levels ([a1c9f09](https://github.com/Electivus/Apex-Log-Viewer/commit/a1c9f09))
- Webview: add keyboard handlers to log row ([#170](https://github.com/Electivus/Apex-Log-Viewer/pull/170)) ([4fe8de2](https://github.com/Electivus/Apex-Log-Viewer/commit/4fe8de2))
- Logs: add cancellation support to progress operations ([#166](https://github.com/Electivus/Apex-Log-Viewer/pull/166)) ([c5ba2bb](https://github.com/Electivus/Apex-Log-Viewer/commit/c5ba2bb))
- Traceflags: cache current user id ([168fb40](https://github.com/Electivus/Apex-Log-Viewer/commit/168fb40))
- Logs: show progress when listing orgs and refreshing ([760830f](https://github.com/Electivus/Apex-Log-Viewer/commit/760830f))
- Branding: Electivus-prefixed naming; deprecate `sfLogs.*`; remove max limits ([#137](https://github.com/Electivus/Apex-Log-Viewer/pull/137)) ([a7b090a](https://github.com/Electivus/Apex-Log-Viewer/commit/a7b090a))
- CLI cache: persist sf CLI results for 1 day and add reset command ([#132](https://github.com/Electivus/Apex-Log-Viewer/pull/132)) ([99092e1](https://github.com/Electivus/Apex-Log-Viewer/commit/99092e1))

### Bug Fixes

- Tail: retry log fetch on failure ([7871a3b](https://github.com/Electivus/Apex-Log-Viewer/commit/7871a3b))
- Select Org: handle list failures ([047e67e](https://github.com/Electivus/Apex-Log-Viewer/commit/047e67e))
- Clamp logs page size to 200 ([ce834f1](https://github.com/Electivus/Apex-Log-Viewer/commit/ce834f1))
- Webview: guard tail auto-scroll with empty filters ([a9e8f16](https://github.com/Electivus/Apex-Log-Viewer/commit/a9e8f16))
- Tail: clear timers on start failure ([733c789](https://github.com/Electivus/Apex-Log-Viewer/commit/733c789))
- Tail: set running flag before async ops and abort if stopped during setup ([329b134](https://github.com/Electivus/Apex-Log-Viewer/commit/329b134))
- Webview: handle zero-length regex in highlightContent ([78a8c26](https://github.com/Electivus/Apex-Log-Viewer/commit/78a8c26))
- Utils: sync cache key index on deletion ([#135](https://github.com/Electivus/Apex-Log-Viewer/pull/135)) ([e624d50](https://github.com/Electivus/Apex-Log-Viewer/commit/e624d50))
- CLI: purge expired auth cache ([#136](https://github.com/Electivus/Apex-Log-Viewer/pull/136)) ([32c8545](https://github.com/Electivus/Apex-Log-Viewer/commit/32c8545))
- Diagram: prevent recursive panel disposal ([#134](https://github.com/Electivus/Apex-Log-Viewer/pull/134)) ([57d546b](https://github.com/Electivus/Apex-Log-Viewer/commit/57d546b))

### Refactoring

- Centralize error message handling ([ccc2b1c](https://github.com/Electivus/Apex-Log-Viewer/commit/ccc2b1c))
- Telemetry: add safe send helper ([b1d8ace](https://github.com/Electivus/Apex-Log-Viewer/commit/b1d8ace))
- Tail: remove unused polling timer ([2d67844](https://github.com/Electivus/Apex-Log-Viewer/commit/2d67844))

### Build

- Bump actions/setup-node from 4 to 5 ([#152](https://github.com/Electivus/Apex-Log-Viewer/pull/152)) ([d57277f](https://github.com/Electivus/Apex-Log-Viewer/commit/d57277f))
- Bump actions/checkout from 4 to 5 ([#153](https://github.com/Electivus/Apex-Log-Viewer/pull/153)) ([392f0b3](https://github.com/Electivus/Apex-Log-Viewer/commit/392f0b3))
- Bump @types/node from 24.3.0 to 24.3.1 ([#156](https://github.com/Electivus/Apex-Log-Viewer/pull/156)) ([0d923a6](https://github.com/Electivus/Apex-Log-Viewer/commit/0d923a6))
- Bump @salesforce/core from 8.23.0 to 8.23.1 ([#157](https://github.com/Electivus/Apex-Log-Viewer/pull/157)) ([96436c8](https://github.com/Electivus/Apex-Log-Viewer/commit/96436c8))
- Bump @vscode/extension-telemetry from 0.9.9 to 1.0.0 ([#154](https://github.com/Electivus/Apex-Log-Viewer/pull/154)) ([bd859f1](https://github.com/Electivus/Apex-Log-Viewer/commit/bd859f1))
- Bump eslint from 9.34.0 to 9.35.0 ([#155](https://github.com/Electivus/Apex-Log-Viewer/pull/155)) ([48b6dd1](https://github.com/Electivus/Apex-Log-Viewer/commit/48b6dd1))
- Bump @salesforce/apex-node from 8.2.11 to 8.2.13 ([#158](https://github.com/Electivus/Apex-Log-Viewer/pull/158)) ([e5e8841](https://github.com/Electivus/Apex-Log-Viewer/commit/e5e8841))

### Tests

- Add CacheManager unit tests ([7c4dc2d](https://github.com/Electivus/Apex-Log-Viewer/commit/7c4dc2d))
- Logger: ensure showOutput reveals channel ([#167](https://github.com/Electivus/Apex-Log-Viewer/pull/167)) ([3cc64ad](https://github.com/Electivus/Apex-Log-Viewer/commit/3cc64ad))
- Runner: skip SF CLI/Dev Hub on unit and prefer stable VS Code to reuse cache ([#172](https://github.com/Electivus/Apex-Log-Viewer/pull/172)) ([5ee8ca9](https://github.com/Electivus/Apex-Log-Viewer/commit/5ee8ca9))
- Telemetry: verify CLI error reporting ([#133](https://github.com/Electivus/Apex-Log-Viewer/pull/133)) ([f8afb8b](https://github.com/Electivus/Apex-Log-Viewer/commit/f8afb8b))

### Docs/Chores

- Docs: improve AI coding agent instructions ([#171](https://github.com/Electivus/Apex-Log-Viewer/pull/171)) ([12276fa](https://github.com/Electivus/Apex-Log-Viewer/commit/12276fa))
- Logs: warn on log head fetch errors ([eafe94a](https://github.com/Electivus/Apex-Log-Viewer/commit/eafe94a))

## [0.4.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.3.1...v0.4.0) (2025-09-01)

### Features

- Add Apex log diagram visualization (no external libs) ([#93](https://github.com/Electivus/Apex-Log-Viewer/pull/93)) ([39290af](https://github.com/Electivus/Apex-Log-Viewer/commit/39290af))
- Tail Apex Logs via Streaming API (/systemTopic/Logging) ([#43](https://github.com/Electivus/Apex-Log-Viewer/pull/43)) ([a55bfa7](https://github.com/Electivus/Apex-Log-Viewer/commit/a55bfa7))
- Tail: virtualized list, configurable buffer, viewport-aware paging ([#72](https://github.com/Electivus/Apex-Log-Viewer/pull/72)) ([dc117d3](https://github.com/Electivus/Apex-Log-Viewer/commit/dc117d3))
- Tail: smart autoscroll and dynamic height ([#73](https://github.com/Electivus/Apex-Log-Viewer/pull/73)) ([3b04179](https://github.com/Electivus/Apex-Log-Viewer/commit/3b04179))
- Cache org list and support forced refresh ([#79](https://github.com/Electivus/Apex-Log-Viewer/pull/79)) ([f425a32](https://github.com/Electivus/Apex-Log-Viewer/commit/f425a32))
- Rename panels to "Apex Logs" and "Apex Logs Tail" ([#49](https://github.com/Electivus/Apex-Log-Viewer/pull/49)) ([494c8c8](https://github.com/Electivus/Apex-Log-Viewer/commit/494c8c8))

### Bug Fixes

- Terminate Salesforce CLI commands after ~30s to prevent hanging ([#90](https://github.com/Electivus/Apex-Log-Viewer/pull/90), [#91](https://github.com/Electivus/Apex-Log-Viewer/pull/91)) ([8b8f40d](https://github.com/Electivus/Apex-Log-Viewer/commit/8b8f40d), [4653686](https://github.com/Electivus/Apex-Log-Viewer/commit/4653686))
- Reset TailService resources on stop ([#75](https://github.com/Electivus/Apex-Log-Viewer/pull/75)) ([01a8496](https://github.com/Electivus/Apex-Log-Viewer/commit/01a8496))
- Stop TailService on webview dispose; allow tail after reopen ([#42](https://github.com/Electivus/Apex-Log-Viewer/pull/42)) ([7f69818](https://github.com/Electivus/Apex-Log-Viewer/commit/7f69818))
- Log ignored errors in catch blocks ([#92](https://github.com/Electivus/Apex-Log-Viewer/pull/92)) ([20e3094](https://github.com/Electivus/Apex-Log-Viewer/commit/20e3094))
- Log failed auth token refresh ([#77](https://github.com/Electivus/Apex-Log-Viewer/pull/77)) ([01c26e5](https://github.com/Electivus/Apex-Log-Viewer/commit/01c26e5))
- Remove duplicate resolving PATH finalizer ([#32](https://github.com/Electivus/Apex-Log-Viewer/pull/32)) ([3e751e1](https://github.com/Electivus/Apex-Log-Viewer/commit/3e751e1))
- Log sendOrgs errors in tail view ([#39](https://github.com/Electivus/Apex-Log-Viewer/pull/39)) ([37035bb](https://github.com/Electivus/Apex-Log-Viewer/commit/37035bb))

### Docs

- Add architecture overview ([#45](https://github.com/Electivus/Apex-Log-Viewer/pull/45)) ([40c543b](https://github.com/Electivus/Apex-Log-Viewer/commit/40c543b))
- Inline usage guide in README ([#44](https://github.com/Electivus/Apex-Log-Viewer/pull/44)) ([007f370](https://github.com/Electivus/Apex-Log-Viewer/commit/007f370))
- Add settings guide ([#46](https://github.com/Electivus/Apex-Log-Viewer/pull/46)) ([3833fae](https://github.com/Electivus/Apex-Log-Viewer/commit/3833fae))

### Build

- Bundle extension runtime with esbuild; exclude node_modules; stub 'bfj' ([#94](https://github.com/Electivus/Apex-Log-Viewer/pull/94)) ([828c53e](https://github.com/Electivus/Apex-Log-Viewer/commit/828c53e))
- Specify Node 20 engine and document requirement ([#85](https://github.com/Electivus/Apex-Log-Viewer/pull/85)) ([6d98c3d](https://github.com/Electivus/Apex-Log-Viewer/commit/6d98c3d))

### Refactoring

- Extract TailService and streaming utilities; typed helpers and module splits ([2233539](https://github.com/Electivus/Apex-Log-Viewer/commit/2233539), [73dab59](https://github.com/Electivus/Apex-Log-Viewer/commit/73dab59), [18c2b03](https://github.com/Electivus/Apex-Log-Viewer/commit/18c2b03), [05e7ad4](https://github.com/Electivus/Apex-Log-Viewer/commit/05e7ad4))

## [0.3.1](https://github.com/Electivus/Apex-Log-Viewer/compare/apex-log-viewer-v0.3.1...apex-log-viewer-v0.3.1) (2025-08-30)

### ⚠ BREAKING CHANGES

- **runner:** harden VS Code tests; docs and CI updates ([#16](https://github.com/Electivus/Apex-Log-Viewer/issues/16))

### Features

- Add loading state handling and new configuration options for Apex Log Viewer ([cc2692f](https://github.com/Electivus/Apex-Log-Viewer/commit/cc2692f28305237ef158f5d355e64c32dd524b91))
- **docs:** document release channels (odd=pre, even=stable)\n\nRelease-As: 0.1.0 ([8fdd722](https://github.com/Electivus/Apex-Log-Viewer/commit/8fdd722102dc8837b007016088b5a19932378ed1))
- Enhance CI workflow to auto-detect release channel and update packaging process for stable and pre-release versions ([d0780f9](https://github.com/Electivus/Apex-Log-Viewer/commit/d0780f94f81b7f65abc0884749db5e51fa0b81ae))
- Implement background warm-up for Apex Replay Debugger and enhance log viewing experience ([141b1e3](https://github.com/Electivus/Apex-Log-Viewer/commit/141b1e392c0aa7bd971d956177be5d84f570ddf0))
- Implement log viewing and tailing features ([896ac6c](https://github.com/Electivus/Apex-Log-Viewer/commit/896ac6c14a2dcf100f9d5201fc90ee43847c9932))
- Refactor publish job in CI workflow to enhance version handling and differentiate between stable and pre-release publishing ([5f3f601](https://github.com/Electivus/Apex-Log-Viewer/commit/5f3f6018d825e7676229aa77743ab6244e69a605))
- **tail:** add 'Somente USER_DEBUG' filter to live output ([#20](https://github.com/Electivus/Apex-Log-Viewer/issues/20)) ([2e6fa1c](https://github.com/Electivus/Apex-Log-Viewer/commit/2e6fa1ced333a3eedef36400f804736a6f753a3a))
- **tail:** reduce polling when window inactive using WindowState API (VS Code 1.90+) ([#14](https://github.com/Electivus/Apex-Log-Viewer/issues/14)) ([9023a88](https://github.com/Electivus/Apex-Log-Viewer/commit/9023a88468357310186dbe7f49a17de3df8da699))

### Bug Fixes

- **ci:** remove .vscodeignore to avoid vsce files conflict ([#18](https://github.com/Electivus/Apex-Log-Viewer/issues/18)) ([2866394](https://github.com/Electivus/Apex-Log-Viewer/commit/28663944890ecddf6c381d54bbc8c04708683b65))
- **tests:** improve extension installation and test execution handling ([8c018fe](https://github.com/Electivus/Apex-Log-Viewer/commit/8c018fee9d95835e814c9b5a1bd46b53f27db0f1))

### Refactoring

- migrate from @vscode/test-cli to @vscode/test-electron; update testing scripts and documentation ([be26aba](https://github.com/Electivus/Apex-Log-Viewer/commit/be26abaf4f0afb4131edf96107ec7fb9fc5e85e2))

### Docs

- **changelog:** reset to generated header (managed by Release Please) ([527f0c2](https://github.com/Electivus/Apex-Log-Viewer/commit/527f0c2e13f348d7107bd61fc7cd84a79920d26a))
- forbid manual edits to CHANGELOG and document automated release flow ([#38](https://github.com/Electivus/Apex-Log-Viewer/issues/38)) ([1e6e365](https://github.com/Electivus/Apex-Log-Viewer/commit/1e6e3651dbdabf43354e0d5c956a9cb7e39c9977))
- **test:** document new test scripts and behaviours ([f87dd23](https://github.com/Electivus/Apex-Log-Viewer/commit/f87dd23cd7197a765005afa8e54c3c173867db56))

### Build

- **vsix:** slim VSIX; externalize README images and split CONTRIBUTING ([#13](https://github.com/Electivus/Apex-Log-Viewer/issues/13)) ([f55306b](https://github.com/Electivus/Apex-Log-Viewer/commit/f55306b1c04160bd704fad9a9b15df7347554253))

### CI

- allow manual packaging via workflow_dispatch (tag_name) ([102f8ae](https://github.com/Electivus/Apex-Log-Viewer/commit/102f8ae381ac964a7288b8a603b1c1e72c79c25e))
- enforce conventional commits and automate releases ([#24](https://github.com/Electivus/Apex-Log-Viewer/issues/24)) ([7a03200](https://github.com/Electivus/Apex-Log-Viewer/commit/7a032009c1a091a4b120b991e73ca9c75811a88a))
- execute unit + integration with npm run test:ci ([21332cc](https://github.com/Electivus/Apex-Log-Viewer/commit/21332cc84db98c404cf93b44bf0c45a49013864a))
- guard against manual CHANGELOG.md edits in PRs ([#39](https://github.com/Electivus/Apex-Log-Viewer/issues/39)) ([c9ed3b1](https://github.com/Electivus/Apex-Log-Viewer/commit/c9ed3b1ba42ceb931bca0feb8e790923fb27d95d))
- nightly 4-part version + release safeguards follow-up ([#20](https://github.com/Electivus/Apex-Log-Viewer/issues/20)) ([260fc7f](https://github.com/Electivus/Apex-Log-Viewer/commit/260fc7f92e0b6dd7460f1f51dfe3191571303248))
- prerelease unique version + release safeguards ([#19](https://github.com/Electivus/Apex-Log-Viewer/issues/19)) ([caebbf5](https://github.com/Electivus/Apex-Log-Viewer/commit/caebbf538110f2873b8aaa0b5564074df9694097))
- **prerelease:** fix YAML (heredoc removal) and export env for Marketplace lookup ([#22](https://github.com/Electivus/Apex-Log-Viewer/issues/22)) ([6a2d462](https://github.com/Electivus/Apex-Log-Viewer/commit/6a2d462277f884de9170d2dffe0d522d2c077b5a))
- **prerelease:** increment patch from Marketplace last pre-release ([#21](https://github.com/Electivus/Apex-Log-Viewer/issues/21)) ([3e89b7f](https://github.com/Electivus/Apex-Log-Viewer/commit/3e89b7ff81bfc7a0501751dba3924a17574dd72f))
- **prerelease:** tag GitHub pre-release as pre-&lt;version&gt;; export env for Marketplace lookup; replace heredoc with inline node -e ([#23](https://github.com/Electivus/Apex-Log-Viewer/issues/23)) ([df32134](https://github.com/Electivus/Apex-Log-Viewer/commit/df32134123f87cff89a7ff7c912699913a448459))
- **release-please:** add concurrency; minimize global permissions; elevate only in job ([383b003](https://github.com/Electivus/Apex-Log-Viewer/commit/383b0036053316f3f522b289c38223394d600a2b))
- **release-please:** add issues: write for labeling ([372db00](https://github.com/Electivus/Apex-Log-Viewer/commit/372db003878aed25ebba746689b560bd9236bca6))
- **release-please:** enable PR creation (remove skip); fix YAML indent ([84ebde4](https://github.com/Electivus/Apex-Log-Viewer/commit/84ebde428de7c72079c8b5ddbd83c4bf91ac4012))
- **release-please:** set workflow-level permissions; skip PR when no PAT to bypass policy ([386e687](https://github.com/Electivus/Apex-Log-Viewer/commit/386e6876b029840e3e5bc1766342657359371b3d))
- **release-please:** switch to googleapis/release-please-action@v4; config/manifest; token fallback; pin by SHA ([#16](https://github.com/Electivus/Apex-Log-Viewer/issues/16)) ([3304f82](https://github.com/Electivus/Apex-Log-Viewer/commit/3304f825b470c0440e374d8a81e885fa5506190c))
- **releases:** also run on release edited events ([6f809c9](https://github.com/Electivus/Apex-Log-Viewer/commit/6f809c93c91416b196c09542483e5ca30f660b50))
- **releases:** auto-set prerelease on published releases ([13adfab](https://github.com/Electivus/Apex-Log-Viewer/commit/13adfabd3164fc2ec423632aaf86b4adfbdf38cb))
- **releases:** auto-toggle GitHub Release prerelease flag in packaging jobs ([0acd783](https://github.com/Electivus/Apex-Log-Viewer/commit/0acd7831d362e54eae1be053bdaf5018b0b82592))
- **releases:** contents: write for package/publish ([4f1999c](https://github.com/Electivus/Apex-Log-Viewer/commit/4f1999c0d41c73130d9865de1d1daaa712a71680))
- **releases:** fix YAML indentation (env should be sibling of with) ([5ef3f45](https://github.com/Electivus/Apex-Log-Viewer/commit/5ef3f45f4eb5732eea1f6fbe40b530124c710635))
- **releases:** make concurrency group safe on non-release events; fix YAML validation on push ([b08d9cd](https://github.com/Electivus/Apex-Log-Viewer/commit/b08d9cdae75bca7c47f19e2a2a0296ebbf440589))
- **releases:** remove redundant release-flags workflow ([40a7084](https://github.com/Electivus/Apex-Log-Viewer/commit/40a7084a9ac02ccf8cf505276339da0550fbbe6a))
- **releases:** set GH_TOKEN for gh cli in package/publish jobs ([de3bb37](https://github.com/Electivus/Apex-Log-Viewer/commit/de3bb3777fec3c771a4f0b53ad6e637c34e57511))
- run packaging on release event and tags ([a2fc375](https://github.com/Electivus/Apex-Log-Viewer/commit/a2fc3753bf99ec19e24583e5ae0f50a957dd4dda))
- switch to tag-based releases + auto changelog; remove Release Please ([#17](https://github.com/Electivus/Apex-Log-Viewer/issues/17)) ([b441b2e](https://github.com/Electivus/Apex-Log-Viewer/commit/b441b2e683f621a5ea4850517b1f92623d3b6ad5))

### Tests

- run unit/integration via scoped config; fail on zero tests ([bd6e4f6](https://github.com/Electivus/Apex-Log-Viewer/commit/bd6e4f658954761528def709b68c855d1fc88de8))
- **runner:** harden VS Code tests; docs and CI updates ([#16](https://github.com/Electivus/Apex-Log-Viewer/issues/16)) ([c4f92b9](https://github.com/Electivus/Apex-Log-Viewer/commit/c4f92b92dabc9a447a55f95b29dbc5214617d4d6))

### Chores

- migrate to numeric pre-release scheme (odd minor) ([ad2c6a0](https://github.com/Electivus/Apex-Log-Viewer/commit/ad2c6a0d579a2743f192e2554d6dcede960a00fb))
- start pre-release 0.3.1 ([557efc3](https://github.com/Electivus/Apex-Log-Viewer/commit/557efc3ea9fef86617c0bd6edcab965aad8b3b8a))
- trigger release 0.2.1 ([7848c62](https://github.com/Electivus/Apex-Log-Viewer/commit/7848c62f2a2e5a2c7ba189b73077150cd31498fc))

## [0.3.1](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.2.1...v0.3.1) (2025-08-30)

### Miscellaneous Chores

- start pre-release 0.3.1 ([557efc3](https://github.com/Electivus/Apex-Log-Viewer/commit/557efc3ea9fef86617c0bd6edcab965aad8b3b8a))

## [0.2.1](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.2.0...v0.2.1) (2025-08-30)

### Miscellaneous Chores

- trigger release 0.2.1 ([7848c62](https://github.com/Electivus/Apex-Log-Viewer/commit/7848c62f2a2e5a2c7ba189b73077150cd31498fc))

## Changelog

This file is maintained manually. Keep entries concise and follow Semantic Versioning.
