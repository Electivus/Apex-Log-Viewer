# Apex Log Lifecycle design

Status: implemented on 2026-07-20 after scope and behavioral approval.

This document records the module, interface, seam, migration, and verification design used to deepen the shared **Apex Log Lifecycle** in `@alv/core`.

## Outcome

`@alv/core` owns the complete Apex Log Lifecycle from local discovery or Salesforce acquisition through dependable local use. The VS Code extension and Salesforce CLI remain adapters.

The implementation concentrates these behaviors in one long-lived module:

- local-first discovery and reading;
- resolved-org identity and legacy compatibility;
- remote acquisition;
- canonical materialization and atomic writes;
- concurrent acquisition sharing and cancellation;
- incremental sync and checkpoints;
- triage orchestration;
- safe local purge;
- stable errors, provenance, progress, and instrumentation.

VS Code presentation, oclif flags and output, Tail streaming subscriptions, Replay Debugger commands, ripgrep invocation, and webview messages remain outside the module.

## Constraints

Any interface must preserve these agreed invariants:

1. Reads, Open, Replay, search preparation, and triage are local-first. Only an explicit sync or refresh seeks remote freshness.
2. The canonical layout remains `apexlogs/orgs/<safe-resolved-username>/logs/<day>/<logId>.log`.
3. Legacy `<safeUser>_<logId>.log` files remain readable. When resolved username and `StartTime` are known, the implementation opportunistically materializes a canonical copy but retains the legacy file. No third layout is introduced.
4. Every operation receives an explicit absolute workspace root. The module never consults VS Code, `process.cwd()`, or `os.tmpdir()`.
5. A resolved username is the canonical org identity. An alias is only an input selector or presentation value.
6. Concurrent acquisition is shared by `(normalized workspace root, resolved username, log id)`. Each caller cancels independently; shared work is aborted only when it has no observers.
7. Open, Replay, search preparation, sync, and triage require a dependable local path. Tail may still display an acquired body when persistence fails.
8. The module reports acquisition and persistence separately. Adapters decide presentation and error policy.
9. A sync checkpoint advances only after complete success. Files completed before partial failure or cancellation remain usable, and the next sync retries the uncommitted window.
10. Purge owns safe discovery, containment checks, and deletion. The adapter supplies retention policy. Purge never follows symlinks or automatically removes legacy files.
11. The pure triage parser remains a separate in-process module inside the implementation. Filesystem and Salesforce knowledge never enter the parser.
12. Observer failures never affect the Apex Log Lifecycle.

## Dependency categories and seam placement

| Dependency                           | Category            | Placement                                                                |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------ |
| Triage parser                        | In-process          | Private to the implementation and tested directly for parser edge cases  |
| Filesystem                           | Local-substitutable | Private internal seam; interface tests use real temporary directories    |
| Salesforce                           | True external       | One injected `ApexLogRemote` interface with production and fake adapters |
| VS Code                              | Adapter concern     | Outside `@alv/core`                                                      |
| oclif/Salesforce CLI command parsing | Adapter concern     | Outside `@alv/core`                                                      |

The external seam lives in `packages/core`. Product adapters call the lifecycle interface; the implementation calls the injected Salesforce adapter. Filesystem primitives are not exposed merely to make tests convenient.

## Designs compared

### Design A: minimum method count

This design exposes `access`, `sync`, and `purge`. `access` is overloaded for path, body, and triage outputs; `sync` is overloaded for status and refresh.

Its nominal surface is smallest, but method count hides a growing matrix of modes. A caller must learn output selection, persistence policy, local-only behavior, and batch semantics before performing a common Open operation. Treating status as a sync mode is also artificial. The interface is compact in syntax but weaker in leverage.

### Design B: maximum flexibility

This design exposes separate catalog, locate, acquire, bulk acquire, read, sync, triage, status, purge, and remote-deletion methods with detailed consistency and materialization policies.

It accommodates extension easily, but it recreates much of the implementation as caller-visible choices. Adapters can assemble different lifecycles and drift again. This is the shallowest option and provides the least locality.

