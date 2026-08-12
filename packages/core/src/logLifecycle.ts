import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

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
  application?: string;
  status?: string;
  logLength?: number;
  logUser?: { name?: string };
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
  hasState: boolean;
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

let gitignoreUpdateQueue: Promise<void> = Promise.resolve();

async function ensureWorkspaceLogIgnore(workspaceRoot: string): Promise<void> {
  const update = async (): Promise<void> => {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    const stat = await fs.lstat(gitignorePath).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) return;
    const content = await fs.readFile(gitignorePath, 'utf8');
    const hasEntry = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .some(line => line === 'apexlogs' || line === 'apexlogs/' || line === '/apexlogs' || line === '/apexlogs/');
    if (hasEntry) return;
    const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    await fs.appendFile(gitignorePath, `${separator}apexlogs/\n`, 'utf8');
  };
  const current = gitignoreUpdateQueue.then(update, update);
  gitignoreUpdateQueue = current.catch(() => undefined);
  await current.catch(() => undefined);
}

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

async function ensureRealDirectoryPath(
  workspaceRoot: string,
  directoryPath: string,
  createMissing: boolean,
  treatNonDirectoryAsMissing = false
): Promise<boolean> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedDirectory = path.resolve(directoryPath);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Apex log directory escapes the workspace root: ${resolvedDirectory}`);
  }

  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  const inspectDirectory = async (current: string, mayCreate: boolean): Promise<boolean> => {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (!mayCreate) return false;
        try {
          await fs.mkdir(current);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        stat = await fs.lstat(current);
      } else {
        throw error;
      }
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Apex log directory must be a real directory: ${current}`);
    }
    if (!stat.isDirectory()) {
      if (treatNonDirectoryAsMissing) return false;
      throw new Error(`Apex log directory must be a real directory: ${current}`);
    }
    return true;
  };

  if (!(await inspectDirectory(resolvedRoot, false))) {
    throw new Error(`Apex log workspace root does not exist: ${resolvedRoot}`);
  }
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!(await inspectDirectory(current, createMissing))) return false;
  }
  return true;
}

