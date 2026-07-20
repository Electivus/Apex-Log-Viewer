import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { RuntimeLogTriageSummary } from './contracts.js';
import { summarizeLogText } from './logTriage.js';

export type ResolvedApexLogOrg = Readonly<{
  username: string;
  alias?: string;
  instanceUrl?: string;
}>;

export type RemoteApexLogCursor = Readonly<{
  beforeStartTime: string;
  beforeId: string;
}>;

export type RemoteApexLogRow = Readonly<{
  logId: string;
  startTime?: string;
  operation?: string;
  status?: string;
  logLength?: number;
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
  readBody(request: Readonly<{ org: ResolvedApexLogOrg; logId: string }>, signal?: AbortSignal): Promise<string>;
}

export type ApexLogRef = Readonly<{
  logId: string;
  startTime?: string;
}>;

export type ApexLogScope = Readonly<{
  workspaceRoot: string;
  targetOrg?: string;
}>;

export type ApexLogLifecycleErrorCode =
  'org-resolution' | 'remote-acquisition' | 'local-persistence' | 'not-found' | 'invalid-log' | 'cancelled';

export type ApexLogLifecycleOperation =
  'require-local-path' | 'available-local-paths' | 'read' | 'sync' | 'status' | 'triage' | 'purge';

export class ApexLogLifecycleError extends Error {
  public override readonly name = 'ApexLogLifecycleError';

  public constructor(
    public readonly code: ApexLogLifecycleErrorCode,
    message: string,
    public readonly context: Readonly<{
      operation: ApexLogLifecycleOperation;
      logId?: string;
      resolvedUsername?: string;
    }>,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export type ApexLogCallOptions = Readonly<{
  signal?: AbortSignal;
  observe?: (event: ApexLogLifecycleEvent) => void | PromiseLike<void>;
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

export type ApexLogLocalFile = ApexLogRef &
  Readonly<{
    resolvedUsername: string;
    source: 'local' | 'remote';
    persistence: 'existing' | 'written';
    localPath: string;
  }>;

export type RequireLocalPathRequest = ApexLogScope & Readonly<{ log: ApexLogRef }>;

export type ApexLogFailure = Readonly<{
  logId: string;
  error: ApexLogLifecycleError;
}>;

export type AvailableLocalPathsRequest = ApexLogScope & Readonly<{ logs: readonly ApexLogRef[] }>;

export type AvailableLocalPathsResult = Readonly<{
  available: readonly ApexLogLocalFile[];
  missing: readonly ApexLogRef[];
  failures: readonly ApexLogFailure[];
}>;

export type ReadApexLogRequest = ApexLogScope &
  Readonly<{
    log: ApexLogRef;
    maxBytes?: number;
    persistence?: 'required' | 'best-effort';
  }>;

export type StoredApexLogBody = ApexLogLocalFile &
  Readonly<{
    body: string;
    sizeBytes: number;
    truncated: boolean;
  }>;

export type UnstoredApexLogBody = ApexLogRef &
  Readonly<{
    resolvedUsername: string;
    source: 'local' | 'remote';
    persistence: 'failed';
    localPath?: undefined;
    persistenceError: ApexLogLifecycleError;
    body: string;
    sizeBytes: number;
    truncated: boolean;
  }>;

export type ReadApexLogResult = StoredApexLogBody | UnstoredApexLogBody;

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

export type TriageApexLogsRequest = ApexLogScope & Readonly<{ logs: readonly ApexLogRef[] }>;

export type ApexLogTriageEntry =
  | Readonly<{
      status: 'triaged';
      log: ApexLogRef;
      file: ApexLogLocalFile;
      summary: RuntimeLogTriageSummary;
    }>
  | Readonly<{
      status: 'failed';
      log: ApexLogRef;
      error: ApexLogLifecycleError;
    }>;

export type TriageApexLogsResult = Readonly<{ entries: readonly ApexLogTriageEntry[] }>;

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
  dispose(): void;
}

type ApexLogLifecycleImplementation = Omit<ApexLogLifecycle, 'read'> &
  Readonly<{
    read(request: ReadApexLogRequest, options?: ApexLogCallOptions): Promise<ReadApexLogResult>;
  }>;

class AcquiredButNotPersistedError extends ApexLogLifecycleError {
  public constructor(
    public readonly body: string,
    public readonly org: ResolvedApexLogOrg,
    logId: string,
    cause: unknown,
    public readonly source: 'local' | 'remote' = 'remote'
  ) {
    super(
      'local-persistence',
      `Apex log ${logId} was acquired but could not be persisted locally.`,
      { operation: 'require-local-path', logId, resolvedUsername: org.username },
      { cause }
    );
  }
}

type PendingAcquisition = {
  activeObservers: number;
  controller: AbortController;
  promise: Promise<ApexLogLocalFile>;
  settled: boolean;
};

type LifecycleSyncState = {
  version: 1;
  orgs: Record<
    string,
    {
      lastSyncStartedAt?: string;
      lastSyncCompletedAt?: string;
      lastSyncedLogId?: string;
      lastSyncedStartTime?: string;
      existingCount: number;
      materializedCount: number;
      downloadedCount: number;
      failedCount: number;
    }
  >;
};

type OrgMetadata = Readonly<{
  version: 1;
  username: string;
  targetOrg?: string;
  safeTargetOrg?: string;
  resolvedUsername?: string;
  alias?: string;
  instanceUrl?: string;
  updatedAt?: string;
}>;

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function isRealDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directoryPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function findCanonicalLogPath(
  workspaceRoot: string,
  safeUsername: string,
  logId: string
): Promise<string | undefined> {
  const logsRoot = path.join(workspaceRoot, 'apexlogs', 'orgs', safeUsername, 'logs');
  const entries = await readDirectory(logsRoot);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(unknown-date|\d{4}-\d{2}-\d{2})$/.test(entry.name)) continue;
    const candidate = path.join(logsRoot, entry.name, `${logId}.log`);
    if (await isRegularFile(candidate)) return candidate;
  }
  return undefined;
}