### Design C: caller-first

This design makes `requireLocalPath` the dominant operation, separates best-effort body reading for Tail, and provides explicit high-level operations for sync, status, triage, and purge.

It has more method names than Design A, but each name represents a distinct caller intent rather than an implementation primitive. Callers do not choose path policy, legacy behavior, write strategy, deduplication, or remote transport. This provides the strongest practical depth.

### Recommendation

Adopt Design C with two evidence-driven refinements:

- retain a local-only batch query for full-log search and the existing `sf electivus log resolve` adapter;
- retain `status` because `sf electivus log status` is a real high-level caller.

These methods earn their place. They avoid forcing callers to encode local-only behavior or to misuse sync/read modes. `log.list` remains in a catalog module, and destructive Salesforce `log.delete` remains in an administration module; neither is local purge.

## Target TypeScript interface

The following types are the proposed external interface. Names may receive mechanical adjustments during implementation, but the semantics and discriminated outcomes are part of the design.

```ts
export type ApexLogLifecycleErrorCode =
  'org-resolution' | 'remote-acquisition' | 'local-persistence' | 'not-found' | 'invalid-log' | 'cancelled';

export type ApexLogLifecycleOperation =
  'require-local-path' | 'available-local-paths' | 'read' | 'sync' | 'status' | 'triage' | 'purge';

export class ApexLogLifecycleError extends Error {
  public readonly name = 'ApexLogLifecycleError';

  public constructor(
    public readonly code: ApexLogLifecycleErrorCode,
    message: string,
    public readonly context: Readonly<{
      operation: ApexLogLifecycleOperation;
      logId?: string;
      resolvedUsername?: string;
    }>,
    cause?: unknown
  ) {
    super(message, { cause });
  }
}

export type ApexLogRef = Readonly<{
  logId: string;
  startTime?: string;
}>;

export type ApexLogScope = Readonly<{
  /** Required, absolute, and never inferred by the module. */
  workspaceRoot: string;

  /** Username, alias, or omitted default; never used directly as identity. */
  targetOrg?: string;
}>;

export type ApexLogStoredProvenance = Readonly<{
  source: 'local' | 'remote';
  persistence: 'existing' | 'written';
  localPath: string;
}>;

export type ApexLogFailedPersistence = Readonly<{
  source: 'local' | 'remote';
  persistence: 'failed';
  localPath?: undefined;
  persistenceError: ApexLogLifecycleError;
}>;

export type ApexLogProvenance = ApexLogStoredProvenance | ApexLogFailedPersistence;

export type ApexLogLocalFile = ApexLogRef &
  ApexLogStoredProvenance &
  Readonly<{
    resolvedUsername: string;
  }>;

export type ApexLogLifecycleEvent = Readonly<{
  operation: ApexLogLifecycleOperation;
  phase:
    | 'started'
    | 'resolving-org'
    | 'checking-local'
    | 'reading-local'
    | 'listing-remote'
    | 'acquiring-remote'
    | 'materializing'
    | 'triaging'
    | 'purging'
    | 'completed';
  logId?: string;
  completed?: number;
  total?: number;
}>;

export type ApexLogCallOptions = Readonly<{
  signal?: AbortSignal;
  observe?: (event: ApexLogLifecycleEvent) => void | PromiseLike<void>;
}>;

export type RequireLocalPathRequest = ApexLogScope &
  Readonly<{
    log: ApexLogRef;
  }>;

export type AvailableLocalPathsRequest = ApexLogScope &
  Readonly<{
    logs: readonly ApexLogRef[];
  }>;

export type ApexLogFailure = Readonly<{
  logId: string;
  error: ApexLogLifecycleError;
}>;

export type AvailableLocalPathsResult = Readonly<{
  available: readonly ApexLogLocalFile[];
  missing: readonly ApexLogRef[];
  failures: readonly ApexLogFailure[];
}>;

export type ReadApexLogRequest = ApexLogScope &
  Readonly<{
    log: ApexLogRef;
    maxBytes?: number;
    /** Defaults to required. Best-effort exists for Tail display. */
    persistence?: 'required' | 'best-effort';
  }>;

export type ApexLogBody = ApexLogRef &
  Readonly<{
    resolvedUsername: string;
    body: string;
    sizeBytes: number;
    truncated: boolean;
  }>;

export type StoredApexLogBody = ApexLogBody & ApexLogStoredProvenance;
export type ReadApexLogResult = ApexLogBody & ApexLogProvenance;

export type SyncApexLogsRequest = ApexLogScope &
  Readonly<{
    mode?: 'incremental' | 'full';
    concurrency?: number;
  }>;

export type SyncApexLogsResult = Readonly<{
  status: 'success' | 'partial';
  resolvedUsername: string;
  existing: number;
  materialized: number;
  downloaded: number;
  failures: readonly ApexLogFailure[];
  checkpoint: Readonly<{
    advanced: boolean;
    lastLogId?: string;
    lastStartTime?: string;
  }>;
}>;

export type ApexLogStatusRequest = ApexLogScope;

export type ApexLogStatusResult = Readonly<{
  resolvedUsername?: string;
  localLogCount: number;
  hasCheckpoint: boolean;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  lastSyncedLogId?: string;
  lastSyncedStartTime?: string;
  lastSync: Readonly<{
    existing: number;
    materialized: number;
    downloaded: number;
    failed: number;
  }>;
}>;

export type ApexLogDiagnostic = Readonly<{
  code: string;
  severity: 'error' | 'warning' | 'info';
  summary: string;
  line?: number;
  eventType?: string;
}>;

export type ApexLogTriageSummary = Readonly<{
  hasErrors: boolean;
  primaryReason?: string;
  reasons: readonly ApexLogDiagnostic[];
}>;

export type TriageApexLogsRequest = ApexLogScope &
  Readonly<{
    logs: readonly ApexLogRef[];
  }>;

export type ApexLogTriageEntry =
  | Readonly<{
      status: 'triaged';
      log: ApexLogRef;
      file: ApexLogLocalFile;
      summary: ApexLogTriageSummary;
    }>
  | Readonly<{
      status: 'failed';
      log: ApexLogRef;
      error: ApexLogLifecycleError;
    }>;

export type TriageApexLogsResult = Readonly<{
  entries: readonly ApexLogTriageEntry[];
}>;

export type PurgeApexLogsRequest = ApexLogScope &
  Readonly<{
    policy: Readonly<{
      maxAgeMs: number;
      keepLogIds?: readonly string[];
    }>;
  }>;

export type PurgeApexLogsResult = Readonly<{
  inspected: number;
  removed: number;
  kept: number;
  failures: readonly ApexLogFailure[];
}>;

export interface ApexLogLifecycle {
  requireLocalPath(request: RequireLocalPathRequest, options?: ApexLogCallOptions): Promise<ApexLogLocalFile>;

  availableLocalPaths(
    request: AvailableLocalPathsRequest,
    options?: ApexLogCallOptions
  ): Promise<AvailableLocalPathsResult>;

  read(
    request: ReadApexLogRequest & { persistence?: 'required' },
    options?: ApexLogCallOptions
  ): Promise<StoredApexLogBody>;

  read(
    request: ReadApexLogRequest & { persistence: 'best-effort' },
    options?: ApexLogCallOptions
  ): Promise<ReadApexLogResult>;

  sync(request: SyncApexLogsRequest, options?: ApexLogCallOptions): Promise<SyncApexLogsResult>;

  status(request: ApexLogStatusRequest, options?: ApexLogCallOptions): Promise<ApexLogStatusResult>;

  triage(request: TriageApexLogsRequest, options?: ApexLogCallOptions): Promise<TriageApexLogsResult>;

  purge(request: PurgeApexLogsRequest, options?: ApexLogCallOptions): Promise<PurgeApexLogsResult>;

  /** Aborts all remaining shared work and rejects new operations. */
  dispose(): void;
}
```