async function ensureRegularFileOrAbsent(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Apex log state path must be a regular file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function findCanonicalLogPath(
  workspaceRoot: string,
  safeUsername: string,
  logId: string
): Promise<string | undefined> {
  const logsRoot = path.join(workspaceRoot, 'apexlogs', 'orgs', safeUsername, 'logs');
  if (!(await ensureRealDirectoryPath(workspaceRoot, logsRoot, false, true))) return undefined;
  const entries = await readDirectory(logsRoot);
  for (const entry of entries) {
    if (!/^(unknown-date|\d{4}-\d{2}-\d{2})$/.test(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dayRoot = path.join(logsRoot, entry.name);
    if (!(await ensureRealDirectoryPath(workspaceRoot, dayRoot, false, true))) continue;
    const candidate = path.join(dayRoot, `${logId}.log`);
    await ensureRegularFileOrAbsent(candidate);
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
  const apexlogsRoot = path.join(workspaceRoot, 'apexlogs');
  if (!(await ensureRealDirectoryPath(workspaceRoot, apexlogsRoot, false, true))) return undefined;
  const legacy = path.join(workspaceRoot, 'apexlogs', `${safe}_${logId}.log`);
  await ensureRegularFileOrAbsent(legacy);
  return (await isRegularFile(legacy)) ? legacy : undefined;
}

async function findLocalLogMatches(
  workspaceRoot: string,
  logId: string
): Promise<Array<{ username: string; localPath: string }>> {
  const matchesByUsername = new Map<string, { username: string; localPath: string }>();
  const orgsRoot = path.join(workspaceRoot, 'apexlogs', 'orgs');
  if (await ensureRealDirectoryPath(workspaceRoot, orgsRoot, false, true)) {
    for (const org of await readDirectory(orgsRoot)) {
      if (!org.isDirectory() && !org.isSymbolicLink()) continue;
      const orgRoot = path.join(orgsRoot, org.name);
      if (!(await ensureRealDirectoryPath(workspaceRoot, orgRoot, false, true))) continue;
      const localPath = await findCanonicalLogPath(workspaceRoot, org.name, logId);
      if (localPath) {
        const metadata = await readOrgMetadata(path.join(orgRoot, 'org.json'));
        matchesByUsername.set(org.name, { username: metadata?.username ?? org.name, localPath });
      }
    }
  }
  const apexlogsRoot = path.join(workspaceRoot, 'apexlogs');
  if (!(await ensureRealDirectoryPath(workspaceRoot, apexlogsRoot, false, true))) {
    return Array.from(matchesByUsername.values());
  }
  const suffix = `_${logId}.log`;
  for (const entry of await readDirectory(apexlogsRoot)) {
    if (!entry.name.endsWith(suffix) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const localPath = path.join(apexlogsRoot, entry.name);
    await ensureRegularFileOrAbsent(localPath);
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
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Apex log org metadata must be a regular file: ${filePath}`);
  }
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: Partial<OrgMetadata> & { resolvedUsername?: unknown };
  try {
    parsed = JSON.parse(raw) as Partial<OrgMetadata> & { resolvedUsername?: unknown };
  } catch {
    return undefined;
  }
  try {
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
  if (!(await ensureRealDirectoryPath(workspaceRoot, orgsRoot, false, true))) return [];
  for (const org of await readDirectory(orgsRoot)) {
    if (!org.isDirectory() && !org.isSymbolicLink()) continue;
    const orgRoot = path.join(orgsRoot, org.name);
    if (!(await ensureRealDirectoryPath(workspaceRoot, orgRoot, false, true))) continue;
    const metadata = await readOrgMetadata(path.join(orgRoot, 'org.json'));
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
  await ensureWorkspaceLogIgnore(workspaceRoot);
  const filePath = orgMetadataPath(workspaceRoot, org.username);
  await ensureRealDirectoryPath(workspaceRoot, path.dirname(filePath), true);
  await ensureRegularFileOrAbsent(filePath);
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
  await ensureRealDirectoryPath(workspaceRoot, path.dirname(localPath), true);
  await ensureRegularFileOrAbsent(localPath);
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

type SyncStateDocument = Record<string, unknown> & {
  orgs?: Record<string, Record<string, unknown>>;
};

const SYNC_STATE_LOCK_STALE_MS = 120_000;
const SYNC_STATE_LOCK_WAIT_MS = 30_000;
const SYNC_STATE_LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SyncStateLockOwner = Readonly<{ version: 1; pid: number; token: string }>;

function parseSyncStateLockOwner(value: string): SyncStateLockOwner | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<SyncStateLockOwner>;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      typeof parsed.token !== 'string' ||
      !SYNC_STATE_LOCK_TOKEN.test(parsed.token)
    ) {
      return undefined;
    }
    const owner = { version: 1, pid: Number(parsed.pid), token: parsed.token } as const;
    return JSON.stringify(owner) === value ? owner : undefined;
  } catch {
    return undefined;
  }
}

function isSyncStateLockOwnerDefinitelyDead(owner: SyncStateLockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function readSyncStateDocument(workspaceRoot: string): Promise<SyncStateDocument> {
  const filePath = syncStatePath(workspaceRoot);
  if (!(await ensureRealDirectoryPath(workspaceRoot, path.dirname(filePath), false))) return {};
  await ensureRegularFileOrAbsent(filePath);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as SyncStateDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function normalizeSyncState(parsed: SyncStateDocument): LifecycleSyncState {
  const orgs: LifecycleSyncState['orgs'] = {};
  for (const [username, entry] of Object.entries(parsed.orgs ?? {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
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
}

async function readSyncState(workspaceRoot: string): Promise<LifecycleSyncState> {
  return normalizeSyncState(await readSyncStateDocument(workspaceRoot));
}

async function withSyncStateLock<T>(
  workspaceRoot: string,
  ensureActive: () => void,
  action: () => Promise<T>
): Promise<T> {
  const lockPath = path.join(workspaceRoot, 'apexlogs', '.alv', 'sync-state.lock');
  await ensureRealDirectoryPath(workspaceRoot, path.dirname(lockPath), true);
  const token = randomUUID();
  const ownership = JSON.stringify({ version: 1, pid: process.pid, token } satisfies SyncStateLockOwner);
  const waitStartedAt = performance.now();
  const waitOrTimeout = async (): Promise<void> => {
    if (performance.now() - waitStartedAt >= SYNC_STATE_LOCK_WAIT_MS) {
      throw new Error(`Timed out waiting for shared Apex log sync-state lock at ${lockPath}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  for (;;) {
    ensureActive();
    try {
      await fs.writeFile(lockPath, ownership, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.lstat(lockPath).catch(statError => {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw statError;
      });
      if (stat === undefined) continue;
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Shared Apex log sync-state lock must be a regular file: ${lockPath}`);
      }
      if (Date.now() - stat.mtimeMs > SYNC_STATE_LOCK_STALE_MS) {
        let observedOwnership: string;
        try {
          observedOwnership = await fs.readFile(lockPath, 'utf8');
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw readError;
        }
        const observedOwner = parseSyncStateLockOwner(observedOwnership);
        if (observedOwner && isSyncStateLockOwnerDefinitelyDead(observedOwner)) {
          const reclaimMarker = `${lockPath}.reclaim-${observedOwner.token}`;
          let elected = false;
          try {
            await fs.writeFile(reclaimMarker, observedOwnership, { encoding: 'utf8', flag: 'wx' });
            elected = true;
          } catch (markerError) {
            if ((markerError as NodeJS.ErrnoException).code !== 'EEXIST') throw markerError;
          }
          if (elected) {
            let currentStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
            try {
              currentStat = await fs.lstat(lockPath);
            } catch (currentStatError) {
              if ((currentStatError as NodeJS.ErrnoException).code !== 'ENOENT') throw currentStatError;
            }
            if (currentStat !== undefined) {
              if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
                throw new Error(`Shared Apex log sync-state lock must be a regular file: ${lockPath}`);
              }
              let currentOwnership: string | undefined;
              try {
                currentOwnership = await fs.readFile(lockPath, 'utf8');
              } catch (currentReadError) {
                if ((currentReadError as NodeJS.ErrnoException).code !== 'ENOENT') throw currentReadError;
              }
              if (currentOwnership === observedOwnership) {
                try {
                  await fs.unlink(lockPath);
                } catch (unlinkError) {
                  if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
                }
              }
            }
            continue;
          }
        }
      }
      await waitOrTimeout();
    }
  }
  try {
    ensureActive();
    return await action();
  } finally {
    let lockStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      lockStat = await fs.lstat(lockPath);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
    }
    if (lockStat !== undefined) {
      if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
        throw new Error(`Shared Apex log sync-state lock must be a regular file: ${lockPath}`);
      }
      let currentOwnership: string | undefined;
      try {
        currentOwnership = await fs.readFile(lockPath, 'utf8');
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
      }
      if (currentOwnership === ownership) {
        try {
          await fs.unlink(lockPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        }
      }
    }
  }
}

async function writeSyncStateDocument(workspaceRoot: string, value: SyncStateDocument): Promise<void> {
  const filePath = syncStatePath(workspaceRoot);
  await ensureRealDirectoryPath(workspaceRoot, path.dirname(filePath), true);
  await ensureRegularFileOrAbsent(filePath);
  await writeJsonAtomic(filePath, value);
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

async function ensureLifecycleVersionMarker(workspaceRoot: string, versionPath: string): Promise<void> {
  await ensureRealDirectoryPath(workspaceRoot, path.dirname(versionPath), true);
  for (;;) {
    await ensureRegularFileOrAbsent(versionPath);
    let created: boolean;
    try {
      created = await writeFileAtomic(versionPath, '1\n', true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    if (created) return;

    await ensureRegularFileOrAbsent(versionPath);
    let raw: string;
    try {
      raw = await fs.readFile(versionPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let version: unknown;
    try {
      version = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Shared Apex log lifecycle version marker is not valid JSON: ${versionPath}`, {
        cause: error
      });
    }
    if (version !== 1) {
      throw new Error(`Unsupported shared Apex log lifecycle version at ${versionPath}: ${String(version)}`);
    }
    return;
  }
}

async function countLocalLogs(workspaceRoot: string, username: string | undefined): Promise<number> {
  const ids = new Set<string>();
  const collectCanonical = async (orgName: string): Promise<void> => {
    const logsRoot = path.join(workspaceRoot, 'apexlogs', 'orgs', safeUsername(orgName), 'logs');
    if (!(await ensureRealDirectoryPath(workspaceRoot, logsRoot, false, true))) return;
    const days = await readDirectory(logsRoot);
    for (const day of days) {
      if (!/^(unknown-date|\d{4}-\d{2}-\d{2})$/.test(day.name)) continue;
      if (!day.isDirectory() && !day.isSymbolicLink()) continue;
      const dayRoot = path.join(logsRoot, day.name);
      if (!(await ensureRealDirectoryPath(workspaceRoot, dayRoot, false, true))) continue;
      const files = await readDirectory(dayRoot);
      for (const file of files) {
        if (
          (file.isFile() || file.isSymbolicLink()) &&
          /^07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?\.log$/.test(file.name)
        ) {
          await ensureRegularFileOrAbsent(path.join(dayRoot, file.name));
          ids.add(file.name.slice(0, -4));
        }
      }
    }
  };
  if (username) {
    await collectCanonical(username);
  } else {
    const orgsRoot = path.join(workspaceRoot, 'apexlogs', 'orgs');
    if (await ensureRealDirectoryPath(workspaceRoot, orgsRoot, false, true)) {
      for (const org of await readDirectory(orgsRoot)) {
        if (!org.isDirectory() && !org.isSymbolicLink()) continue;
        const orgRoot = path.join(orgsRoot, org.name);
        if (await ensureRealDirectoryPath(workspaceRoot, orgRoot, false, true)) await collectCanonical(org.name);
      }
    }
  }
  const apexlogsRoot = path.join(workspaceRoot, 'apexlogs');
  if (!(await ensureRealDirectoryPath(workspaceRoot, apexlogsRoot, false, true))) return ids.size;
  const entries = await readDirectory(apexlogsRoot);
  const prefix = username ? `${safeUsername(username)}_` : undefined;
  for (const entry of entries) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || (prefix && !entry.name.startsWith(prefix))) continue;
    const match = /_(07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\.log$/.exec(entry.name);
    if (match?.[1]) {
      await ensureRegularFileOrAbsent(path.join(apexlogsRoot, entry.name));
      ids.add(match[1]);
    }
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
        const localStateDirectory = path.join(request.workspaceRoot, 'apexlogs', '.alv');
        await ensureRealDirectoryPath(request.workspaceRoot, localStateDirectory, true);
        await writeOrgMetadata(request.workspaceRoot, org);
        const versionPath = path.join(localStateDirectory, 'version.json');
        await ensureLifecycleVersionMarker(request.workspaceRoot, versionPath);
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
      const completedAt = new Date().toISOString();
      let lastSyncedLogId: string | undefined;
      let lastSyncedStartTime: string | undefined;
      let previousRawEntry: Record<string, unknown> | undefined;
      try {
        await withSyncStateLock(
          request.workspaceRoot,
          () => throwIfUnavailable('sync', callOptions?.signal),
          async () => {
            const document = await readSyncStateDocument(request.workspaceRoot);
            const latestState = normalizeSyncState(document);
            const latest = latestState.orgs[org.username];
            const candidateIsNewer =
              successful &&
              newest?.startTime &&
              (!latest?.lastSyncedStartTime ||
                newest.startTime > latest.lastSyncedStartTime ||
                (newest.startTime === latest.lastSyncedStartTime && newest.logId > (latest.lastSyncedLogId ?? '')));
            lastSyncedLogId = candidateIsNewer ? newest.logId : latest?.lastSyncedLogId;
            lastSyncedStartTime = candidateIsNewer ? newest.startTime : latest?.lastSyncedStartTime;

            const rawOrgs =
              document.orgs && typeof document.orgs === 'object' && !Array.isArray(document.orgs) ? document.orgs : {};
            const rawEntry = rawOrgs[org.username];
            previousRawEntry =
              rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry) ? { ...rawEntry } : undefined;
            const nextEntry: Record<string, unknown> = {
              ...previousRawEntry,
              lastSyncStartedAt: startedAt,
              lastSyncCompletedAt: completedAt,
              lastSyncedLogId,
              lastSyncedStartTime,
              existingCount: existing,
              materializedCount: materialized,
              downloadedCount: downloaded,
              failedCount: failures.length
            };
            const nextDocument: SyncStateDocument = {
              ...document,
              ...(!Object.hasOwn(document, 'version') ? { version: 1 } : {}),
              orgs: { ...rawOrgs, [org.username]: nextEntry }
            };
            await writeSyncStateDocument(request.workspaceRoot, nextDocument);
          }
        );
      } catch (error) {
        if (error instanceof ApexLogLifecycleError && error.code === 'cancelled') throw error;
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
          await withSyncStateLock(
            request.workspaceRoot,
            () => undefined,
            async () => {
              const document = await readSyncStateDocument(request.workspaceRoot);
              const rawOrgs =
                document.orgs && typeof document.orgs === 'object' && !Array.isArray(document.orgs)
                  ? document.orgs
                  : {};
              const current = rawOrgs[org.username];
              if (
                !current ||
                typeof current !== 'object' ||
                Array.isArray(current) ||
                current.lastSyncStartedAt !== startedAt ||
                current.lastSyncCompletedAt !== completedAt
              ) {
                return;
              }
              const restoredOrgs = { ...rawOrgs };
              if (previousRawEntry) restoredOrgs[org.username] = previousRawEntry;
              else delete restoredOrgs[org.username];
              await writeSyncStateDocument(request.workspaceRoot, { ...document, orgs: restoredOrgs });
            }
          );
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
        hasState: Boolean(entry),
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
