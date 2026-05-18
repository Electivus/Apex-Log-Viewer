# Remove SQLite Log Index Design

## Context

The shared Rust runtime currently maintains a SQLite/FTS index at
`apexlogs/.alv/log-index.sqlite` for synced Apex log body search. This adds a
native SQLite dependency through `rusqlite` and `libsqlite3-sys`, creates
additional local state, and exposes index-specific CLI/API fields. The runtime
already has a local file search path that uses the Rust grep matcher stack to
scan saved `.log` files, which is sufficient for the expected Apex log cache
size.

## Goals

- Remove the SQLite requirement from the shared runtime.
- Remove the CLI index surface immediately.
- Remove index-specific JSON fields from shared runtime responses immediately.
- Keep `logs search` working from saved local log bodies.
- Delete legacy SQLite index files during the next `logs sync` execution only.
- Keep CLI and VS Code extension behavior aligned through the shared runtime.

## Non-Goals

- Do not bundle the external `rg` binary in this change.
- Do not add a replacement persistent index.
- Do not preserve compatibility for `logs index rebuild`.
- Do not preserve compatibility for `indexed`, `index_file`, `index_error`,
  or `indexed_count` response fields.
- Do not delete SQLite index files during unrelated runtime operations.

## Design

### Runtime Storage

`logs sync` remains responsible for creating the shared local layout:

- `apexlogs/.alv/version.json`
- `apexlogs/.alv/sync-state.json`
- `apexlogs/orgs/<safe-target-org>/org.json`
- `apexlogs/orgs/<safe-target-org>/logs/<YYYY-MM-DD>/<logId>.log`

The runtime will stop creating `apexlogs/.alv/log-index.sqlite`.

At the start of `logs sync`, after resolving the workspace root and
`apexlogs/.alv` location, the runtime will attempt to delete these legacy files:

- `apexlogs/.alv/log-index.sqlite`
- `apexlogs/.alv/log-index.sqlite-wal`
- `apexlogs/.alv/log-index.sqlite-shm`

Deletion is best effort. Missing files are ignored. Permission or IO failures
do not add response fields, do not update sync-state error fields, and do not
change the sync exit status. The cleanup must not block downloading or searching
logs.

### Search Flow

`search_query` will always use local saved `.log` files:

1. Normalize and deduplicate requested log ids.
2. Resolve the relevant org directory from the canonical username or raw
   username hint.
3. Build an in-memory map from log id to matching local file paths under the
   supported org-first layout.
4. Read each candidate file line by line and use the existing fixed-string,
   case-insensitive grep matcher to find the first matching line.
5. Return matching log ids, snippets, and pending log ids as today.

This removes the SQLite fast path and any partial-index fallback logic. The file
scan becomes the only source of local search truth.

### CLI Contract

Remove:

- `apex-log-viewer logs index rebuild`
- `LogsCommand::Index`
- `LogIndexArgs`, `LogIndexCommand`, and `LogIndexRebuildArgs`
- `IndexRebuildResult`

Update `logs sync --json` to omit:

- `indexed`
- `index_file`
- `index_error`

Update `logs status --json` to omit:

- `indexed_count`
- `index_file`

Human-readable `logs sync` and `logs status` output will also remove index
lines. `logs search` output remains unchanged.

### Shared App Server and TypeScript Client

The app-server `logs/sync` handler will serialize the new `LogsSyncResult`
without index fields. The TypeScript app-server client types will remove the
same fields so VS Code tests and consumers compile against the new contract.

The VS Code extension will stop logging index warnings and stop including
`indexed` in background-sync summaries. No UX control is needed because index
management is no longer user-visible.

### Dependencies

Remove `rusqlite` from `crates/alv-core/Cargo.toml`. After lockfile refresh,
`rusqlite`, `libsqlite3-sys`, `sqlite-wasm-rs`, and SQLite-only transitive
dependencies should disappear from `Cargo.lock` unless another crate still
requires them.

### Documentation

Update architecture and README references so local search is described as a
file-based shared runtime search over synced log bodies. Remove documentation
for `logs index rebuild` and `log-index.sqlite`.

Update the changelog with a user-facing note that the runtime no longer uses
SQLite, and that `logs sync` removes the old local SQLite index files.

## Error Handling

- Missing legacy index files are ignored.
- Cleanup errors are non-fatal and must not prevent sync.
- Search errors still report the file path that failed to open or read.
- Cancellation behavior remains intact for sync and search.

## Testing

Rust tests:

- Verify `logs sync` no longer creates `log-index.sqlite`.
- Verify `logs sync` deletes `log-index.sqlite`, `log-index.sqlite-wal`, and
  `log-index.sqlite-shm` when present.
- Verify `logs search` finds synced local bodies without an index.
- Remove or rewrite `log_index` unit tests and partial-index fallback tests.
- Verify CLI smoke tests no longer expose `logs index rebuild` or index fields.

TypeScript tests:

- Update runtime client sync fixtures and expectations.
- Update Logs provider background-sync stubs and assertions.
- Verify extension behavior no longer depends on `indexed` or `index_error`.

Docs and build verification:

- Run focused Rust and extension/type tests before completion.
- Run `cargo tree -p alv-core -i rusqlite` to confirm no remaining `rusqlite`
  dependency.

## Acceptance Criteria

- `cargo tree -p alv-core -i rusqlite` reports no dependency path.
- `apex-log-viewer logs index rebuild` is no longer accepted.
- `logs sync` succeeds, downloads/caches logs, and does not create a SQLite
  index.
- `logs sync` removes old SQLite index files when they exist.
- `logs search` still returns matches and snippets from local synced logs.
- CLI, app-server, and TypeScript client contracts contain no index-specific
  fields.