### Interface semantics

- `requireLocalPath` checks local canonical and legacy candidates before resolving/acquiring remotely. It returns a dependable path or throws; persistence failure can never be reported as success.
- `availableLocalPaths` performs no remote acquisition. It supports full-log search and cached-path resolution without forcing adapters to scan layouts. Per-log failures remain distinct from missing logs.
- `read` defaults to required persistence. Only the explicit best-effort overload may return a body with `persistence: 'failed'`.
- `sync` is the remote-freshness operation. Cancellation throws `cancelled`; partial non-cancellation failures return `status: 'partial'` with no checkpoint advancement.
- `status` is local-only and does not expose sync-state paths or layout names.
- `triage` obtains a dependable local path and then invokes the pure parser. It reports per-log failure truth instead of manufacturing a successful diagnostic summary for unreadable logs.
- `purge` operates only on canonical regular log files contained beneath the requested root and resolved org. Legacy files, symlinks, unsupported directories, and paths outside the root are never candidates.
- Observer callbacks are fire-and-forget. The implementation catches both synchronous throws and rejected promises.

## Salesforce seam

The external dependency is represented by one narrow interface:

```ts
export type ResolvedApexLogOrg = Readonly<{
  username: string;
  alias?: string;
  instanceUrl?: string;
}>;

export type RemoteApexLogRow = ApexLogRef &
  Readonly<{
    operation?: string;
    status?: string;
    logLength?: number;
  }>;

export type RemoteApexLogCursor = Readonly<{
  beforeStartTime: string;
  beforeId: string;
}>;

export interface ApexLogRemote {
  resolveOrg(targetOrg: string | undefined, signal?: AbortSignal): Promise<ResolvedApexLogOrg>;

  listLogs(
    request: Readonly<{
      org: ResolvedApexLogOrg;
      limit: number;
      cursor?: RemoteApexLogCursor;
    }>,
    signal?: AbortSignal
  ): Promise<readonly RemoteApexLogRow[]>;

  readBody(
    request: Readonly<{
      org: ResolvedApexLogOrg;
      logId: string;
    }>,
    signal?: AbortSignal
  ): Promise<string>;
}
```

