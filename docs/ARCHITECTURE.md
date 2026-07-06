# Architecture

This document explains the internal structure of the Apex Log Viewer extension and how its major pieces interact.

## High-level overview

The extension has two main sides:

1. **Extension host** – runs in Node.js inside VS Code and handles commands, webview orchestration, local search/tail behavior, and calls into the bundled `sf electivus` plugin runner for Salesforce-backed operations.
2. **Webview UI** – a React application bundled to `media/main.js` and rendered inside a VS Code webview. It presents logs, filters, and user interactions.

Both sides exchange messages using the `vscode` webview API with shared TypeScript interfaces defined in `src/shared`.

## Extension host

The activation entry point is `src/extension.ts`. It registers commands such as `sfLogs.refresh` and sets up the log explorer webview provider under `src/provider/`.

Key responsibilities:

- Use the bundled `sf electivus` plugin runner for org discovery/auth, log list/sync/read/resolve/delete, triage, users, trace flags, debug levels, and Tooling API calls.
- Keep local full-log search and tail streaming in the extension where they depend on VS Code UI state, ripgrep, or long-lived provider lifecycle.
- Maintain per-org state such as selected org and log cache.
- Forward trace output to the "Electivus Apex Log Viewer" output channel when `electivus.apexLogs.trace` is enabled.

## Webview UI

The React-based UI lives under `src/webview/`. It renders the log table, search box, filters, and action buttons. The bundle is produced by `esbuild` and emitted to `media/main.js` during builds.

Messages from the extension arrive via `onDidReceiveMessage` and are dispatched to React components through a small reducer. User actions (refresh, open, tail) send messages back to the extension.

## Shared types and utilities

- `src/shared/` – TypeScript declarations for messages and data models shared by the extension and webview.
- `src/utils/` – helper functions such as `localize.ts` for NLS and `limiter.ts` for concurrency control.

## Embedded plugin runner

The extension packages a CommonJS runner generated from `packages/sf-plugin/src/embedded.ts` into `apps/vscode-extension/sf-plugin/electivus-runner.cjs`. The extension never imports the plugin into its own bundle; it spawns a separate Node.js process with:

```text
process.execPath apps/vscode-extension/sf-plugin/electivus-runner.cjs <command> --json
```

The client in `apps/vscode-extension/src/runtime/runtimeClient.ts` maps extension calls to plugin command arguments, parses stdout JSON, aborts child processes when callers cancel, and emits `sfPlugin.request` telemetry. The exported `runtimeClient` name is kept as an internal compatibility alias while the implementation is the plugin client.

## Shared local log storage

The Salesforce CLI plugin and the VS Code extension are separate surfaces over the same TypeScript plugin core. Local Apex log storage uses the org-first `apexlogs/` layout:

- `apexlogs/.alv/version.json` stores the local layout version.
- `apexlogs/.alv/sync-state.json` stores incremental sync checkpoints by org.
- `apexlogs/orgs/<safe-target-org>/org.json` stores resolved org metadata.
- `apexlogs/orgs/<safe-target-org>/logs/<YYYY-MM-DD>/<logId>.log` stores full log bodies.

The `sf electivus` plugin exposes that shared storage through `sf electivus logs sync` and `logs status`. The VS Code Logs panel invokes the embedded plugin runner for refresh/load-more/sync/triage/cache lookup, starts `logs sync` in the background after refresh/load-more, and performs panel search locally with packaged ripgrep. For `logs sync`, the plugin resolves org metadata/auth through Salesforce CLI/Core and performs the actual list/body fetches directly against the Salesforce Tooling REST API with concurrent body downloads per page.

## Testing and build tooling

- Tests live in `src/test/` and are compiled to `out/test/`. The `scripts/run-tests.js` script orchestrates unit and integration tests.
- `npm run build` compiles the extension and bundles the webview.

## Data flow summary

1. The user triggers a command (e.g., refresh).
2. The extension asks the embedded plugin runner for the visible log rows and posts them to the webview as soon as they arrive.
3. The plugin syncs full log bodies in the background.
4. The React UI updates the table and exposes actions like open or tail.
5. Search reuses local files directly in the extension, while error triage reuses synced bodies through the plugin instead of re-downloading rows already present locally.
