# Issue 692 Design: Shared Runtime Cached-Log Lookup

## Summary

Issue [#692](https://github.com/Electivus/Apex-Log-Viewer/issues/692) is still open because the extension-side `findExistingLogFile()` helper performs a recursive tree walk to locate a single `<logId>.log` file. That work happens on a hot path and repeats across bulk log operations. The chosen design is to move extension log-path resolution onto the shared runtime path through a new JSON-RPC endpoint, while also tightening the underlying `alv-core` lookup algorithm so the shared resolver no longer scans arbitrary subtrees on every request.

## Goals

- Stop repeated whole-tree scans for single-log lookups.
- Keep lookup behavior compatible with both org-first and legacy flat cache layouts.
- Make the extension reuse the shared runtime lookup instead of maintaining a separate primary implementation.
- Preserve scoped lookup semantics so a username-scoped request does not leak into another org tree.
- Keep the public extension behavior unchanged for log open/download workflows.

## Non-Goals

- No persistent on-disk index for cached logs in this change.
- No change to the canonical cache layout under `apexlogs/orgs/<safe-org>/logs/<YYYY-MM-DD>/<logId>.log`.
- No refactor of runtime search/triage beyond reusing the same optimized lookup primitives where it is already a fit.
- No requirement that the extension shell out to CLI commands for local cache lookups.

## Chosen Approach

We will implement a new runtime JSON-RPC method, `logs/resolveCachedPath`, and make the extension call that method whenever it needs to locate an already cached log file.

The runtime path will be split into two responsibilities:

- `alv-core` remains the source of truth for lookup semantics and path-resolution rules.
- `alv-app-server` owns a process-lifetime in-memory cache keyed by normalized lookup scope so repeated calls do not keep traversing the filesystem.

The extension will keep the existing `findExistingLogFile(logId, username?)` interface, but the implementation will become:

1. Attempt runtime lookup through `runtimeClient`.
2. Return the resolved path when present.
3. Fall back to the existing local TypeScript lookup only if the runtime is unavailable or the RPC call fails.

This preserves extension resilience while making the shared runtime path the default behavior.

## Architecture

### 1. `alv-core` shared lookup

`alv-core` already exposes `find_cached_log_path(workspace_root, log_id, resolved_username)`. That function will stay as the semantic source of truth, but its internal traversal will be tightened to the known cache layout instead of recursively scanning arbitrary subtrees.

Expected lookup behavior:

- If `resolved_username` is provided:
  - Check `apexlogs/orgs/<safe-username>/logs/<date>/<logId>.log` using a bounded org-first traversal.
  - Fall back to legacy flat files under `apexlogs/`, first `<safe-username>_<logId>.log`, then `<logId>.log`.
  - Never scan other org trees.
- If `resolved_username` is not provided:
  - Search org-first logs across all org directories using the bounded layout.
  - Fall back to legacy flat files under `apexlogs/`, including both bare and username-prefixed files.

The key optimization is that org-first lookup will only inspect the known `logs/<day>/` depth instead of recursively descending unrelated directories.

### 2. `alv-app-server` runtime cache and RPC

`alv-app-server` will add a new operation:

- Method: `logs/resolveCachedPath`
- Params:
  - `logId: string`
  - `username?: string`
  - `workspaceRoot?: string`
- Result:
  - `{ path?: string }`

The app server will normalize the lookup key as:

- effective workspace root
- normalized username scope
- log id

The server process will cache resolved hits for the lifetime of the daemon:

- hit: resolved absolute file path

Misses will still use the bounded shared lookup, but they will not be memoized because the extension can create a log file locally later in the same daemon session. This keeps repeated successful lookups cheap without introducing stale negative entries.

### 3. Extension integration

`RuntimeClient` will gain a typed helper, for example `resolveCachedLogPath(params, signal?)`.

Extension consumers that need a local cached log path will move to the runtime contract:

- `src/utils/workspace.ts`
- `src/services/logService.ts`
- any other direct callers of `findExistingLogFile()` that currently depend on local filesystem walking

`findExistingLogFile()` will remain the compatibility surface for extension callers, but its primary implementation path will be runtime-backed.

### 4. Fallback behavior

If the runtime is unavailable, restarting, or returns an error, the extension will fall back to its local TypeScript lookup logic.

Fallback rules:

- Preserve the current no-side-effects behavior: lookup must not create `apexlogs/`.
- Preserve username-scoped isolation.
- Keep the fallback conservative and semantically aligned, but it does not need its own in-memory session cache because it is now the exception path.

## Data Flow

### Cached log lookup from the extension

1. Extension code asks for `findExistingLogFile(logId, username?)`.
2. `findExistingLogFile()` calls `runtimeClient.resolveCachedLogPath({ logId, username, workspaceRoot })`.
3. `RuntimeClient` sends `logs/resolveCachedPath` to the daemon.
4. `alv-app-server` checks its session cache.
5. On cache miss, `alv-app-server` delegates to `alv-core::find_cached_log_path(...)`.
6. The daemon returns `{ path }` or `{}`.
7. The extension uses the returned path, or falls back locally if the RPC path was unavailable.

## Error Handling

- Empty or whitespace `logId` returns no path.
- Username-scoped requests do not leak into another org tree.
- Runtime transport errors do not block the user; they trigger the local fallback path.
- Cached hits live only for the daemon session, so restarting the runtime naturally invalidates stale paths.

## Testing Strategy

### `alv-core`

- Extend `log_store_layout` coverage for the optimized bounded traversal.
- Add tests that confirm scoped lookups do not traverse unrelated org directories.
- Add tests for legacy flat fallback after org-first miss.

### `alv-app-server`

- Add a JSON-RPC smoke test for `logs/resolveCachedPath`.
- Add coverage that repeated identical requests can reuse cached hits without changing behavior.

### Extension

- Update or add tests so `findExistingLogFile()` prefers the runtime-backed path.
- Add coverage for runtime failure fallback to local lookup.
- Update `logService` and related tests where the lookup dependency changes from local-first to runtime-first.

## Verification Plan

Before implementation is considered complete, the change must be verified with at least:

- focused Rust tests for `alv-core` log-store lookup
- focused app-server smoke coverage for the new RPC route
- extension integration coverage including `integration: findExistingLogFile`
- repository typecheck/build commands required by the touched code paths

## Alternatives Considered

### Keep two optimized implementations

This would optimize the extension and `alv-core` separately, but it keeps two primary lookup implementations alive. It improves performance, but not alignment.

### Build a persistent log index

This could further reduce lookup cost in very large caches, but it adds invalidation, persistence, and migration complexity that is not required to resolve issue `#692`.

### Force all log lookup through user-facing CLI commands

This would move logic out of the extension, but it conflicts with the repository’s runtime strategy and adds avoidable coupling to shell execution.

## Implementation Notes

- Prefer adding the new RPC shape to `packages/app-server-client-ts` first so both sides share the contract.
- Keep the new runtime method narrowly scoped to path resolution only; downloading missing logs remains a separate concern.
- Preserve the existing TypeScript function signatures where possible so the migration is mostly internal.