The production adapter uses `@salesforce/core`. Interface tests use a controllable in-memory adapter. The filesystem remains private and tests use real temporary directories, so there is no exported filesystem port.

## Caller examples

### VS Code Open or Replay

```ts
const file = await lifecycle.requireLocalPath(
  {
    workspaceRoot,
    targetOrg: selectedOrg,
    log: { logId, startTime }
  },
  { signal }
);

await LogViewerPanel.show({ logId, filePath: file.localPath, signal });
```

The Replay adapter uses the same call and passes `file.localPath` to the VS Code command.

### Tail display with best-effort persistence

```ts
const result = await lifecycle.read(
  {
    workspaceRoot,
    targetOrg: selectedOrg,
    log: { logId, startTime },
    persistence: 'best-effort'
  },
  { signal }
);

postTailBody(result.body);
if (result.persistence === 'failed') {
  reportNotPersisted(result.persistenceError);
}
```

Tail streaming remains an adapter that discovers log ids. Body acquisition and persistence cross the lifecycle interface.

### CLI read

```ts
const result = await lifecycle.read(
  {
    workspaceRoot: flags['workspace-root'] ?? process.cwd(),
    targetOrg: flags['target-org'],
    log: { logId: flags['log-id'] },
    maxBytes: flags['max-bytes']
  },
  { signal }
);
```

Because persistence defaults to required, CLI read always receives `localPath` or a stable error.

## Hidden implementation

The following knowledge remains behind the seam:

- safe username and day-directory encoding;
- org metadata and alias lookup;
- canonical and legacy discovery order;
- ambiguity detection when org resolution is unavailable;
- canonical materialization from legacy or `unknown-date` files;
- same-directory temporary writes and atomic rename;
- race handling when another writer wins;
- in-flight acquisition registry and observer counts;
- bounded sync concurrency and pagination;
- sync-state serialization and checkpoint commit ordering;
- partial failure accounting;
- purge traversal, containment, and symlink rules;
- error translation and observer isolation.

