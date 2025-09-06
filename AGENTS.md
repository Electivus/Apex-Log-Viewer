# GitHub Copilot Instructions for Apex Log Viewer

This document guides AI agents (e.g., GitHub Copilot, ChatGPT) to contribute safely and effectively to Apex Log Viewer while we migrate the webview UI from React to Lightning Web Components Open Source (LWC OSS).

## Agent Behavior

- Be incremental: propose small, reviewable changes; produce focused diffs.
- Preserve existing architecture and style; avoid unnecessary rewrites.
- Prefer best practices; refactor when it reduces complexity or risk.
- Summarize approach and impact briefly before larger edits.
- Do not add dependencies or tooling without clear justification.
- Respect CSP and webview security; never use unsafe `innerHTML`.

## Project Overview

Visual Studio Code extension to browse, filter, open, tail, and debug Salesforce Apex logs. Fast UI inside a VS Code webview, with Apex Replay Debugger integration.

- Publisher: `electivus`
- Package name: `apex-log-viewer`
- License: MIT
- Marketplace: https://marketplace.visualstudio.com/items?itemName=electivus.apex-log-viewer
- Requirements: VS Code 1.90+, Salesforce CLI (`sf`) with legacy `sfdx` as a fallback

## Architecture

### Core Technologies

- TypeScript (Node 20+)
- VS Code Extension API (extension host)
- Salesforce CLI (`sf`) with fallback to `sfdx`
- `@salesforce/core` and `@salesforce/apex-node` (Streaming + logs)
- Native HTTPS for REST/Tooling API (no axios)
- Bundling with `esbuild` (extension and current React webviews)
- i18n with `vscode-nls` (`vscode-nls-dev` for extraction)
- Webview UI: currently React; migrating to LWC OSS (https://lwc.dev/)

### Layout

- `src/extension.ts`: activation and registration of views/commands.
- `src/provider/`: webview providers and diagram panel.
  - `src/provider/SfLogsViewProvider.ts`: log list + pagination.
  - `src/provider/SfLogTailViewProvider.ts`: real‑time tail via Streaming API.
  - `src/provider/ApexLogDiagramPanel.ts`: diagram panel for a log file.
- `src/shared/`: message contracts and shared types (extension ↔ webview).
- `src/salesforce/`: CLI, HTTP, Streaming, TraceFlags integrations.
- `src/utils/`: logger, NLS, webview HTML builder, workspace helpers, limiter, tailService.
- `src/webview/`: current React UI (to be migrated to LWC OSS).
- `media/`: emitted webview bundles (`main.js`, `tail.js`, `diagram.js`).

### Main Components

1) Extension host (Node)
- Commands: `sfLogs.refresh`, `sfLogs.selectOrg`, `sfLogs.tail`, `sfLogs.showDiagram`, `sfLogs.showOutput`.
- CLI: `src/salesforce/cli.ts` resolves login‑shell PATH, prefers `sf`, falls back to `sfdx`.
- HTTP: `src/salesforce/http.ts` handles REST/Tooling with 401 refresh; short‑TTL caching.
- Streaming: `src/salesforce/streaming.ts` subscribes to `/systemTopic/Logging` via `StreamingClient`.
- TraceFlags: `src/salesforce/traceflags.ts` lists levels and ensures a user TraceFlag.
- Tail: `src/utils/tailService.ts` manages streaming, saving logs, and emitting webview events.

2) Webviews (UI)
- Today React in `src/webview/` (Logs, Tail, Diagram)
- Planned migration to LWC OSS keeping the same message protocol.
- HTML + CSP via `buildWebviewHtml` (strict CSP; assets via `asWebviewUri`).
 - Theming (phase 1): use LWC default look with a fixed white background; do not consume VS Code theme tokens yet.

## Command/CLI Patterns

- Prefer modern `sf` CLI; keep the existing fallback to `sfdx` where implemented.
- Use helpers (`getOrgAuth`, `listOrgs`) rather than spawning processes directly.
- Handle timeouts and ENOENT with friendly messages.
- Replay Debugger launch already tries `sf.launch.replay.debugger.logfile` then falls back to `sfdx.launch.replay.debugger.logfile`.

## TypeScript Conventions

- Shared types in `src/shared/types.ts`.
- Message contracts in `src/shared/messages.ts`.
- Logging via `logInfo`, `logWarn`, `logError`, `logTrace`; respect `sfLogs.trace`.
- User‑facing strings should use `localize(...)`.

### Message Contracts (summary)

File: `src/shared/messages.ts`
- Webview → Extension: `ready`, `refresh`, `getOrgs`, `selectOrg`, `openLog`, `replay`, `loadMore`, `tailStart`, `tailStop`, `tailClear`.
- Extension → Webview: `loading`, `error`, `init`, `logs`, `appendLogs`, `logHead`, `orgs`, `debugLevels`, `tailStatus`, `tailData`, `tailReset`, `tailConfig`, `tailNewLog`.

When adding messages, update both sides and add a focused unit test.

## Performance Best Practices

- Concurrency: use `createLimiter` and respect `sfLogs.headConcurrency` (1–20).
- Pagination: `sfLogs.pageSize` (10–200) with `appendLogs` for infinite scroll.
- Caching: short TTL list cache in `http.ts`; clear via `clearListCache()` on major refresh.
- Avoid blocking operations; keep CLI/HTTP async; no unnecessary sleeps.

## Security & Privacy

- Strict CSP via `buildWebviewHtml`; do not inject raw HTML.
- Never log access tokens; avoid sensitive data in messages.
- Always load assets via `webview.asWebviewUri(...)`.
- Do not bypass the extension host with direct webview network calls for org data.
 - Telemetry: keep events minimal and anonymous; never include source code, Apex log content, or identifiers that can directly identify a user/org.