function safeUsername(value: string | undefined): string {
  const encoded = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.@-]+/g, '_');
  return encoded && encoded !== '.' && encoded !== '..' ? encoded : 'default';
}

function logDay(startTime: string | undefined): string {
  const day = String(startTime || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'unknown-date';
}

async function findLocalLogPath(workspaceRoot: string, username: string, logId: string): Promise<string | undefined> {
  const safe = safeUsername(username);
  const canonical = await findCanonicalLogPath(workspaceRoot, safe, logId);
  if (canonical) return canonical;
  const legacy = path.join(workspaceRoot, 'apexlogs', `${safe}_${logId}.log`);
  return (await isRegularFile(legacy)) ? legacy : undefined;
}

async function findLocalLogMatches(
  workspaceRoot: string,
  logId: string
): Promise<Array<{ username: string; localPath: string }>> {
  const matchesByUsername = new Map<string, { username: string; localPath: string }>();
  const orgsRoot = path.join(workspaceRoot, 'apexlogs', 'orgs');
  for (const org of await readDirectory(orgsRoot)) {
    if (!org.isDirectory() || org.isSymbolicLink()) continue;
    const localPath = await findCanonicalLogPath(workspaceRoot, org.name, logId);
    if (localPath) {
      const metadata = await readOrgMetadata(path.join(orgsRoot, org.name, 'org.json'));
      matchesByUsername.set(org.name, { username: metadata?.username ?? org.name, localPath });
    }
  }
  const apexlogsRoot = path.join(workspaceRoot, 'apexlogs');
  const suffix = `_${logId}.log`;
  for (const entry of await readDirectory(apexlogsRoot)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(suffix)) continue;
    const localPath = path.join(apexlogsRoot, entry.name);
    const username = entry.name.slice(0, -suffix.length);
    const identityKey = safeUsername(username);
    if (!matchesByUsername.has(identityKey)) matchesByUsername.set(identityKey, { username, localPath });
  }
  return Array.from(matchesByUsername.values());
}

function orgMetadataPath(workspaceRoot: string, username: string): string {
  return path.join(workspaceRoot, 'apexlogs', 'orgs', safeUsername(username), 'org.json');
}

async function readOrgMetadata(filePath: string): Promise<OrgMetadata | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<OrgMetadata> & {
      resolvedUsername?: unknown;
    };
    const username =
      typeof parsed.username === 'string'
        ? parsed.username
        : typeof parsed.resolvedUsername === 'string'
          ? parsed.resolvedUsername
          : '';
    if ((parsed.version !== undefined && parsed.version !== 1) || !username.trim()) return undefined;
    return {
      version: 1,
      username,
      ...(typeof parsed.alias === 'string' && parsed.alias ? { alias: parsed.alias } : {}),
      ...(typeof parsed.instanceUrl === 'string' && parsed.instanceUrl ? { instanceUrl: parsed.instanceUrl } : {})
    };
  } catch {
    return undefined;
  }
}

async function findLocalOrgUsernames(workspaceRoot: string, selector: string): Promise<string[]> {
  const normalized = selector.trim();
  if (!normalized) return [];
  const matches = new Set<string>();
  const orgsRoot = path.join(workspaceRoot, 'apexlogs', 'orgs');
  for (const org of await readDirectory(orgsRoot)) {
    if (!org.isDirectory() || org.isSymbolicLink()) continue;
    const metadata = await readOrgMetadata(path.join(orgsRoot, org.name, 'org.json'));
    if (!metadata) continue;
    const username = metadata.username;
    if (
      normalized === username ||
      normalized === metadata?.alias ||
      (safeUsername(normalized) === org.name && normalized === username)
    ) {
      matches.add(username);
    }
  }
  return Array.from(matches);
}

async function writeOrgMetadata(workspaceRoot: string, org: ResolvedApexLogOrg): Promise<void> {
  const filePath = orgMetadataPath(workspaceRoot, org.username);
  const existing = await readOrgMetadata(filePath);
  const alias = org.alias ?? existing?.alias;
  await writeJsonAtomic(filePath, {
    version: 1,
    username: org.username,
    targetOrg: alias ?? org.username,
    safeTargetOrg: safeUsername(org.username),
    resolvedUsername: org.username,
    ...(alias ? { alias } : {}),
    ...(org.instanceUrl || existing?.instanceUrl ? { instanceUrl: org.instanceUrl ?? existing?.instanceUrl } : {}),
    updatedAt: new Date().toISOString()
  } satisfies OrgMetadata);
}

async function writeCanonicalLog(
  workspaceRoot: string,
  username: string,
  log: ApexLogRef,
  body: string
): Promise<{ localPath: string; written: boolean }> {
  const localPath = path.join(
    workspaceRoot,
    'apexlogs',
    'orgs',
    safeUsername(username),
    'logs',
    logDay(log.startTime),
    `${log.logId}.log`
  );
  if (await isRegularFile(localPath)) return { localPath, written: false };
  const written = await writeFileAtomic(localPath, body, true);
  return { localPath, written };
}

