# New Window Launch Support Design

## Goal

Allow the extension to reopen the current workspace in a new VS Code window and automatically restore a requested Apex Logs surface there, so developers can move log workflows onto another monitor without manually reopening the same tools.

The first version should support these surfaces:

- the main `Electivus Apex Logs` view
- the `Electivus Apex Logs Tail` view
- the `Debug Flags` panel
- a specific `Open Log View` panel for an Apex log file

## Context

The extension already has two kinds of UI hosts:

- sidebar or panel webviews registered through `WebviewViewProvider`
- free-floating `WebviewPanel` instances such as `LogViewerPanel` and `DebugFlagsPanel`

Today these surfaces can be opened in the current window only. The logs view and tail view are revealed by commands in `src/extension.ts`, while the log viewer and debug flags panel are opened directly through extension-side helpers.

VS Code's public extension API does not expose the same internal "move this widget into an auxiliary window" mechanism used by built-in chat features. Public extensions can, however, open the current workspace in another window with `vscode.openFolder(..., { forceNewWindow: true })` and then restore their own state there.

That means the correct public-API equivalent is:

1. persist a short-lived launch intent in the current window
2. open the same workspace in a new window
3. let the new window consume that intent and restore the requested surface

## Approved UX Decisions

- Use explicit `Open ... in New Window` commands instead of `Move ...`.
- Support multiple surfaces through one shared launch infrastructure rather than separate ad-hoc implementations.
- Reopen the same workspace in a new window and restore the requested surface there.
- Carry the currently selected org when available so the new window feels ready immediately.
- Keep the first version focused on extension-host orchestration and unit coverage; do not require a new E2E suite.

## Non-Goals

The first version does not attempt to:

- move an already-open webview or panel instance across windows
- preserve arbitrary in-memory UI state beyond the selected org and the requested launch target
- synchronize both windows after launch
- introduce a generic cross-extension transport mechanism beyond what this extension needs

## Architecture

Add a dedicated extension-host service, tentatively `NewWindowLaunchService`, with two responsibilities:

- `launchInNewWindow(request)` persists a short-lived launch request and opens the current workspace in a new window
- `consumePendingLaunch(handlers)` validates and consumes a pending request during activation of the new window

This service should live outside `extension.ts` so launch persistence, validation, and consumption rules remain isolated and testable.

### Launch Request Model

Persist one short-lived request in `ExtensionContext.globalState`. The payload should be typed and explicit:

- `version`: numeric schema version for future evolution
- `kind`: `'logs' | 'tail' | 'debugFlags' | 'logViewer'`
- `workspaceUri`: string form of the current workspace URI
- `selectedOrg?`: current selected org username when known
- `logId?`: required for `logViewer`
- `filePath?`: required for `logViewer`
- `sourceView?`: optional source surface metadata such as `'logs' | 'tail'`
- `createdAt`: epoch milliseconds
- `nonce`: unique per-request value

The service stores a single pending request under one key such as `pendingNewWindowLaunch`.

### Why `globalState`

`globalState` is the safest fit for this workflow because:

- it survives the transition from one VS Code window process to another
- it is already available during activation
- it avoids introducing temp files or OS-specific IPC

The design assumes only one active pending launch at a time for this extension. A newer request replaces an older one.

## Supported Launch Kinds

### `logs`

Restores the main logs surface by running the same reveal flow already used by `sfLogs.refresh`:

1. open the `salesforceLogsPanel` container
2. open the `sfLogViewer` view
3. restore `selectedOrg` when present
4. trigger the same refresh behavior used for normal logs opening

### `tail`

Restores the tail workflow by:

1. opening the `salesforceTailPanel` container
2. opening the `sfLogTail` view
3. restoring `selectedOrg` when present
4. invoking the same tail-start behavior already used by the current tail command

### `debugFlags`

Restores the existing `DebugFlagsPanel` in the new window with:

- restored `selectedOrg` when present
- source metadata preserved when already tracked by current open helpers

### `logViewer`

Restores a specific saved Apex log in the new window by reopening `LogViewerPanel` with:

- `logId`
- `filePath`
- restored `selectedOrg` when present so follow-up actions in that window keep the same org context

`logViewer` requires both `logId` and `filePath`. Missing fields make the request invalid.

## Launch Flow

When the user invokes one of the new commands:

1. validate that a workspace or folder is open
2. build a typed request from current context
3. persist it to `globalState`
4. call `vscode.commands.executeCommand('vscode.openFolder', workspaceUri, { forceNewWindow: true })`