## User Settings (package.json)

- `sfLogs.pageSize`: page size for log list (default 100).
- `sfLogs.headConcurrency`: parallel head fetches (default 5).
- `sfLogs.saveDirName`: folder to save `.log` files (default `apexlogs`).
- `sfLogs.trace`: enable verbose trace output.
- `sfLogs.tailBufferSize`: max lines held in Tail (1k–200k).

## UX Overview

- Logs list: search, filters (User, Operation, Status, Code Unit), sorting, infinite scroll.
- Row actions: open `.log` or start Apex Replay Debugger.
- Tail: start/stop, filter `USER_DEBUG`, auto‑scroll, optional colorization, open/replay selected log.
- Diagram: side panel rendering a log graph locally.

## React → LWC OSS Migration

Goal: replace React webviews with LWC OSS without changing the message protocol or core UX.

General guidance
- Use LWC OSS (not Lightning Platform). Docs: https://lwc.dev/ and https://github.com/salesforce/lwc
- Keep the message protocol in `src/shared/messages.ts` unchanged.
- Reuse the same HTML/CSP through `buildWebviewHtml`; only the bundle script changes.
 - Theming (phase 1): default LWC styling with a fixed light theme (white webview background). Do NOT use `var(--vscode-*)` tokens yet.
 - Theming (phase 2): re‑introduce VS Code theme tokens and dynamic theming once LWC is stable.
- Avoid heavy UI dependencies; prefer lean lists or simple chunking for large data.

Component mapping (suggested)
- React → LWC
  - `Toolbar` → `<apex-toolbar>`
  - `LogsTable`/`LogsHeader`/`LogRow` → `<apex-logs>` (+ child pieces)
  - `LoadingOverlay` → `<apex-loading>`
  - `TailToolbar`/`TailList` → `<apex-tail>` (+ child pieces)
  - Icons/Buttons → lightweight LWC components or inline SVG (CSP‑safe)

LWC OSS structure (suggested)
- Create `src/webview/lwc/` with modules like `modules/apex/toolbar`, `modules/apex/logs`, `modules/apex/tail`.
- Add a small bootstrap (e.g., `src/webview/lwc/index.ts`) that mounts the root component into `#root` and exposes `initialize(data)` / `handleMessage(type, data)` to route webview messages.
- Bundling: prefer Rollup with `@lwc/rollup-plugin` for webviews; keep `esbuild` for the Node host. If using an alternative integration, justify and document it. Emit bundles to `media/` as `main.js`, `tail.js`, `diagram.js` to avoid touching providers.

Messaging in LWC
- Webview → Extension: `window.acquireVsCodeApi().postMessage({ type, ... })` (unchanged).
- Extension → Webview: `panel.webview.postMessage({ type, data })` (unchanged).
- The LWC root must implement `initialize(data)` and `handleMessage(type, data)`.

Acceptance criteria
- Functional parity with current React UI (list, filters, sorting, pagination, open/replay; tail features; diagram panel).
- Same view IDs (`sfLogViewer`, `sfLogTail`) and commands; only swap bundle filenames if needed.
- Equal or better performance for large lists and continuous tailing.
- CSP‑safe; no security regressions.
- Existing tests pass; add targeted tests for the LWC bootstrap where appropriate.
 - Theming (phase 1): fixed light theme with white background is acceptable; VS Code theming postponed.

## Errors & UX Patterns

- Show user‑friendly errors via the `error` message; send technical details to the Output channel.
- Apex Replay: first try `sf.launch.replay.debugger.logfile`, then fall back to `sfdx.launch.replay.debugger.logfile`.
- Save logs under `sfLogs.saveDirName` and open with preview.

## Testing & Quality

- Use `@vscode/test-electron` with Mocha; see `docs/TESTING.md` and `package.json` scripts.
- Add unit tests close to the code you change; for webviews, test the bootstrap and message routing.
- Lint with ESLint and format with Prettier. Do not change rules without discussion.
- Use npm scripts (`npm run build`, `npm run test:unit`, `npm run test:integration`); this repo uses npm (see `package-lock.json`).

## Common Contribution Flows

Add a new Webview ↔ Extension message
1. Update types in `src/shared/messages.ts`.
2. Implement handler in the corresponding provider (`SfLogsViewProvider` / `SfLogTailViewProvider`).
3. Handle it in the webview (current React or future LWC).
4. Add a focused unit test.

Add a new filter/column to the logs list
1. Ensure the data exists in `ApexLogRow` (Tooling API query) or can be derived.
2. Update UI and sorting; keep large‑list performance.
3. If you need head data, reuse `fetchApexLogHead` and the `Limiter`.

Improve Tail
1. Keep logic in `TailService`; avoid spreading it across providers.
2. Handle reconnects and failures with minimal UI noise; show details in Output.

## Copilot Tips

- Prefer small, same‑file changes when possible.
- Reuse existing utilities (logger, limiter, localize, webviewHtml, workspace).
- Plan the LWC migration as incremental modules; keep bundle names/IDs.
- Avoid heavy UI dependencies; justify before proposing any.
- Generate snippets that respect `messages.ts` and `types.ts`.

## References

- LWC OSS: https://github.com/salesforce/lwc
- LWC Docs: https://lwc.dev/
- Differences (Platform vs OSS): https://developer.salesforce.com/blogs/2019/06/differences-between-building-lightning-web-components-on-lightning-platform-and-open-source
- VS Code Webviews: https://code.visualstudio.com/api/extension-guides/webview
