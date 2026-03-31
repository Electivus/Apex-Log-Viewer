# Architecture

This document explains the internal structure of the Apex Log Viewer extension and how its major pieces interact.

## High-level overview

The extension has two main sides:

1. **Extension host** – runs in Node.js inside VS Code and handles commands, log retrieval, and runtime communication with Salesforce via jsforce-backed API calls.
2. **Webview UI** – a React application bundled to `media/main.js` and rendered inside a VS Code webview. It presents logs, filters, and user interactions.

Both sides exchange messages using the `vscode` webview API with shared TypeScript interfaces defined in `src/shared`.

## Extension host

The activation entry point is `src/extension.ts`. It registers commands such as `sfLogs.refresh` and sets up the log explorer webview provider under `src/provider/`.

Key responsibilities:

- Use Salesforce CLI (`sf` or legacy `sfdx`) to discover authenticated orgs and reuse existing auth.
- Use jsforce-backed REST/Tooling/Streaming API calls for runtime log retrieval, tailing, and debug-flag management.
- Maintain per-org state such as selected org and log cache.
- Forward trace output to the "Electivus Apex Log Viewer" output channel when `electivus.apexLogs.trace` is enabled.

## Webview UI

The React-based UI lives under `src/webview/`. It renders the log table, search box, filters, and action buttons. The bundle is produced by `esbuild` and emitted to `media/main.js` during builds.

Messages from the extension arrive via `onDidReceiveMessage` and are dispatched to React components through a small reducer. User actions (refresh, open, tail) send messages back to the extension.

## Shared types and utilities

- `src/shared/` – TypeScript declarations for messages and data models shared by the extension and webview.
- `src/utils/` – helper functions such as `localize.ts` for NLS and `limiter.ts` for concurrency control.

## Runtime bundle and release trains

The VS Code extension and the standalone Rust CLI now follow separate release trains.

- The extension packaging flow consumes `config/runtime-bundle.json` as pinned runtime metadata, so the bundled executable comes from a tested CLI release instead of an arbitrary workspace build.
- The runtime bundle lets maintainers keep the VS Code extension channel and the CLI release channel independent while still shipping a predictable executable with the extension.
- Local developer overrides can still point the extension at a manually supplied executable, but release packaging uses the pinned bundle metadata by default.

## Shared local log storage

The standalone CLI and the VS Code extension are separate surfaces over the same shared runtime architecture. Local Apex log storage is now evolving toward an org-first `apexlogs/` layout:

- `apexlogs/.alv/version.json` stores the local layout version.
- `apexlogs/.alv/sync-state.json` stores incremental sync checkpoints by org.
- `apexlogs/orgs/<safe-target-org>/org.json` stores resolved org metadata.
- `apexlogs/orgs/<safe-target-org>/logs/<YYYY-MM-DD>/<logId>.log` stores full log bodies.

The Rust CLI is the first consumer of that shared storage through `apex-log-viewer logs sync`, `logs status`, and `logs search`, while the runtime still reads the legacy flat cache layout during the transition so the extension remains compatible.

## Testing and build tooling

- Tests live in `src/test/` and are compiled to `out/test/`. The `scripts/run-tests.js` script orchestrates unit and integration tests.
- `npm run build` compiles the extension and bundles the webview.

## Data flow summary

1. The user triggers a command (e.g., refresh).
2. The extension resolves the selected org via Salesforce CLI-backed auth reuse and then queries Salesforce through jsforce.
3. Results are sent to the webview over the messaging channel.
4. The React UI updates the table and exposes actions like open or tail.
5. Actions from the UI send messages back to the extension for further processing.
