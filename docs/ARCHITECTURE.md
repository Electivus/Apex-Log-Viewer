# Architecture

This document explains the internal structure of the Apex Log Viewer extension and how its major pieces interact.

## High-level overview

The extension has two main sides:

1. **Extension host** – runs in Node.js inside VS Code and handles commands, log retrieval, and communication with Salesforce CLI.
2. **Webview UI** – a React application bundled to `media/main.js` and rendered inside a VS Code webview. It presents logs, filters, and user interactions.

Both sides exchange messages using the `vscode` webview API with shared TypeScript interfaces defined in `src/shared`.

## Extension host

The activation entry point is `src/extension.ts`. It registers commands such as `sfLogs.refresh` and sets up the log explorer webview provider under `src/provider/`.

Key responsibilities:

- Execute Salesforce CLI commands (`sf` or `sfdx`) to list, tail, and download logs.
- Maintain per-org state such as selected org and log cache.
- Forward trace output to the "Apex Log Viewer" output channel when `sfLogs.trace` is enabled.

## Webview UI

The React-based UI lives under `src/webview/`. It renders the log table, search box, filters, and action buttons. The bundle is produced by `esbuild` and emitted to `media/main.js` during builds.

Messages from the extension arrive via `onDidReceiveMessage` and are dispatched to React components through a small reducer. User actions (refresh, open, tail) send messages back to the extension.

## Shared types and utilities

- `src/shared/` – TypeScript declarations for messages and data models shared by the extension and webview.
- `src/utils/` – helper functions such as `localize.ts` for NLS and `limiter.ts` for concurrency control.

## Testing and build tooling

- Tests live in `src/test/` and are compiled to `out/test/`. The `scripts/run-tests.js` script orchestrates unit and integration tests.
- `npm run build` compiles the extension and bundles the webview.

## Data flow summary

1. The user triggers a command (e.g., refresh).
2. The extension invokes the Salesforce CLI to fetch log metadata.
3. Results are sent to the webview over the messaging channel.
4. The React UI updates the table and exposes actions like open or tail.
5. Actions from the UI send messages back to the extension for further processing.