async function localFileResult(
  workspaceRoot: string,
  username: string,
  log: ApexLogRef,
  localPath: string
): Promise<ApexLogLocalFile> {
  if (log.startTime && logDay(log.startTime) !== 'unknown-date') {
    const body = await fs.readFile(localPath, 'utf8');
    let stored: Awaited<ReturnType<typeof writeCanonicalLog>>;
    try {
      stored = await writeCanonicalLog(workspaceRoot, username, log, body);
    } catch (error) {
      throw new AcquiredButNotPersistedError(body, { username }, log.logId, error, 'local');
    }
    if (path.resolve(stored.localPath) !== path.resolve(localPath)) {
      return {
        ...log,
        resolvedUsername: username,
        source: 'local',
        persistence: stored.written ? 'written' : 'existing',
        localPath: stored.localPath
      };
    }
  }
  return {
    ...log,
    resolvedUsername: username,
    source: 'local',
    persistence: 'existing',
    localPath
  };
}

function syncStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'apexlogs', '.alv', 'sync-state.json');
}

async function readSyncState(workspaceRoot: string): Promise<LifecycleSyncState> {
  try {
    const raw = await fs.readFile(syncStatePath(workspaceRoot), 'utf8');
    const parsed = JSON.parse(raw) as {
      orgs?: Record<string, Record<string, unknown>>;
    };
    const orgs: LifecycleSyncState['orgs'] = {};
    for (const [username, entry] of Object.entries(parsed.orgs ?? {})) {
      const numberValue = (key: string): number | undefined => {
        const value = Number(entry[key]);
        return Number.isFinite(value) ? value : undefined;
      };
      orgs[username] = {
        ...(typeof entry.lastSyncStartedAt === 'string' ? { lastSyncStartedAt: entry.lastSyncStartedAt } : {}),
        ...(typeof entry.lastSyncCompletedAt === 'string' ? { lastSyncCompletedAt: entry.lastSyncCompletedAt } : {}),
        ...(typeof entry.lastSyncedLogId === 'string' ? { lastSyncedLogId: entry.lastSyncedLogId } : {}),
        ...(typeof entry.lastSyncedStartTime === 'string' ? { lastSyncedStartTime: entry.lastSyncedStartTime } : {}),
        existingCount: numberValue('existingCount') ?? numberValue('cachedCount') ?? 0,
        materializedCount: numberValue('materializedCount') ?? 0,
        downloadedCount: numberValue('downloadedCount') ?? 0,
        failedCount: numberValue('failedCount') ?? 0
      };
    }
    return { version: 1, orgs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, orgs: {} };
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, false);
}

async function writeFileAtomic(filePath: string, contents: string, keepExisting: boolean): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, 'utf8');
    if (keepExisting) {
      try {
        await fs.link(temporaryPath, filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && (await isRegularFile(filePath))) return false;
        throw error;
      }
    }
    await fs.rename(temporaryPath, filePath);
    return true;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function countLocalLogs(workspaceRoot: string, username: string | undefined): Promise<number> {
  const ids = new Set<string>();
  const collectCanonical = async (orgName: string): Promise<void> => {
    const logsRoot = path.join(workspaceRoot, 'apexlogs', 'orgs', safeUsername(orgName), 'logs');
    const days = await readDirectory(logsRoot);
    for (const day of days) {
      if (!day.isDirectory() || !/^(unknown-date|\d{4}-\d{2}-\d{2})$/.test(day.name)) continue;
      const files = await readDirectory(path.join(logsRoot, day.name));
      for (const file of files) {
        if (file.isFile() && /^07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?\.log$/.test(file.name)) {
          ids.add(file.name.slice(0, -4));
        }
      }
    }
  };
  if (username) {
    await collectCanonical(username);
  } else {
    const orgsRoot = path.join(workspaceRoot, 'apexlogs', 'orgs');
    for (const org of await readDirectory(orgsRoot)) {
      if (org.isDirectory() && !org.isSymbolicLink()) await collectCanonical(org.name);
    }
  }
  const apexlogsRoot = path.join(workspaceRoot, 'apexlogs');
  const entries = await readDirectory(apexlogsRoot);
  const prefix = username ? `${safeUsername(username)}_` : undefined;
  for (const entry of entries) {
    if (!entry.isFile() || (prefix && !entry.name.startsWith(prefix))) continue;
    const match = /_(07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\.log$/.exec(entry.name);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids.size;
}

async function runConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const count = Math.max(1, Math.min(concurrency, values.length || 1));
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (index < values.length) {
        const value = values[index++];
        if (value !== undefined) await worker(value);
      }
    })
  );
}