When a target org cannot be resolved, a cross-org local fallback is valid only if the log id has exactly one local match. Multiple matches produce `org-resolution`; the implementation never silently opens a log from the wrong org.

## Migration plan

The migration replaces old paths; it does not layer a permanent facade over duplicate implementations.

### Phase 1: establish the lifecycle seam and test surface

Primary files:

- add lifecycle contracts and implementation under `packages/core/src/`;
- extract the production Salesforce adapter from `packages/core/src/runtime.ts`;
- add interface tests under `packages/core/test/` using temporary roots and a fake `ApexLogRemote`.

Work:

1. Introduce the lifecycle interface, stable errors, observer events, and injected remote interface.
2. Move canonical path, discovery, legacy materialization, atomic write, and in-flight acquisition behavior behind the seam.
3. Keep current `createApexLogViewerCore().log.*` methods as temporary translation adapters backed by the new implementation.
4. Make workspace root required inside the lifecycle. Existing product adapters continue choosing workspace, cwd, or temp roots explicitly.

Exit criteria:

- local-first, legacy, persistence, concurrency, cancellation, and error tests pass only through the lifecycle interface;
- no lifecycle test requires VS Code or oclif;
- temporary compatibility methods contain translation only.

### Phase 2: migrate read, Open, Replay, and search

Primary files:

- `apps/vscode-extension/src/runtime/runtimeClient.ts`;
- `apps/vscode-extension/src/host/services/logService.ts`;
- `apps/vscode-extension/src/host/utils/workspace.ts`;
- VS Code providers and related tests;
- CLI `log read` and `log resolve` adapters.

Work:

1. Replace extension `ensureLogFile*` with `requireLocalPath`.
2. Replace search preparation and CLI resolve with `availableLocalPaths`.
3. Delete extension-side path building, cache discovery, materialization, direct body acquisition, `inFlightSaves`, and save limiters once their callers move.
4. Keep viewer launch, Replay command invocation, ripgrep, UI progress, and presentation in the VS Code adapter.
5. Remove implicit root inference from core calls. The VS Code adapter explicitly supplies a workspace root or temp root; CLI adapters supply `--workspace-root` or cwd.

Exit criteria:

- Open, Replay, search, CLI read, and CLI resolve use the lifecycle interface;
- no extension code calculates a canonical log path or writes a log body;
- migrated shallow helper tests are deleted and replaced by interface and thin adapter tests.

### Phase 3: migrate Tail

Primary files:

- `apps/vscode-extension/src/host/utils/tailService.ts`;
- `apps/vscode-extension/src/provider/SfLogTailViewProvider.ts`;
- Tail tests.

Work:

1. Keep streaming subscription, trace-flag coordination, buffering, and webview messages in the Tail adapter.
2. Treat streaming events as log-id notifications. Use lifecycle `read` for body acquisition and best-effort persistence.
3. Remove direct filesystem writes and duplicate body acquisition from Tail.
4. Use `requireLocalPath` when a later Open or Replay action requires a dependable path.

Exit criteria:

- Tail still displays bodies when persistence fails and reports the failure separately;
- Tail contains no canonical path, cache discovery, or log-body write policy.

### Phase 4: migrate sync and status

Primary files:

- `packages/core/src/runtime.ts`;
- CLI `log sync` and `log status` adapters;
- `apps/vscode-extension/src/runtime/runtimeClient.ts` and sync callers.

Work:

1. Move sync pagination, bounded acquisition, state writes, org metadata, and checkpoint rules into the lifecycle implementation.
2. Map existing product DTOs to the new logical sync/status results.
3. Preserve existing public CLI JSON during the compatibility window. Layout-bearing legacy fields remain in a translation adapter and are not added to the lifecycle interface.

Exit criteria:

- partial or cancelled sync never advances its checkpoint;
- completed files survive and are deduplicated on retry;
- `status` is local-only;
- the lifecycle interface does not expose `stateFile`, `apexlogsRoot`, or safe-path encoding.

### Phase 5: migrate triage and local purge

Primary files:

- `packages/core/src/logTriage.ts` and lifecycle implementation;
- `apps/vscode-extension/src/host/services/logTriage.ts`;
- `apps/vscode-extension/src/host/utils/workspace.ts`;
- triage, provider, and purge tests.

Work:

1. Route triage acquisition/read orchestration through lifecycle `triage` while keeping text parsing pure.
2. Move `purgeSavedLogs` traversal, validation, and deletion into lifecycle `purge`.
3. Make providers pass retention policy and current keep ids.
4. Keep destructive Salesforce ApexLog deletion separate from local purge.

Exit criteria:

- extension triage wrappers contain only DTO/presentation translation;
- the extension has no local purge traversal;
- purge tests cover root containment, symlinks, unsupported directories, cancellation, keep ids, age, and legacy preservation through the lifecycle interface.

### Phase 6: remove compatibility paths

Work:

1. Remove `resolveCachedPath` and other lifecycle primitives after their final callers migrate.
2. Remove temporary core translations that no supported product contract needs.
3. Retain class-per-command CLI adapters and extension presentation adapters.
4. Update `docs/ARCHITECTURE.md` to describe the implemented seam.
5. Delete obsolete helper tests rather than layering them beneath interface tests.

Exit criteria:

- deleting the lifecycle module would force cache, acquisition, materialization, concurrency, sync, triage, and purge complexity back into multiple callers;
- all lifecycle invariants have one primary test surface;
- no duplicate implementation remains in the extension.

## Verification matrix

| Behavior                                        | Primary verification                                           |
| ----------------------------------------------- | -------------------------------------------------------------- |
| Canonical and legacy local-first reads          | Core lifecycle interface tests                                 |
| Alias resolution and cross-org ambiguity        | Core lifecycle interface tests with fake remote and temp roots |
| Atomic materialization and races                | Core lifecycle interface tests on real filesystem              |
| Shared acquisition and independent cancellation | Core lifecycle interface concurrency tests                     |
| Required versus best-effort persistence         | Core lifecycle interface tests plus thin Tail adapter test     |
| Checkpoint commit after complete sync only      | Core lifecycle interface tests                                 |
| Triage orchestration                            | Core lifecycle interface tests                                 |
| Pure parsing edge cases                         | Direct `logTriage` parser tests                                |
| Purge containment and legacy preservation       | Core lifecycle interface tests                                 |
| VS Code progress and error presentation         | Thin extension adapter tests                                   |
| CLI flag and JSON translation                   | CLI command tests                                              |
| Cross-surface behavior                          | Focused extension and CLI E2E tests                            |

Recommended validation for each implementation phase is the narrow affected suite followed by `pnpm run check-types`, `pnpm run lint`, and `pnpm run test:unit`. Before final integration, run `pnpm run test:all`; use `pnpm run test:ci` when CI-equivalent coverage is warranted.

## Implementation result

The completed migration follows Design C:

- `packages/core/src/logLifecycle.ts` is the single owner of local discovery, canonical and legacy materialization, remote body acquisition, shared in-flight work, sync state, org metadata, status, triage orchestration, and safe local purge;
- `packages/core/src/runtime.ts` supplies the production Salesforce seam and preserves the existing CLI-facing DTOs without reimplementing lifecycle policy;
- extension Open, Replay, Tail bodies, search preparation, sync, status, triage, and purge use the lifecycle through the in-process runtime client;
- extension filesystem helpers no longer construct log-cache paths, discover cached bodies, write log bodies, or traverse purge candidates;
- legacy flat files, prior `org.json` metadata, and prior sync-state counters remain readable;
- the obsolete extension body/catalog HTTP path, cached-path facade, storage helpers, and their implementation-coupled tests were removed.

Final local verification passed with `pnpm run check-types`, `pnpm run lint`, and `pnpm run test:all`.