The command should fail early with a friendly message when no workspace is open, because there is no reliable target window to recreate otherwise.

## Consume Flow

During extension activation, after core providers and panels are initialized, call `consumePendingLaunch(...)`.

The consumer should:

1. read the pending request
2. validate schema version and `kind`
3. reject stale requests older than a short TTL such as 60 seconds
4. reject requests whose `workspaceUri` does not match the current workspace
5. remove the request from storage before executing any launch handler
6. restore `selectedOrg` when present
7. dispatch to the matching surface handler

Removing the request before execution prevents repeated launches on reload or recovery from a partial failure.

## Surface Handlers

The launch service should not know concrete UI internals. Instead, `extension.ts` should pass small handlers into `consumePendingLaunch(...)`.

Expected handlers:

- `openLogs(selectedOrg?)`
- `openTail(selectedOrg?)`
- `openDebugFlags(selectedOrg?)`
- `openLogViewer({ logId, filePath, selectedOrg? })`

This keeps the service generic while allowing each target to reuse existing extension code paths.

## Command Surface

Add four user-facing commands:

- `Electivus Apex Logs: Open Logs in New Window`
- `Electivus Apex Logs: Open Tail in New Window`
- `Electivus Apex Logs: Open Debug Flags in New Window`
- `Electivus Apex Logs: Open Log Viewer in New Window`

### Menu Placement

Place the commands where the user already works:

- logs view title menu: `Open Logs in New Window`
- tail view title menu: `Open Tail in New Window`
- debug flags panel title menu: `Open Debug Flags in New Window`
- editor title or related log-viewer entry points: `Open Log Viewer in New Window`

The labels should stay explicit about opening a new window rather than moving the current one.

## Org Restoration Rules

If `selectedOrg` is present in the request, restore it into the new window before opening the target surface.

Fallback behavior:

- if the org no longer exists or is invalid, do not block the launch
- allow the current `OrgManager` default-selection logic to take over
- keep the failure silent unless the specific target action later needs to surface an org-related error

This preserves fast startup and avoids turning a convenience action into a hard failure.

## Failure and Degradation Behavior

The launch infrastructure should be additive and resilient.

- No workspace open: show a clear warning and do not persist a request.
- `vscode.openFolder` fails: keep the request from becoming orphaned by clearing it or overwriting it on next launch attempt.
- Stale request on activation: ignore and clear it.
- Request for another workspace: ignore and clear it.
- Surface restoration failure in the new window: keep the new workspace window open and show a short error message describing which surface could not be restored.
- Missing log file for `logViewer`: fail only that restoration path and show a targeted error.

The extension should never get stuck in a reopen loop.

## Telemetry Expectations

If telemetry is extended for this feature, keep it coarse and aligned with existing patterns. Useful events would be:

- launch request created
- launch restore succeeded
- launch restore failed

Do not add raw file paths, log bodies, or org names to telemetry payloads.

## Testing Strategy

Implementation planning should cover these unit and behavior tests.

### `NewWindowLaunchService`

- stores a valid request for each supported `kind`
- refuses to launch when there is no workspace URI
- clears stale or mismatched requests
- validates `logViewer` required fields
- clears the pending request before executing handlers
- dispatches only one handler for a valid request

### Extension integration

- `Open Logs in New Window` stores a `logs` request and calls `vscode.openFolder(..., { forceNewWindow: true })`
- `Open Tail in New Window` stores a `tail` request and calls `vscode.openFolder(..., { forceNewWindow: true })`
- `Open Debug Flags in New Window` stores a `debugFlags` request and calls `vscode.openFolder(..., { forceNewWindow: true })`
- `Open Log Viewer in New Window` stores the correct `logViewer` request with `logId` and `filePath`
- activation consumes and restores each supported `kind`
- activation restores `selectedOrg` before dispatch when present

### Existing surface contracts

- logs restore still uses the same view-opening fallback behavior already used by the refresh command
- tail restore still uses the same tail-start flow
- log viewer restore still routes through `LogViewerPanel`
- debug flags restore still routes through `DebugFlagsPanel`

The first implementation does not require Playwright or VS Code integration coverage. The critical risk is command orchestration and request validation, which are better handled by deterministic unit tests.

## Scope Boundaries

In scope:

- a shared new-window launch service
- four new user-facing commands
- restoration of selected org context
- startup consumption of pending launch requests
- unit and behavior tests for launch persistence and restoration

Out of scope:

- generic persistence of view-local filters, searches, or scroll positions
- multi-request queues
- cross-window synchronization after restore
- built-in-style auxiliary window migration via internal VS Code APIs