async function readDirectory(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

export function createApexLogLifecycle(options: { remote: ApexLogRemote }): ApexLogLifecycle {
  let disposed = false;
  const inFlight = new Map<string, PendingAcquisition>();

  const cancelledError = (operation: ApexLogLifecycleOperation, logId?: string) =>
    new ApexLogLifecycleError('cancelled', 'Operation cancelled.', { operation, logId });

  const throwIfUnavailable = (operation: ApexLogLifecycleOperation, signal?: AbortSignal, logId?: string): void => {
    if (disposed) throw cancelledError(operation, logId);
    if (signal?.aborted) throw cancelledError(operation, logId);
  };

  const emit = (callOptions: ApexLogCallOptions | undefined, event: ApexLogLifecycleEvent): void => {
    try {
      Promise.resolve(callOptions?.observe?.(event)).catch(() => undefined);
    } catch {}
  };

  const validateLog = (operation: ApexLogLifecycleOperation, log: ApexLogRef): void => {
    if (!/^07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(log.logId)) {
      throw new ApexLogLifecycleError('invalid-log', `Invalid Apex log id: ${log.logId}`, {
        operation,
        logId: log.logId
      });
    }
  };

  const validateScope = (operation: ApexLogLifecycleOperation, workspaceRoot: string, logId?: string): void => {
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      throw new ApexLogLifecycleError('local-persistence', 'Apex log workspace root must be an absolute path.', {
        operation,
        logId
      });
    }
  };

  const localUsernameForSelector = async (
    operation: ApexLogLifecycleOperation,
    workspaceRoot: string,
    selector: string,
    logId?: string
  ): Promise<string | undefined> => {
    let matches: string[];
    try {
      matches = await findLocalOrgUsernames(workspaceRoot, selector);
    } catch (error) {
      throw new ApexLogLifecycleError(
        'local-persistence',
        `Local org metadata for selector ${selector} could not be inspected.`,
        { operation, logId },
        { cause: error }
      );
    }
    if (matches.length > 1) {
      throw new ApexLogLifecycleError('org-resolution', `Org selector ${selector} matches more than one local org.`, {
        operation,
        logId
      });
    }
    return matches[0];
  };

  const stableError = (
    code: ApexLogLifecycleErrorCode,
    operation: ApexLogLifecycleOperation,
    message: string,
    cause: unknown,
    logId?: string,
    resolvedUsername?: string
  ): ApexLogLifecycleError => {
    if (cause instanceof ApexLogLifecycleError) return cause;
    return new ApexLogLifecycleError(code, message, { operation, logId, resolvedUsername }, { cause });
  };

  const inspectLocal = async <T>(
    operation: ApexLogLifecycleOperation,
    message: string,
    run: () => Promise<T>,
    logId?: string,
    resolvedUsername?: string
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw stableError('local-persistence', operation, message, error, logId, resolvedUsername);
    }
  };

  const dependableLocalFile = async (
    workspaceRoot: string,
    username: string,
    log: ApexLogRef,
    localPath: string
  ): Promise<ApexLogLocalFile> => {
    try {
      return await localFileResult(workspaceRoot, username, log, localPath);
    } catch (error) {
      throw stableError(
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'local-persistence',
        'require-local-path',
        `Apex log ${log.logId} could not be materialized locally.`,
        error,
        log.logId,
        username
      );
    }
  };

  const readLifecycleState = async (
    operation: 'sync' | 'status',
    workspaceRoot: string,
    resolvedUsername?: string
  ): Promise<LifecycleSyncState> => {
    try {
      return await readSyncState(workspaceRoot);
    } catch (error) {
      throw stableError(
        'local-persistence',
        operation,
        'Apex log sync state could not be read locally.',
        error,
        undefined,
        resolvedUsername
      );
    }
  };

  const observeAcquisition = (
    pending: PendingAcquisition,
    signal: AbortSignal | undefined,
    logId: string
  ): Promise<ApexLogLocalFile> => {
    if (signal?.aborted) return Promise.reject(cancelledError('require-local-path', logId));
    pending.activeObservers += 1;
    const release = (): void => {
      pending.activeObservers = Math.max(0, pending.activeObservers - 1);
      if (!pending.settled && pending.activeObservers === 0) pending.controller.abort();
    };
    if (!signal) return pending.promise.finally(release);
    return new Promise<ApexLogLocalFile>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        release();
        callback();
      };
      const onAbort = (): void => finish(() => reject(cancelledError('require-local-path', logId)));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error))
      );
      if (signal.aborted) onAbort();
    });
  };

  const lifecycle: ApexLogLifecycleImplementation = {
    async requireLocalPath(request, callOptions): Promise<ApexLogLocalFile> {
      emit(callOptions, { operation: 'require-local-path', phase: 'started', logId: request.log.logId });
      validateScope('require-local-path', request.workspaceRoot, request.log.logId);
      validateLog('require-local-path', request.log);
      throwIfUnavailable('require-local-path', callOptions?.signal, request.log.logId);
      const complete = (file: ApexLogLocalFile): ApexLogLocalFile => {
        emit(callOptions, { operation: 'require-local-path', phase: 'completed', logId: request.log.logId });
        return file;
      };
      const requestedOrg = String(request.targetOrg || '').trim();
      const localUsername = requestedOrg
        ? await localUsernameForSelector('require-local-path', request.workspaceRoot, requestedOrg, request.log.logId)
        : undefined;
      emit(callOptions, { operation: 'require-local-path', phase: 'checking-local', logId: request.log.logId });
      const requestedLocalPath = localUsername
        ? await inspectLocal(
            'require-local-path',
            `Local storage for Apex log ${request.log.logId} could not be inspected.`,
            () => findLocalLogPath(request.workspaceRoot, localUsername, request.log.logId),
            request.log.logId,
            localUsername
          )
        : undefined;
      throwIfUnavailable('require-local-path', callOptions?.signal, request.log.logId);
      if (requestedLocalPath) {
        return complete(
          await dependableLocalFile(request.workspaceRoot, localUsername!, request.log, requestedLocalPath)
        );
      }
      if (!requestedOrg) {
        const localMatches = await inspectLocal(
          'require-local-path',
          `Local storage for Apex log ${request.log.logId} could not be inspected.`,
          () => findLocalLogMatches(request.workspaceRoot, request.log.logId),
          request.log.logId
        );
        if (localMatches.length === 1 && localMatches[0]) {
          return complete(
            await dependableLocalFile(
              request.workspaceRoot,
              localMatches[0].username,
              request.log,
              localMatches[0].localPath
            )
          );
        }
        if (localMatches.length > 1) {
          throw new ApexLogLifecycleError(
            'org-resolution',
            `Apex log ${request.log.logId} exists in more than one local org.`,
            { operation: 'require-local-path', logId: request.log.logId }
          );
        }
      }
      emit(callOptions, { operation: 'require-local-path', phase: 'resolving-org', logId: request.log.logId });
      let org: ResolvedApexLogOrg;
      try {
        org = await options.remote.resolveOrg(request.targetOrg, callOptions?.signal);
      } catch (error) {
        throwIfUnavailable('require-local-path', callOptions?.signal, request.log.logId);
        const localMatches = await inspectLocal(
          'require-local-path',
          `Local storage for Apex log ${request.log.logId} could not be inspected.`,
          () => findLocalLogMatches(request.workspaceRoot, request.log.logId),
          request.log.logId
        );
        if (localMatches.length === 1 && localMatches[0]) {
          return complete(
            await dependableLocalFile(
              request.workspaceRoot,
              localMatches[0].username,
              request.log,
              localMatches[0].localPath
            )
          );
        }
        if (localMatches.length > 1) {
          throw new ApexLogLifecycleError(
            'org-resolution',
            `Apex log ${request.log.logId} exists in more than one local org.`,
            { operation: 'require-local-path', logId: request.log.logId },
            { cause: error }
          );
        }
        throw stableError(
          'org-resolution',
          'require-local-path',
          `The org for Apex log ${request.log.logId} could not be resolved.`,
          error,
          request.log.logId
        );
      }
      throwIfUnavailable('require-local-path', callOptions?.signal, request.log.logId);
      // A dependable log path is the required outcome here. Sync treats org metadata
      // as required state, while one-off acquisition keeps metadata best-effort.
      await writeOrgMetadata(request.workspaceRoot, org).catch(() => undefined);
      const resolvedLocalPath = await inspectLocal(
        'require-local-path',
        `Local storage for Apex log ${request.log.logId} could not be inspected.`,
        () => findLocalLogPath(request.workspaceRoot, org.username, request.log.logId),
        request.log.logId,
        org.username
      );
      throwIfUnavailable('require-local-path', callOptions?.signal, request.log.logId);
      if (resolvedLocalPath) {
        return complete(await dependableLocalFile(request.workspaceRoot, org.username, request.log, resolvedLocalPath));
      }
      const key = `${path.resolve(request.workspaceRoot)}\0${org.username}\0${request.log.logId}`;
      let pending = inFlight.get(key);
      if (!pending) {
        const controller = new AbortController();
        pending = {
          activeObservers: 0,
          controller,
          promise: Promise.resolve(undefined as unknown as ApexLogLocalFile),
          settled: false
        };
        const entry = pending;
        entry.promise = (async (): Promise<ApexLogLocalFile> => {
          emit(callOptions, { operation: 'require-local-path', phase: 'acquiring-remote', logId: request.log.logId });
          let body: string;
          try {
            body = await options.remote.readBody({ org, logId: request.log.logId }, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) throw cancelledError('require-local-path', request.log.logId);
            throw stableError(
              'remote-acquisition',
              'require-local-path',
              `Apex log ${request.log.logId} could not be acquired from Salesforce.`,
              error,
              request.log.logId,
              org.username
            );
          }
          let stored: Awaited<ReturnType<typeof writeCanonicalLog>>;
          try {
            emit(callOptions, { operation: 'require-local-path', phase: 'materializing', logId: request.log.logId });
            stored = await writeCanonicalLog(request.workspaceRoot, org.username, request.log, body);
          } catch (error) {
            throw new AcquiredButNotPersistedError(body, org, request.log.logId, error);
          }
          return {
            ...request.log,
            resolvedUsername: org.username,
            source: 'remote',
            persistence: stored.written ? 'written' : 'existing',
            localPath: stored.localPath
          };
        })().finally(() => {
          entry.settled = true;
          if (inFlight.get(key) === entry) inFlight.delete(key);
        });
        inFlight.set(key, entry);
      }
      return complete(await observeAcquisition(pending, callOptions?.signal, request.log.logId));
    },
    async availableLocalPaths(request, callOptions): Promise<AvailableLocalPathsResult> {
      validateScope('available-local-paths', request.workspaceRoot);
      throwIfUnavailable('available-local-paths', callOptions?.signal);
      emit(callOptions, { operation: 'available-local-paths', phase: 'started', total: request.logs.length });
      const requestedSelector = String(request.targetOrg || '').trim();
      const username = requestedSelector
        ? await localUsernameForSelector('available-local-paths', request.workspaceRoot, requestedSelector)
        : '';
      const available: ApexLogLocalFile[] = [];
      const missing: ApexLogRef[] = [];
      const failures: ApexLogFailure[] = [];
      for (const log of request.logs) {
        throwIfUnavailable('available-local-paths', callOptions?.signal, log.logId);
        try {
          validateLog('available-local-paths', log);
        } catch (error) {
          failures.push({ logId: log.logId, error: error as ApexLogLifecycleError });
          continue;
        }
        let matchUsername = username ?? '';
        let matchedPath = username
          ? await inspectLocal(
              'available-local-paths',
              `Local storage for Apex log ${log.logId} could not be inspected.`,
              () => findLocalLogPath(request.workspaceRoot, username, log.logId),
              log.logId,
              username
            )
          : undefined;
        if (!matchedPath) {
          const allMatches = await inspectLocal(
            'available-local-paths',
            `Local storage for Apex log ${log.logId} could not be inspected.`,
            () => findLocalLogMatches(request.workspaceRoot, log.logId),
            log.logId,
            username || undefined
          );
          const matches = username ? [] : allMatches;
          if (matches.length > 1) {
            failures.push({
              logId: log.logId,
              error: new ApexLogLifecycleError(
                'org-resolution',
                `Apex log ${log.logId} exists in more than one local org.`,
                { operation: 'available-local-paths', logId: log.logId }
              )
            });
            continue;
          }
          matchUsername = matches[0]?.username ?? '';
          matchedPath = matches[0]?.localPath;
        }
        if (!matchedPath) {
          missing.push(log);
          continue;
        }
        try {
          available.push(await localFileResult(request.workspaceRoot, matchUsername, log, matchedPath));
        } catch (error) {
          failures.push({
            logId: log.logId,
            error: new ApexLogLifecycleError(
              'local-persistence',
              `Apex log ${log.logId} could not be materialized locally.`,
              { operation: 'available-local-paths', logId: log.logId, resolvedUsername: matchUsername || undefined },
              { cause: error }
            )
          });
        }
      }
      emit(callOptions, {
        operation: 'available-local-paths',
        phase: 'completed',
        completed: available.length + missing.length + failures.length,
        total: request.logs.length
      });
      return { available, missing, failures };
    },
    async read(request, callOptions): Promise<ReadApexLogResult> {
      validateScope('read', request.workspaceRoot, request.log.logId);
      emit(callOptions, { operation: 'read', phase: 'started', logId: request.log.logId });
      let file: ApexLogLocalFile;
      try {
        file = await lifecycle.requireLocalPath(request, callOptions);
      } catch (error) {
        if (request.persistence !== 'best-effort' || !(error instanceof AcquiredButNotPersistedError)) throw error;
        const bytes = Buffer.from(error.body, 'utf8');
        const maxBytes = request.maxBytes ? Math.max(1, Math.floor(request.maxBytes)) : undefined;
        const result: UnstoredApexLogBody = {
          ...request.log,
          resolvedUsername: error.org.username,
          source: error.source,
          persistence: 'failed',
          persistenceError: error,
          body: maxBytes ? bytes.subarray(0, maxBytes).toString('utf8') : error.body,
          sizeBytes: bytes.length,
          truncated: Boolean(maxBytes && bytes.length > maxBytes)
        };
        emit(callOptions, { operation: 'read', phase: 'completed', logId: request.log.logId });
        return result;
      }
      throwIfUnavailable('read', callOptions?.signal, request.log.logId);
      emit(callOptions, { operation: 'read', phase: 'reading-local', logId: request.log.logId });
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(file.localPath, callOptions?.signal ? { signal: callOptions.signal } : undefined);
      } catch (error) {
        throwIfUnavailable('read', callOptions?.signal, request.log.logId);
        throw stableError(
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'local-persistence',
          'read',
          `Apex log ${request.log.logId} could not be read locally.`,
          error,
          request.log.logId,
          file.resolvedUsername
        );
      }
      throwIfUnavailable('read', callOptions?.signal, request.log.logId);
      const maxBytes = request.maxBytes ? Math.max(1, Math.floor(request.maxBytes)) : undefined;
      const bodyBytes = maxBytes ? bytes.subarray(0, maxBytes) : bytes;
      const result: StoredApexLogBody = {
        ...file,
        body: bodyBytes.toString('utf8'),
        sizeBytes: bytes.length,
        truncated: Boolean(maxBytes && bytes.length > maxBytes)
      };
      emit(callOptions, { operation: 'read', phase: 'completed', logId: request.log.logId });
      return result;
    },
    async sync(request, callOptions): Promise<SyncApexLogsResult> {
      validateScope('sync', request.workspaceRoot);
      throwIfUnavailable('sync', callOptions?.signal);
      emit(callOptions, { operation: 'sync', phase: 'started' });
      const startedAt = new Date().toISOString();
      let org: ResolvedApexLogOrg;
      try {
        emit(callOptions, { operation: 'sync', phase: 'resolving-org' });
        org = await options.remote.resolveOrg(request.targetOrg, callOptions?.signal);
      } catch (error) {
        throwIfUnavailable('sync', callOptions?.signal);
        throw stableError('org-resolution', 'sync', 'The Apex log org could not be resolved.', error);
      }
      throwIfUnavailable('sync', callOptions?.signal);
      try {
        await writeOrgMetadata(request.workspaceRoot, org);
        await writeJsonAtomic(path.join(request.workspaceRoot, 'apexlogs', '.alv', 'version.json'), 1);
      } catch (error) {
        throw stableError(
          'local-persistence',
          'sync',
          `Metadata for org ${org.username} could not be persisted locally.`,
          error,
          undefined,
          org.username
        );
      }
      const state = await readLifecycleState('sync', request.workspaceRoot, org.username);
      const previous = state.orgs[org.username];
      const rows: RemoteApexLogRow[] = [];
      const seen = new Set<string>();
      let cursor: RemoteApexLogCursor | undefined;
      let reachedCheckpoint = false;
      for (;;) {
        let page: readonly RemoteApexLogRow[];
        try {
          emit(callOptions, { operation: 'sync', phase: 'listing-remote', completed: rows.length });
          page = await options.remote.listLogs({ org, limit: 200, cursor }, callOptions?.signal);
        } catch (error) {
          throwIfUnavailable('sync', callOptions?.signal);
          throw stableError(
            'remote-acquisition',
            'sync',
            `Apex logs for org ${org.username} could not be listed.`,
            error,
            undefined,
            org.username
          );
        }
        throwIfUnavailable('sync', callOptions?.signal);
        for (const row of page) {
          if (!row.logId || seen.has(row.logId)) continue;
          seen.add(row.logId);
          if (
            request.mode !== 'full' &&
            previous &&
            (row.logId === previous.lastSyncedLogId ||
              (!previous.lastSyncedLogId && row.startTime === previous.lastSyncedStartTime))
          ) {
            reachedCheckpoint = true;
            break;
          }
          rows.push(row);
        }
        const last = page.at(-1);
        if (reachedCheckpoint || page.length < 200 || !last?.startTime || !last.logId) break;
        cursor = { beforeStartTime: last.startTime, beforeId: last.logId };
      }

      let existing = 0;
      let materialized = 0;
      let downloaded = 0;
      const failures: ApexLogFailure[] = [];
      emit(callOptions, { operation: 'sync', phase: 'materializing', completed: 0, total: rows.length });
      let completed = 0;
      await runConcurrent(rows, Math.max(1, Math.min(8, Math.floor(request.concurrency ?? 6))), async row => {
        try {
          const file = await lifecycle.requireLocalPath(
            {
              workspaceRoot: request.workspaceRoot,
              targetOrg: org.username,
              log: { logId: row.logId, startTime: row.startTime }
            },
            callOptions
          );
          if (file.source === 'remote') downloaded += 1;
          else if (file.persistence === 'written') materialized += 1;
          else existing += 1;
        } catch (error) {
          if (error instanceof ApexLogLifecycleError && error.code === 'cancelled') throw error;
          failures.push({
            logId: row.logId,
            error:
              error instanceof ApexLogLifecycleError
                ? error
                : new ApexLogLifecycleError(
                    'remote-acquisition',
                    `Apex log ${row.logId} could not be synchronized.`,
                    { operation: 'sync', logId: row.logId, resolvedUsername: org.username },
                    { cause: error }
                  )
          });
        } finally {
          completed += 1;
          emit(callOptions, { operation: 'sync', phase: 'materializing', completed, total: rows.length });
        }
      });
      throwIfUnavailable('sync', callOptions?.signal);
      const newest = rows[0];
      const successful = failures.length === 0;
      const lastSyncedLogId = successful ? (newest?.logId ?? previous?.lastSyncedLogId) : previous?.lastSyncedLogId;
      const lastSyncedStartTime = successful
        ? (newest?.startTime ?? previous?.lastSyncedStartTime)
        : previous?.lastSyncedStartTime;
      const nextState: LifecycleSyncState = {
        ...state,
        orgs: {
          ...state.orgs,
          [org.username]: {
            lastSyncStartedAt: startedAt,
            lastSyncCompletedAt: new Date().toISOString(),
            lastSyncedLogId,
            lastSyncedStartTime,
            existingCount: existing,
            materializedCount: materialized,
            downloadedCount: downloaded,
            failedCount: failures.length
          }
        }
      };
      try {
        await writeJsonAtomic(syncStatePath(request.workspaceRoot), nextState);
      } catch (error) {
        throw stableError(
          'local-persistence',
          'sync',
          'Apex log sync state could not be persisted locally.',
          error,
          undefined,
          org.username
        );
      }
      const result: SyncApexLogsResult = {
        status: successful ? 'success' : 'partial',
        resolvedUsername: org.username,
        existing,
        materialized,
        downloaded,
        failures,
        checkpoint: {
          advanced: successful,
          lastLogId: lastSyncedLogId,
          lastStartTime: lastSyncedStartTime
        }
      };
      emit(callOptions, { operation: 'sync', phase: 'completed', completed: rows.length, total: rows.length });
      try {
        throwIfUnavailable('sync', callOptions?.signal);
      } catch (cancellation) {
        try {
          await writeJsonAtomic(syncStatePath(request.workspaceRoot), state);
        } catch (rollbackError) {
          throw stableError(
            'local-persistence',
            'sync',
            'A cancelled Apex log sync checkpoint could not be rolled back.',
            new AggregateError([cancellation, rollbackError]),
            undefined,
            org.username
          );
        }
        throw cancellation;
      }
      return result;
    },
    async status(request, callOptions): Promise<ApexLogStatusResult> {
      validateScope('status', request.workspaceRoot);
      throwIfUnavailable('status', callOptions?.signal);
      emit(callOptions, { operation: 'status', phase: 'started' });
      const state = await readLifecycleState('status', request.workspaceRoot);
      const requested = String(request.targetOrg || '').trim();
      const username = requested
        ? await localUsernameForSelector('status', request.workspaceRoot, requested)
        : Object.keys(state.orgs).sort()[0];
      const entry = username ? state.orgs[username] : undefined;
      let localLogCount: number;
      try {
        localLogCount = requested && !username ? 0 : await countLocalLogs(request.workspaceRoot, username || undefined);
      } catch (error) {
        throw stableError(
          'local-persistence',
          'status',
          'Local Apex logs could not be inspected.',
          error,
          undefined,
          username || undefined
        );
      }
      const result: ApexLogStatusResult = {
        resolvedUsername: username || undefined,
        localLogCount,
        hasCheckpoint: Boolean(entry?.lastSyncedLogId || entry?.lastSyncedStartTime),
        lastSyncStartedAt: entry?.lastSyncStartedAt,
        lastSyncCompletedAt: entry?.lastSyncCompletedAt,
        lastSyncedLogId: entry?.lastSyncedLogId,
        lastSyncedStartTime: entry?.lastSyncedStartTime,
        lastSync: {
          existing: entry?.existingCount ?? 0,
          materialized: entry?.materializedCount ?? 0,
          downloaded: entry?.downloadedCount ?? 0,
          failed: entry?.failedCount ?? 0
        }
      };
      emit(callOptions, { operation: 'status', phase: 'completed' });
      return result;
    },
    async triage(request, callOptions): Promise<TriageApexLogsResult> {
      validateScope('triage', request.workspaceRoot);
      throwIfUnavailable('triage', callOptions?.signal);
      emit(callOptions, { operation: 'triage', phase: 'started', total: request.logs.length });
      const entries: ApexLogTriageEntry[] = [];
      for (const log of request.logs) {
        try {
          emit(callOptions, {
            operation: 'triage',
            phase: 'triaging',
            logId: log.logId,
            completed: entries.length,
            total: request.logs.length
          });
          const file = await lifecycle.requireLocalPath(
            {
              workspaceRoot: request.workspaceRoot,
              targetOrg: request.targetOrg,
              log
            },
            callOptions
          );
          const body = await fs.readFile(
            file.localPath,
            callOptions?.signal ? { encoding: 'utf8', signal: callOptions.signal } : { encoding: 'utf8' }
          );
          throwIfUnavailable('triage', callOptions?.signal, log.logId);
          entries.push({ status: 'triaged', log, file, summary: summarizeLogText(body) });
        } catch (error) {
          if (error instanceof ApexLogLifecycleError && error.code === 'cancelled') throw error;
          const code =
            error instanceof ApexLogLifecycleError
              ? error.code
              : (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'not-found'
                : 'local-persistence';
          entries.push({
            status: 'failed',
            log,
            error: new ApexLogLifecycleError(
              code,
              `Apex log ${log.logId} could not be triaged.`,
              { operation: 'triage', logId: log.logId },
              { cause: error }
            )
          });
        }
      }
      emit(callOptions, {
        operation: 'triage',
        phase: 'completed',
        completed: entries.length,
        total: request.logs.length
      });
      return { entries };
    },
    async purge(request, callOptions): Promise<PurgeApexLogsResult> {
      validateScope('purge', request.workspaceRoot);
      throwIfUnavailable('purge', callOptions?.signal);
      emit(callOptions, { operation: 'purge', phase: 'started' });
      const keep = new Set(request.policy.keepLogIds ?? []);
      const maxAgeMs = Number.isFinite(request.policy.maxAgeMs)
        ? Math.max(0, request.policy.maxAgeMs)
        : Number.POSITIVE_INFINITY;
      const now = Date.now();
      const failures: ApexLogFailure[] = [];
      let inspected = 0;
      let removed = 0;
      let kept = 0;
      const requestedSelector = String(request.targetOrg || '').trim();
      let username = requestedSelector
        ? await localUsernameForSelector('purge', request.workspaceRoot, requestedSelector)
        : undefined;
      if (!username) {
        try {
          emit(callOptions, { operation: 'purge', phase: 'resolving-org' });
          username = (await options.remote.resolveOrg(request.targetOrg, callOptions?.signal)).username;
        } catch (error) {
          throwIfUnavailable('purge', callOptions?.signal);
          throw stableError('org-resolution', 'purge', 'The Apex log org could not be resolved for purge.', error);
        }
      }
      throwIfUnavailable('purge', callOptions?.signal);
      emit(callOptions, { operation: 'purge', phase: 'purging' });
      try {
        const apexlogsRoot = path.resolve(request.workspaceRoot, 'apexlogs');
        const orgsRoot = path.join(apexlogsRoot, 'orgs');
        const logsRoots: string[] = [];
        if ((await isRealDirectory(apexlogsRoot)) && (await isRealDirectory(orgsRoot))) {
          const orgRoot = path.join(orgsRoot, safeUsername(username));
          const logsRoot = path.join(orgRoot, 'logs');
          if ((await isRealDirectory(orgRoot)) && (await isRealDirectory(logsRoot))) logsRoots.push(logsRoot);
        }
        for (const logsRoot of logsRoots) {
          for (const day of await readDirectory(logsRoot)) {
            throwIfUnavailable('purge', callOptions?.signal);
            if (!day.isDirectory() || day.isSymbolicLink() || !/^(unknown-date|\d{4}-\d{2}-\d{2})$/.test(day.name)) {
              continue;
            }
            const dayRoot = path.join(logsRoot, day.name);
            for (const file of await readDirectory(dayRoot)) {
              throwIfUnavailable('purge', callOptions?.signal);
              if (!file.isFile() || file.isSymbolicLink()) continue;
              const match = /^(07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\.log$/.exec(file.name);
              if (!match?.[1]) continue;
              const logId = match[1];
              const filePath = path.resolve(dayRoot, file.name);
              if (filePath !== logsRoot && !filePath.startsWith(`${logsRoot}${path.sep}`)) continue;
              inspected += 1;
              if (keep.has(logId)) {
                kept += 1;
                continue;
              }
              try {
                const stat = await fs.lstat(filePath);
                if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs < maxAgeMs) {
                  kept += 1;
                  continue;
                }
                await fs.unlink(filePath);
                removed += 1;
              } catch (error) {
                failures.push({
                  logId,
                  error: new ApexLogLifecycleError(
                    'local-persistence',
                    `Apex log ${logId} could not be purged.`,
                    { operation: 'purge', logId, resolvedUsername: username },
                    { cause: error }
                  )
                });
              }
            }
          }
        }
      } catch (error) {
        throw stableError(
          'local-persistence',
          'purge',
          'Canonical Apex log storage could not be inspected for purge.',
          error,
          undefined,
          username
        );
      }
      emit(callOptions, { operation: 'purge', phase: 'completed', completed: inspected, total: inspected });
      return { inspected, removed, kept, failures };
    },
    dispose(): void {
      disposed = true;
      for (const pending of inFlight.values()) pending.controller.abort();
      inFlight.clear();
    }
  };
  return lifecycle as ApexLogLifecycle;
}
