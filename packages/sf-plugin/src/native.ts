import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthInfo, ConfigAggregator, Connection, Org, OrgConfigProperties, StateAggregator } from '@salesforce/core';

import type {
  DebugLevelDeleteParams,
  DebugLevelGetParams,
  DebugLevelListParams,
  DebugLevelWriteParams,
  DebugLevelWriteResult,
  DoctorParams,
  DoctorResult,
  LogsDeleteParams,
  LogsDeleteResult,
  LogsListParams,
  LogsReadParams,
  LogsReadResult,
  LogsResolveParams,
  LogsResolveResult,
  LogsSyncParams,
  LogsSyncResult,
  LogsStatusParams,
  LogsStatusResult,
  LogsTriageEntry,
  LogsTriageParams,
  OrgAuth,
  OrgAuthParams,
  OrgListItem,
  OrgListParams,
  OrgResolveParams,
  OrgResolveResult,
  ResolveCachedLogPathParams,
  ResolveCachedLogPathResult,
  RuntimeDebugLevelRecord,
  RuntimeLogRow,
  RuntimeLogTriageSummary,
  SkillsInstallResult,
  ToolingQueryParams,
  ToolingQueryResult,
  ToolingRequestGetParams,
  TraceFlagApplyParams,
  TraceFlagApplyResult,
  TraceFlagRemoveParams,
  TraceFlagRemoveResult,
  TraceFlagTarget,
  TraceFlagTargetStatus,
  UserRecord,
  UserSearchParams,
  UserSearchResult
} from './contracts.js';

const LOG_STORE_LAYOUT_VERSION = 1;
const SYNC_PAGE_SIZE = 200;
const DEFAULT_API_VERSION = '63.0';
const SALESFORCE_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;
const DEBUG_LEVEL_FIELDS =
  'Id, DeveloperName, Language, MasterLabel, Workflow, Validation, Callout, ApexCode, ApexProfiling, ' +
  'Visualforce, System, Database, Wave, Nba, DataAccess';
const AUTOMATED_PROCESS_USER_TYPE = 'AutomatedProcess';
const PLATFORM_INTEGRATION_USER_TYPE = 'CloudIntegrationUser';

type JsonObject = Record<string, unknown>;

type QueryResult<TRecord = JsonObject> = {
  records?: TRecord[];
  totalSize?: number;
  done?: boolean;
  nextRecordsUrl?: string;
};

type ConnectionContext = {
  org: Org;
  connection: Connection;
  username: string;
  alias?: string;
  instanceUrl?: string;
};

type SyncState = {
  version: number;
  orgs: Record<string, SyncStateOrgEntry>;
};

type SyncStateOrgEntry = {
  targetOrg: string;
  safeTargetOrg: string;
  orgDir: string;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  lastSyncedLogId?: string;
  lastSyncedStartTime?: string;
  downloadedCount: number;
  cachedCount: number;
  lastError?: string;
};

type OrgMetadata = {
  targetOrg: string;
  safeTargetOrg: string;
  resolvedUsername: string;
  alias?: string;
  instanceUrl?: string;
  updatedAt: string;
};

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
  json: boolean;
};

function packageVersion(): string {
  return process.env.ALVE_PLUGIN_VERSION || process.env.npm_package_version || '0.0.0';
}

function nowIso(): string {
  return new Date().toISOString();
}

function stripTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function safeTargetOrg(value: string | undefined): string {
  const safe = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.@-]+/g, '_');
  return safe || 'default';
}

function resolveApexlogsRoot(workspaceRoot?: string): string {
  const root = String(workspaceRoot || '').trim();
  return root ? path.join(root, 'apexlogs') : path.join(os.tmpdir(), 'apexlogs');
}

function versionFilePath(workspaceRoot?: string): string {
  return path.join(resolveApexlogsRoot(workspaceRoot), '.alv', 'version.json');
}

function syncStatePath(workspaceRoot?: string): string {
  return path.join(resolveApexlogsRoot(workspaceRoot), '.alv', 'sync-state.json');
}

function orgDir(workspaceRoot: string | undefined, username: string): string {
  return path.join(resolveApexlogsRoot(workspaceRoot), 'orgs', safeTargetOrg(username));
}

function logDayDirName(startTime?: string): string {
  const day = String(startTime || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'unknown-date';
}

function logFilePath(workspaceRoot: string | undefined, username: string, logId: string, startTime?: string): string {
  return path.join(orgDir(workspaceRoot, username), 'logs', logDayDirName(startTime), `${logId}.log`);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeVersionFile(workspaceRoot?: string): Promise<void> {
  await writeJson(versionFilePath(workspaceRoot), LOG_STORE_LAYOUT_VERSION);
}

async function readSyncState(workspaceRoot?: string): Promise<SyncState> {
  return readJson<SyncState>(syncStatePath(workspaceRoot), {
    version: LOG_STORE_LAYOUT_VERSION,
    orgs: {}
  });
}

async function writeSyncState(workspaceRoot: string | undefined, state: SyncState): Promise<void> {
  state.version = LOG_STORE_LAYOUT_VERSION;
  await writeJson(syncStatePath(workspaceRoot), state);
}

async function writeOrgMetadata(workspaceRoot: string | undefined, metadata: OrgMetadata): Promise<void> {
  await writeJson(path.join(orgDir(workspaceRoot, metadata.resolvedUsername), 'org.json'), metadata);
}

async function readOrgMetadata(filePath: string): Promise<OrgMetadata | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as OrgMetadata;
  } catch {
    return undefined;
  }
}

function escapeSoqlLiteral(value: string): string {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function escapeSoqlLikeLiteral(value: string): string {
  return String(value || '').replace(/[\\'%_]/g, char => {
    if (char === '\\') return '\\\\';
    if (char === "'") return "\\'";
    return `\\${char}`;
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function isSalesforceId(value: unknown): value is string {
  return typeof value === 'string' && SALESFORCE_ID_REGEX.test(value);
}

export function parseApexLogIds(value: string | null | undefined): string[] {
  const ids = new Set<string>();
  for (const token of (value ?? '').split(/[\s,]+/)) {
    const id = token.trim();
    if (isSalesforceId(id)) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}

export async function readApexLogIdsFile(filePath: string, cwd = process.cwd()): Promise<string[]> {
  const requested = asString(filePath);
  if (!requested) return [];
  const resolvedPath = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested);
  return parseApexLogIds(await fs.readFile(resolvedPath, 'utf8'));
}

export async function resolveLogDeleteIds(params: {
  ids?: string;
  idsProvided?: boolean;
  idsFile?: string;
  idsFileProvided?: boolean;
  cwd?: string;
}): Promise<string[] | undefined> {
  const inlineProvided = Boolean(params.idsProvided);
  const idsFileProvided = Boolean(params.idsFileProvided);
  const inlineIds = parseApexLogIds(params.ids);
  if (inlineProvided && !params.ids) {
    throw new Error('The --ids flag requires a comma-separated ApexLog id list.');
  }
  if (inlineProvided && inlineIds.length === 0) {
    throw new Error('No valid ApexLog ids were found in --ids.');
  }
  if (!idsFileProvided) {
    return inlineIds.length > 0 ? inlineIds : undefined;
  }
  if (!params.idsFile) {
    throw new Error('The --ids-file flag requires a file path.');
  }
  const fileIds = await readApexLogIdsFile(params.idsFile, params.cwd ?? process.cwd());
  if (fileIds.length === 0) {
    throw new Error(`No valid ApexLog ids were found in --ids-file: ${params.idsFile}`);
  }
  return Array.from(new Set([...inlineIds, ...fileIds]));
}

async function getDefaultTargetOrg(): Promise<string | undefined> {
  const aggregator = await ConfigAggregator.create();
  return asString(aggregator.getPropertyValue<string>(OrgConfigProperties.TARGET_ORG));
}

async function stateAggregator(forceRefresh?: boolean): Promise<StateAggregator> {
  if (forceRefresh) {
    const aggregatorType = StateAggregator as typeof StateAggregator & {
      clearInstanceAsync?: () => Promise<void>;
    };
    if (aggregatorType.clearInstanceAsync) {
      await aggregatorType.clearInstanceAsync();
    } else {
      aggregatorType.clearInstance();
    }
  }
  return StateAggregator.getInstance();
}

async function findAliasForUsername(username: string): Promise<string | undefined> {
  const state = await stateAggregator();
  return asString(state.aliases.get(username));
}

async function resolveUsername(
  usernameOrAlias?: string
): Promise<{ requested: string; username: string; alias?: string; source: string }> {
  const requested = asString(usernameOrAlias) ?? (await getDefaultTargetOrg()) ?? '';
  if (!requested) {
    throw new Error('No default Salesforce org is configured. Select an org or run "sf org login web".');
  }
  const state = await stateAggregator();
  const username = state.aliases.resolveUsername(requested);
  const alias = state.aliases.resolveAlias(requested) ?? state.aliases.get(username) ?? undefined;
  return {
    requested,
    username,
    alias: asString(alias),
    source: requested === username ? 'username' : 'alias'
  };
}

async function getConnectionContext(targetOrg?: string): Promise<ConnectionContext> {
  const resolved = await resolveUsername(targetOrg);
  const authInfo = await AuthInfo.create({ username: resolved.username });
  const connection = await Connection.create({ authInfo });
  await alignConnectionApiVersion(connection);
  const org = await Org.create({ connection });
  const fields = authInfo.getFields(true);
  const username = asString(connection.getUsername()) ?? asString(fields.username) ?? resolved.username;
  const instanceUrl =
    asString(fields.instanceUrl) ?? asString((connection as unknown as { instanceUrl?: string }).instanceUrl);
  return {
    org,
    connection,
    username,
    alias: resolved.alias,
    instanceUrl
  };
}

async function getOrgAuthFromCore(params: OrgAuthParams = {}): Promise<OrgAuth> {
  const ctx = await getConnectionContext(params.username);
  const fields = ctx.connection.getAuthInfo().getFields(true);
  const accessToken =
    asString((ctx.connection as unknown as { accessToken?: string }).accessToken) ?? asString(fields.accessToken);
  const instanceUrl =
    asString(fields.instanceUrl) ??
    asString((ctx.connection as unknown as { instanceUrl?: string }).instanceUrl) ??
    ctx.instanceUrl;
  if (!accessToken || !instanceUrl) {
    throw new Error('Unable to retrieve Salesforce org authentication from @salesforce/core.');
  }
  return {
    accessToken,
    instanceUrl,
    username: ctx.username
  };
}

async function listOrgsNative(params: OrgListParams = {}): Promise<OrgListItem[]> {
  const state = await stateAggregator(params.forceRefresh);
  const orgs = await state.orgs.readAll(false);
  const defaultOrg = await getDefaultTargetOrg();
  const defaultDevHub = asString(
    (await ConfigAggregator.create()).getPropertyValue<string>(OrgConfigProperties.TARGET_DEV_HUB)
  );
  const mapped = orgs
    .map(fields => {
      const username = asString(fields.username);
      if (!username) return undefined;
      const alias = asString(state.aliases.get(username));
      const item: OrgListItem = {
        username,
        alias,
        isDefaultUsername: Boolean(defaultOrg && (defaultOrg === username || defaultOrg === alias)),
        isDefaultDevHubUsername: Boolean(defaultDevHub && (defaultDevHub === username || defaultDevHub === alias)),
        isScratchOrg: Boolean(fields.isScratch),
        instanceUrl: asString(fields.instanceUrl)
      };
      return item;
    })
    .filter((item): item is OrgListItem => item !== undefined);
  const dedup = new Map<string, OrgListItem>();
  for (const org of mapped) {
    dedup.set(org.username, org);
  }
  return Array.from(dedup.values()).sort((left, right) => {
    if (left.isDefaultUsername && !right.isDefaultUsername) return -1;
    if (!left.isDefaultUsername && right.isDefaultUsername) return 1;
    return (left.alias || left.username).localeCompare(right.alias || right.username);
  });
}

async function resolveOrgNative(params: OrgResolveParams = {}): Promise<OrgResolveResult> {
  const resolved = await resolveUsername(params.targetOrg);
  const ctx = await getConnectionContext(resolved.username);
  return {
    requested: resolved.requested,
    username: ctx.username,
    alias: resolved.alias,
    instanceUrl: ctx.instanceUrl,
    source: resolved.source
  };
}

export async function toolingQuery<TRecord = JsonObject>(
  connection: Connection,
  soql: string
): Promise<QueryResult<TRecord>> {
  const firstPage = (await connection.tooling.query(soql)) as QueryResult<TRecord>;
  const records = [...(firstPage.records || [])];
  let page = firstPage;
  while (!page.done && page.nextRecordsUrl) {
    page = (await connection.tooling.queryMore(page.nextRecordsUrl)) as QueryResult<TRecord>;
    records.push(...(page.records || []));
  }
  return {
    ...firstPage,
    records,
    done: page.done,
    nextRecordsUrl: page.nextRecordsUrl
  };
}

async function standardQuery<TRecord = JsonObject>(
  connection: Connection,
  soql: string
): Promise<QueryResult<TRecord>> {
  return (await connection.query(soql)) as QueryResult<TRecord>;
}

function apiVersion(connection: Connection): string {
  return connection.getApiVersion?.() || DEFAULT_API_VERSION;
}

function numericApiVersion(value: string | undefined): number | undefined {
  const match = String(value || '').match(/^\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function shouldUseOrgMaxApiVersion(
  configuredVersion: string | undefined,
  orgMaxVersion: string | undefined
): boolean {
  const configured = numericApiVersion(configuredVersion);
  const orgMax = numericApiVersion(orgMaxVersion);
  return configured !== undefined && orgMax !== undefined && configured > orgMax;
}

export async function alignConnectionApiVersion(
  connection: Pick<Connection, 'getApiVersion' | 'setApiVersion' | 'retrieveMaxApiVersion'>
): Promise<string> {
  const configuredVersion = connection.getApiVersion?.() || DEFAULT_API_VERSION;
  const orgMaxVersion = await connection.retrieveMaxApiVersion();
  if (shouldUseOrgMaxApiVersion(configuredVersion, orgMaxVersion)) {
    connection.setApiVersion(orgMaxVersion);
    return orgMaxVersion;
  }
  return configuredVersion;
}

async function connectionRequest<T = unknown>(
  connection: Connection,
  method: string,
  pathOrUrl: string,
  body?: unknown
): Promise<T> {
  const request: JsonObject = {
    method,
    url: pathOrUrl
  };
  if (body !== undefined) {
    request.body = typeof body === 'string' ? body : JSON.stringify(body);
    request.headers = { 'Content-Type': 'application/json' };
  }
  return (await connection.request(request as never)) as T;
}

export function resolveOrgRequestPath(ctx: Pick<ConnectionContext, 'instanceUrl'>, pathOrUrl: string): string {
  const trimmed = pathOrUrl.trim();
  if (!trimmed) {
    throw new Error('Tooling request path is required.');
  }
  if (!URL.canParse(trimmed)) {
    return trimmed;
  }
  if (!ctx.instanceUrl || !URL.canParse(ctx.instanceUrl)) {
    throw new Error('Cannot validate absolute tooling request URL because the org instance URL is unavailable.');
  }
  const requested = new URL(trimmed);
  const instance = new URL(ctx.instanceUrl);
  if (requested.origin !== instance.origin) {
    throw new Error('Absolute tooling request URLs must target the authenticated org instance.');
  }
  return `${requested.pathname}${requested.search}${requested.hash}`;
}

async function listLogsNative(params: LogsListParams = {}): Promise<RuntimeLogRow[]> {
  const ctx = await getConnectionContext(params.username);
  const limit = clampInt(params.limit, 50, 1, 200);
  const offset = clampInt(params.offset, 0, 0, 2000);
  const soql = buildApexLogListSoql({ limit, offset, cursor: params.cursor });
  const result = await toolingQuery<RuntimeLogRow>(ctx.connection, soql);
  return Array.isArray(result.records) ? result.records : [];
}

export function normalizeSoqlDateTimeLiteral(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

export function buildApexLogListSoql(params: {
  limit: number;
  offset: number;
  cursor?: LogsListParams['cursor'];
}): string {
  const baseSelect =
    'SELECT Id, StartTime, Operation, Application, DurationMilliseconds, Status, Request, LogLength, LogUser.Name FROM ApexLog';
  const cursor = params.cursor;
  const beforeStartTime = normalizeSoqlDateTimeLiteral(cursor?.beforeStartTime);
  const beforeId = cursor?.beforeId;
  if (beforeStartTime && isSalesforceId(beforeId)) {
    const id = escapeSoqlLiteral(beforeId);
    return `${baseSelect} WHERE StartTime < ${beforeStartTime} OR (StartTime = ${beforeStartTime} AND Id < '${id}') ORDER BY StartTime DESC, Id DESC LIMIT ${params.limit}`;
  }
  return `${baseSelect} ORDER BY StartTime DESC, Id DESC LIMIT ${params.limit} OFFSET ${params.offset}`;
}

async function fetchLogBody(ctx: ConnectionContext, logId: string): Promise<string> {
  const value = await connectionRequest<unknown>(
    ctx.connection,
    'GET',
    `/services/data/v${apiVersion(ctx.connection)}/tooling/sobjects/ApexLog/${logId}/Body`
  );
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
}

export async function writeLogBody(
  workspaceRoot: string | undefined,
  username: string,
  row: Pick<RuntimeLogRow, 'Id' | 'StartTime'>,
  body: string
): Promise<{ path: string; downloaded: boolean }> {
  const filePath = logFilePath(workspaceRoot, username, row.Id, row.StartTime);
  try {
    await fs.access(filePath);
    return { path: filePath, downloaded: false };
  } catch {}
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, body, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {}
    throw error;
  }
  return { path: filePath, downloaded: true };
}

export async function removeLegacyLogIndexFiles(workspaceRoot: string | undefined): Promise<string[]> {
  const removed: string[] = [];
  const alvRoot = path.join(resolveApexlogsRoot(workspaceRoot), '.alv');
  for (const fileName of ['log-index.sqlite', 'log-index.sqlite-wal', 'log-index.sqlite-shm']) {
    const filePath = path.join(alvRoot, fileName);
    try {
      await fs.rm(filePath, { force: true });
      removed.push(filePath);
    } catch {}
  }
  return removed;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findCachedLogPath(
  workspaceRoot: string | undefined,
  logId: string,
  username?: string
): Promise<string | undefined> {
  const logsRootForOrg = (orgName: string) => path.join(orgDir(workspaceRoot, orgName), 'logs');
  const findInLogsDir = async (logsRoot: string): Promise<string | undefined> => {
    let days: import('node:fs').Dirent[];
    try {
      days = await fs.readdir(logsRoot, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const day of days) {
      if (!day.isDirectory() || !/^(unknown-date|\d{4}-\d{2}-\d{2})$/.test(day.name)) continue;
      const candidate = path.join(logsRoot, day.name, `${logId}.log`);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {}
    }
    return undefined;
  };

  if (username) {
    return findInLogsDir(logsRootForOrg(username));
  }
  const orgsRoot = path.join(resolveApexlogsRoot(workspaceRoot), 'orgs');
  let orgDirs: import('node:fs').Dirent[];
  try {
    orgDirs = await fs.readdir(orgsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const orgEntry of orgDirs) {
    if (!orgEntry.isDirectory()) continue;
    const found = await findInLogsDir(path.join(orgsRoot, orgEntry.name, 'logs'));
    if (found) return found;
  }
  return undefined;
}

async function readCachedLog(logId: string, filePath: string, maxBytes?: number): Promise<LogsReadResult> {
  const bytes = await fs.readFile(filePath);
  const byteLimit = maxBytes ? Math.max(1, Math.floor(maxBytes)) : undefined;
  const bodyBytes = byteLimit ? bytes.subarray(0, byteLimit) : bytes;
  return {
    logId,
    path: filePath,
    body: bodyBytes.toString('utf8'),
    sizeBytes: bytes.length,
    truncated: Boolean(byteLimit && bytes.length > byteLimit)
  };
}

export async function materializeCachedLogAtDatedPath(
  workspaceRoot: string | undefined,
  username: string,
  row: Pick<RuntimeLogRow, 'Id' | 'StartTime'>
): Promise<string | undefined> {
  const datedPath = logFilePath(workspaceRoot, username, row.Id, row.StartTime);
  if (await fileExists(datedPath)) return datedPath;
  const existing = await findCachedLogPath(workspaceRoot, row.Id, username);
  if (!existing) return undefined;
  const body = await fs.readFile(existing, 'utf8');
  return (await writeLogBody(workspaceRoot, username, row, body)).path;
}

async function logsResolveNative(params: LogsResolveParams): Promise<LogsResolveResult> {
  const target = asString(params.targetOrg);
  let username = target;
  if (target) {
    username = (await resolveUsername(target)).username;
  }
  const found = await findCachedLogPath(params.workspaceRoot, params.logId, username);
  return { logId: params.logId, path: found, cached: Boolean(found) };
}

async function resolveCachedLogPathNative(params: ResolveCachedLogPathParams): Promise<ResolveCachedLogPathResult> {
  return { path: await findCachedLogPath(params.workspaceRoot, params.logId, params.username) };
}

async function logsReadNative(params: LogsReadParams): Promise<LogsReadResult> {
  const target = asString(params.targetOrg);
  const localCached = target
    ? await findCachedLogPath(params.workspaceRoot, params.logId, target)
    : await findCachedLogPath(params.workspaceRoot, params.logId);
  if (localCached) return readCachedLog(params.logId, localCached, params.maxBytes);

  let ctx: ConnectionContext;
  try {
    ctx = await getConnectionContext(params.targetOrg);
  } catch (error) {
    if (target) {
      const offlineCached = await findCachedLogPath(params.workspaceRoot, params.logId);
      if (offlineCached) return readCachedLog(params.logId, offlineCached, params.maxBytes);
    }
    throw error;
  }
  const cached = await findCachedLogPath(params.workspaceRoot, params.logId, ctx.username);
  if (cached) return readCachedLog(params.logId, cached, params.maxBytes);

  const body = await fetchLogBody(ctx, params.logId);
  const row = { Id: params.logId };
  const saved = await writeLogBody(params.workspaceRoot, ctx.username, row, body);
  const buffer = Buffer.from(body, 'utf8');
  const maxBytes = params.maxBytes ? Math.max(1, Math.floor(params.maxBytes)) : undefined;
  return {
    logId: params.logId,
    path: saved.path,
    body: maxBytes ? buffer.subarray(0, maxBytes).toString('utf8') : body,
    sizeBytes: buffer.length,
    truncated: Boolean(maxBytes && buffer.length > maxBytes)
  };
}

async function runLimited<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (index < items.length) {
      const item = items[index++]!;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function logsSyncNative(params: LogsSyncParams = {}): Promise<LogsSyncResult> {
  const ctx = await getConnectionContext(params.targetOrg);
  const workspaceRoot = params.workspaceRoot;
  await writeVersionFile(workspaceRoot);
  await removeLegacyLogIndexFiles(workspaceRoot);
  const startedAt = nowIso();
  const safeOrg = safeTargetOrg(ctx.username);
  const state = await readSyncState(workspaceRoot);
  const previous = state.orgs[ctx.username];
  let cursor: { beforeStartTime: string; beforeId: string } | undefined;
  let downloaded = 0;
  let cached = 0;
  let failed = 0;
  let newest: { id: string; startTime?: string } | undefined;
  const seen = new Set<string>();
  const concurrency = clampInt(params.concurrency, 6, 1, 8);

  for (;;) {
    const rows = await listLogsNative({
      username: ctx.username,
      limit: SYNC_PAGE_SIZE,
      cursor,
      offset: 0
    });
    if (rows.length === 0) break;
    const pageRows: RuntimeLogRow[] = [];
    let reachedCheckpoint = false;
    for (const row of rows) {
      if (!row.Id || seen.has(row.Id)) continue;
      seen.add(row.Id);
      if (
        !params.forceFull &&
        previous &&
        ((previous.lastSyncedLogId && previous.lastSyncedLogId === row.Id) ||
          (!previous.lastSyncedLogId && previous.lastSyncedStartTime && previous.lastSyncedStartTime === row.StartTime))
      ) {
        reachedCheckpoint = true;
        break;
      }
      pageRows.push(row);
    }
    const completedIds = new Set<string>();
    await runLimited(pageRows, concurrency, async row => {
      try {
        const existing = await materializeCachedLogAtDatedPath(workspaceRoot, ctx.username, row);
        if (existing) {
          cached += 1;
          completedIds.add(row.Id);
          return;
        }
        const body = await fetchLogBody(ctx, row.Id);
        const saved = await writeLogBody(workspaceRoot, ctx.username, row, body);
        if (saved.downloaded) downloaded += 1;
        else cached += 1;
        completedIds.add(row.Id);
      } catch {
        failed += 1;
      }
    });
    if (!newest) {
      const checkpointRow = pageRows.find(row => row.Id && completedIds.has(row.Id));
      if (checkpointRow?.Id) {
        newest = { id: checkpointRow.Id, startTime: checkpointRow.StartTime };
      }
    }
    const last = rows.at(-1);
    if (reachedCheckpoint || rows.length < SYNC_PAGE_SIZE || !last?.StartTime || !last?.Id) break;
    cursor = { beforeStartTime: last.StartTime, beforeId: last.Id };
  }

  const status = failed > 0 ? 'partial' : 'success';
  const finishedAt = nowIso();
  if (status === 'success') {
    state.orgs[ctx.username] = {
      targetOrg: ctx.username,
      safeTargetOrg: safeOrg,
      orgDir: `apexlogs/orgs/${safeOrg}`,
      lastSyncStartedAt: startedAt,
      lastSyncCompletedAt: finishedAt,
      lastSyncedLogId: newest?.id ?? previous?.lastSyncedLogId,
      lastSyncedStartTime: newest?.startTime ?? previous?.lastSyncedStartTime,
      downloadedCount: downloaded,
      cachedCount: cached
    };
    await writeSyncState(workspaceRoot, state);
  }
  await writeOrgMetadata(workspaceRoot, {
    targetOrg: params.targetOrg || ctx.username,
    safeTargetOrg: safeOrg,
    resolvedUsername: ctx.username,
    alias: ctx.alias,
    instanceUrl: ctx.instanceUrl,
    updatedAt: finishedAt
  });
  return {
    status,
    target_org: ctx.username,
    safe_target_org: safeOrg,
    downloaded,
    cached,
    failed,
    checkpoint_advanced: status === 'success',
    state_file: syncStatePath(workspaceRoot),
    last_synced_log_id: newest?.id ?? previous?.lastSyncedLogId
  };
}

async function countLocalLogs(workspaceRoot: string | undefined, username?: string): Promise<number> {
  const ids = new Set<string>();
  const collectFromLogsRoot = async (logsRoot: string): Promise<void> => {
    let days: import('node:fs').Dirent[];
    try {
      days = await fs.readdir(logsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const day of days) {
      if (!day.isDirectory() || !/^(unknown-date|\d{4}-\d{2}-\d{2})$/.test(day.name)) continue;
      let files: import('node:fs').Dirent[];
      try {
        files = await fs.readdir(path.join(logsRoot, day.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.isFile() && file.name.endsWith('.log')) {
          ids.add(path.basename(file.name, '.log'));
        }
      }
    }
  };
  if (username) {
    await collectFromLogsRoot(path.join(orgDir(workspaceRoot, username), 'logs'));
    return ids.size;
  }
  const orgsRoot = path.join(resolveApexlogsRoot(workspaceRoot), 'orgs');
  let orgDirs: import('node:fs').Dirent[];
  try {
    orgDirs = await fs.readdir(orgsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of orgDirs) {
    if (entry.isDirectory()) {
      await collectFromLogsRoot(path.join(orgsRoot, entry.name, 'logs'));
    }
  }
  return ids.size;
}

async function findLocalOrgByAlias(
  workspaceRoot: string | undefined,
  alias: string,
  syncState: SyncState
): Promise<string | undefined> {
  const orgsRoot = path.join(resolveApexlogsRoot(workspaceRoot), 'orgs');
  let orgDirs: import('node:fs').Dirent[];
  try {
    orgDirs = await fs.readdir(orgsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const matches: OrgMetadata[] = [];
  for (const entry of orgDirs) {
    if (!entry.isDirectory()) continue;
    const metadata = await readOrgMetadata(path.join(orgsRoot, entry.name, 'org.json'));
    if (metadata?.alias === alias) {
      matches.push(metadata);
    }
  }
  matches.sort((left, right) => {
    const leftState = syncState.orgs[left.resolvedUsername];
    const rightState = syncState.orgs[right.resolvedUsername];
    const leftKey = `${leftState ? '1' : '0'}:${leftState?.lastSyncCompletedAt ?? ''}:${left.updatedAt}:${left.resolvedUsername}`;
    const rightKey = `${rightState ? '1' : '0'}:${rightState?.lastSyncCompletedAt ?? ''}:${right.updatedAt}:${right.resolvedUsername}`;
    return rightKey.localeCompare(leftKey);
  });
  return matches[0]?.resolvedUsername;
}

async function resolveLocalStatusOrg(
  workspaceRoot: string | undefined,
  targetOrg: string | undefined,
  syncState: SyncState
): Promise<string> {
  const requested = asString(targetOrg);
  if (requested) {
    if (requested.includes('@') || syncState.orgs[requested]) return requested;
    return (await findLocalOrgByAlias(workspaceRoot, requested, syncState)) ?? requested;
  }
  return Object.keys(syncState.orgs).sort()[0] ?? 'default';
}

async function logsStatusNative(params: LogsStatusParams = {}): Promise<LogsStatusResult> {
  const workspaceRoot = asString(params.workspaceRoot) || undefined;
  const effectiveWorkspaceRoot = workspaceRoot ?? path.dirname(resolveApexlogsRoot(undefined));
  const syncState = await readSyncState(workspaceRoot);
  const targetOrg = await resolveLocalStatusOrg(workspaceRoot, params.targetOrg, syncState);
  const safeOrg = safeTargetOrg(targetOrg);
  const entry = syncState.orgs[targetOrg];
  return {
    target_org: targetOrg,
    safe_target_org: safeOrg,
    workspace_root: effectiveWorkspaceRoot,
    apexlogs_root: resolveApexlogsRoot(workspaceRoot),
    state_file: syncStatePath(workspaceRoot),
    log_count: await countLocalLogs(workspaceRoot, targetOrg === 'default' && !entry ? undefined : targetOrg),
    has_state: Boolean(entry),
    last_sync_started_at: entry?.lastSyncStartedAt,
    last_sync_completed_at: entry?.lastSyncCompletedAt,
    last_synced_log_id: entry?.lastSyncedLogId,
    last_synced_start_time: entry?.lastSyncedStartTime,
    downloaded_count: entry?.downloadedCount ?? 0,
    cached_count: entry?.cachedCount ?? 0,
    last_error: entry?.lastError
  };
}

function extractLogEventType(line: string): string | undefined {
  const parts = String(line || '').split('|');
  return asString(parts.length > 1 ? parts[1] : undefined);
}

function tokenizeEventType(eventType: string): string[] {
  return eventType
    .split(/[^a-zA-Z]+/)
    .filter(Boolean)
    .map(token => token.toUpperCase());
}

function isErrorToken(token: string): boolean {
  return [
    'EXCEPTION',
    'ERROR',
    'FATAL',
    'FAIL',
    'FAILED',
    'FAILURE',
    'FAULT',
    'ASSERT',
    'ASSERTION',
    'VALIDATION',
    'ROLLBACK'
  ].includes(token);
}

function classifyLogLine(line: string, lineNumber: number): RuntimeLogTriageSummary['reasons'][number] | undefined {
  const eventType = extractLogEventType(line);
  if (!eventType) return undefined;
  const tokens = tokenizeEventType(eventType);
  if (!tokens.some(isErrorToken)) return undefined;
  let code = 'suspicious_error_payload';
  let severity = 'warning';
  let summary = `Potential error event (${eventType})`;
  if (tokens.some(token => token === 'ASSERT' || token === 'ASSERTION')) {
    code = 'assertion_failure';
    severity = 'error';
    summary = 'Assertion failure';
  } else if (tokens.includes('VALIDATION')) {
    code = 'validation_failure';
    severity = 'error';
    summary = 'Validation failure';
  } else if (tokens.includes('DML')) {
    code = 'dml_failure';
    severity = 'error';
    summary = 'DML failure';
  } else if (tokens.includes('ROLLBACK')) {
    code = 'rollback_detected';
    summary = 'Rollback detected';
  } else if (tokens.some(token => token === 'EXCEPTION' || token === 'FATAL')) {
    code = 'fatal_exception';
    severity = 'error';
    summary = 'Fatal exception';
  }
  return { code, severity, summary, line: lineNumber, eventType };
}

function summarizeLogText(logText: string): RuntimeLogTriageSummary {
  const lines = String(logText || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const diagnostic = classifyLogLine(lines[index] || '', index + 1);
    if (diagnostic) {
      return {
        hasErrors: diagnostic.severity === 'error',
        primaryReason: diagnostic.summary,
        reasons: [diagnostic]
      };
    }
  }
  return { hasErrors: false, reasons: [] };
}

function unreadableLogSummary(message: string): RuntimeLogTriageSummary {
  return {
    hasErrors: false,
    primaryReason: message,
    reasons: [
      {
        code: 'log_unreadable',
        severity: 'warning',
        summary: message
      }
    ]
  };
}

async function logsTriageNative(params: LogsTriageParams): Promise<LogsTriageEntry[]> {
  const target = asString(params.username);
  let ctx: ConnectionContext | undefined;
  let triedConnectionContext = false;
  const resolveContext = async (): Promise<ConnectionContext | undefined> => {
    if (triedConnectionContext) return ctx;
    triedConnectionContext = true;
    try {
      ctx = await getConnectionContext(target);
    } catch {
      ctx = undefined;
    }
    return ctx;
  };
  const entries: LogsTriageEntry[] = [];
  for (const logId of params.logIds || []) {
    let filePath = await findCachedLogPath(params.workspaceRoot, logId, target);
    let resolvedContext = ctx;
    if (!filePath) {
      resolvedContext = await resolveContext();
      filePath = resolvedContext
        ? await findCachedLogPath(params.workspaceRoot, logId, resolvedContext.username)
        : await findCachedLogPath(params.workspaceRoot, logId);
    }
    if (!filePath && resolvedContext) {
      try {
        const body = await fetchLogBody(resolvedContext, logId);
        await writeLogBody(
          params.workspaceRoot,
          resolvedContext.username,
          { Id: logId, StartTime: params.logStartTimes?.[logId] },
          body
        );
        entries.push({ logId, summary: summarizeLogText(body) });
        continue;
      } catch (error) {
        entries.push({
          logId,
          summary: unreadableLogSummary(error instanceof Error ? error.message : 'Log body could not be downloaded')
        });
        continue;
      }
    }
    if (!filePath) {
      entries.push({
        logId,
        summary: unreadableLogSummary('Log body is not available locally yet')
      });
      continue;
    }
    try {
      const body = await fs.readFile(filePath, 'utf8');
      entries.push({ logId, summary: summarizeLogText(body) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Log body could not be read';
      entries.push({
        logId,
        summary: unreadableLogSummary(message)
      });
    }
  }
  return entries;
}

async function getCurrentUserId(ctx: ConnectionContext): Promise<string | undefined> {
  const username = escapeSoqlLiteral(ctx.username);
  const result = await standardQuery<{ Id?: string }>(
    ctx.connection,
    `SELECT Id FROM User WHERE Username = '${username}' LIMIT 1`
  );
  return asString(result.records?.[0]?.Id);
}

async function listApexLogIds(ctx: ConnectionContext, scope: 'mine' | 'all', limit?: number): Promise<string[]> {
  const clauses: string[] = [];
  if (scope === 'mine') {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return [];
    clauses.push(`LogUserId = '${escapeSoqlLiteral(userId)}'`);
  }
  const limitClause = limit ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : '';
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const result = await toolingQuery<{ Id?: string }>(
    ctx.connection,
    `SELECT Id FROM ApexLog${where} ORDER BY StartTime DESC, Id DESC${limitClause}`
  );
  return (result.records || []).map(record => record.Id).filter((id): id is string => isSalesforceId(id));
}

async function deleteApexLogIds(
  ctx: ConnectionContext,
  ids: string[],
  concurrency = 3
): Promise<{ deleted: number; failed: number; failedLogIds: string[] }> {
  let deleted = 0;
  let failed = 0;
  const failedLogIds: string[] = [];
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 200) {
    chunks.push(ids.slice(index, index + 200));
  }
  await runLimited(chunks, concurrency, async chunk => {
    try {
      const query = chunk.join(',');
      const result = await connectionRequest<unknown>(
        ctx.connection,
        'DELETE',
        `/services/data/v${apiVersion(ctx.connection)}/composite/sobjects?ids=${query}&allOrNone=false`
      );
      if (Array.isArray(result)) {
        for (const item of result as Array<{ id?: string; success?: boolean }>) {
          if (item.success) deleted += 1;
          else {
            failed += 1;
            if (item.id) failedLogIds.push(item.id);
          }
        }
      } else {
        deleted += chunk.length;
      }
    } catch {
      failed += chunk.length;
      failedLogIds.push(...chunk);
    }
  });
  return { deleted, failed, failedLogIds };
}

async function logsDeleteNative(params: LogsDeleteParams = {}): Promise<LogsDeleteResult> {
  const ctx = await getConnectionContext(params.targetOrg);
  const scope = params.scope === 'all' ? 'all' : 'mine';
  const ids =
    Array.isArray(params.ids)
      ? params.ids.filter(isSalesforceId)
      : await listApexLogIds(ctx, scope, params.limit);
  if (params.dryRun || !params.confirmed) {
    return {
      status: 'success',
      targetOrg: ctx.username,
      scope,
      dryRun: true,
      listed: ids.length,
      total: ids.length,
      deleted: 0,
      failed: 0,
      cancelled: 0,
      logIds: ids
    };
  }
  const summary = await deleteApexLogIds(ctx, ids);
  return {
    status: summary.failed > 0 ? 'partial' : 'success',
    targetOrg: ctx.username,
    scope,
    dryRun: false,
    listed: ids.length,
    total: ids.length,
    deleted: summary.deleted,
    failed: summary.failed,
    cancelled: 0,
    failedLogIds: summary.failedLogIds
  };
}

function mapDebugLevel(record: JsonObject): RuntimeDebugLevelRecord {
  return {
    id: asString(record.Id),
    developerName: asString(record.DeveloperName) || '',
    masterLabel: asString(record.MasterLabel) || '',
    language: asString(record.Language) || '',
    workflow: asString(record.Workflow) || '',
    validation: asString(record.Validation) || '',
    callout: asString(record.Callout) || '',
    apexCode: asString(record.ApexCode) || '',
    apexProfiling: asString(record.ApexProfiling) || '',
    visualforce: asString(record.Visualforce) || '',
    system: asString(record.System) || '',
    database: asString(record.Database) || '',
    wave: asString(record.Wave) || '',
    nba: asString(record.Nba) || '',
    dataAccess: asString(record.DataAccess) || ''
  };
}

function debugLevelPayload(input: Partial<RuntimeDebugLevelRecord>): JsonObject {
  return {
    DeveloperName: asString(input.developerName) || '',
    MasterLabel: asString(input.masterLabel) || asString(input.developerName) || '',
    Language: asString(input.language) || 'None',
    Workflow: asString(input.workflow) || 'INFO',
    Validation: asString(input.validation) || 'INFO',
    Callout: asString(input.callout) || 'INFO',
    ApexCode: asString(input.apexCode) || 'DEBUG',
    ApexProfiling: asString(input.apexProfiling) || 'INFO',
    Visualforce: asString(input.visualforce) || 'INFO',
    System: asString(input.system) || 'DEBUG',
    Database: asString(input.database) || 'INFO',
    Wave: asString(input.wave) || 'INFO',
    Nba: asString(input.nba) || 'INFO',
    DataAccess: asString(input.dataAccess) || 'INFO'
  };
}

async function debugLevelsListNative(params: DebugLevelListParams = {}): Promise<RuntimeDebugLevelRecord[]> {
  const ctx = await getConnectionContext(params.targetOrg);
  const result = await toolingQuery<JsonObject>(
    ctx.connection,
    `SELECT ${DEBUG_LEVEL_FIELDS} FROM DebugLevel ORDER BY DeveloperName`
  );
  return (result.records || []).map(mapDebugLevel);
}

async function debugLevelGetNative(params: DebugLevelGetParams = {}): Promise<RuntimeDebugLevelRecord | undefined> {
  const ctx = await getConnectionContext(params.targetOrg);
  let where = '';
  if (params.id) where = `Id = '${escapeSoqlLiteral(params.id)}'`;
  else if (params.developerName) where = `DeveloperName = '${escapeSoqlLiteral(params.developerName)}'`;
  else throw new Error('debugLevels/get requires id or developerName.');
  const result = await toolingQuery<JsonObject>(
    ctx.connection,
    `SELECT ${DEBUG_LEVEL_FIELDS} FROM DebugLevel WHERE ${where} LIMIT 1`
  );
  return result.records?.[0] ? mapDebugLevel(result.records[0]) : undefined;
}

async function debugLevelCreateNative(params: DebugLevelWriteParams): Promise<DebugLevelWriteResult> {
  const ctx = await getConnectionContext(params.targetOrg);
  const record = params.record;
  if (params.dryRun || !params.confirmed) return { status: 'success', dryRun: true, record };
  const result = await connectionRequest<{ id?: string }>(
    ctx.connection,
    'POST',
    `/services/data/v${apiVersion(ctx.connection)}/tooling/sobjects/DebugLevel`,
    debugLevelPayload(record)
  );
  return {
    status: 'success',
    id: asString(result.id),
    dryRun: false,
    record: { ...record, id: asString(result.id) ?? record.id }
  };
}

async function debugLevelUpdateNative(params: DebugLevelWriteParams): Promise<DebugLevelWriteResult> {
  const ctx = await getConnectionContext(params.targetOrg);
  const record = params.record;
  const id =
    params.id ||
    record.id ||
    (await debugLevelGetNative({ targetOrg: params.targetOrg, developerName: record.developerName }))?.id;
  if (!id) throw new Error('Debug level was not found.');
  if (params.dryRun || !params.confirmed) return { status: 'success', id, dryRun: true, record: { ...record, id } };
  await connectionRequest(
    ctx.connection,
    'PATCH',
    `/services/data/v${apiVersion(ctx.connection)}/tooling/sobjects/DebugLevel/${id}`,
    debugLevelPayload(record)
  );
  return { status: 'success', id, dryRun: false, record: { ...record, id } };
}

async function debugLevelDeleteNative(params: DebugLevelDeleteParams): Promise<DebugLevelWriteResult> {
  const ctx = await getConnectionContext(params.targetOrg);
  if (params.dryRun || !params.confirmed) return { status: 'success', id: params.id, dryRun: true };
  await connectionRequest(
    ctx.connection,
    'DELETE',
    `/services/data/v${apiVersion(ctx.connection)}/tooling/sobjects/DebugLevel/${params.id}`
  );
  return { status: 'success', id: params.id, dryRun: false };
}

async function usersSearchNative(params: UserSearchParams = {}): Promise<UserSearchResult> {
  const ctx = await getConnectionContext(params.targetOrg);
  const limit = clampInt(params.limit, 50, 1, 200);
  const query = asString(params.query);
  const clauses = ['IsActive = true'];
  if (query) {
    const escaped = escapeSoqlLikeLiteral(query);
    clauses.push(`(Name LIKE '%${escaped}%' OR Username LIKE '%${escaped}%')`);
  }
  const result = await standardQuery<JsonObject>(
    ctx.connection,
    `SELECT Id, Name, Username, IsActive FROM User WHERE ${clauses.join(' AND ')} ORDER BY Name NULLS LAST LIMIT ${limit}`
  );
  const users: UserRecord[] = (result.records || [])
    .filter(record => isSalesforceId(record.Id))
    .map(record => ({
      id: record.Id as string,
      name: asString(record.Name) || asString(record.Username) || (record.Id as string),
      username: asString(record.Username) || '',
      active: Boolean(record.IsActive)
    }));
  return { users };
}

function targetLabel(target: TraceFlagTarget): string {
  if (target.type === 'automatedProcess') return 'Automated Process';
  if (target.type === 'platformIntegration') return 'Platform Integration';
  return 'User';
}

async function resolveTraceTargets(ctx: ConnectionContext, target: TraceFlagTarget): Promise<string[]> {
  if (target.type === 'user') return isSalesforceId(target.userId) ? [target.userId] : [];
  const userType = target.type === 'automatedProcess' ? AUTOMATED_PROCESS_USER_TYPE : PLATFORM_INTEGRATION_USER_TYPE;
  const result = await standardQuery<{ Id?: string }>(
    ctx.connection,
    `SELECT Id FROM User WHERE UserType = '${escapeSoqlLiteral(userType)}' AND IsActive = true ORDER BY Id LIMIT 200`
  );
  return (result.records || []).map(record => record.Id).filter((id): id is string => isSalesforceId(id));
}

function sfDateTime(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.` +
    `${pad(date.getUTCMilliseconds(), 3)}+0000`
  );
}

function isTraceActive(record: JsonObject): boolean {
  const start = Date.parse(asString(record.StartDate) || '');
  const expiration = Date.parse(asString(record.ExpirationDate) || '');
  const now = Date.now();
  return (!Number.isFinite(start) || start <= now) && Number.isFinite(expiration) && now <= expiration;
}

export function summarizeTraceFlagRecords(params: {
  target: TraceFlagTarget;
  targetLabel: string;
  resolvedIds: string[];
  records: JsonObject[];
}): TraceFlagTargetStatus {
  const activeByTarget = new Map<string, JsonObject>();
  for (const record of params.records) {
    if (!isTraceActive(record)) continue;
    const tracedEntityId = asString(record.TracedEntityId);
    if (!tracedEntityId || activeByTarget.has(tracedEntityId)) continue;
    activeByTarget.set(tracedEntityId, record);
  }

  const activeRecords = params.resolvedIds
    .map(id => activeByTarget.get(id))
    .filter((record): record is JsonObject => Boolean(record));
  const debugLevels = new Set(
    activeRecords.map(record => asString((record.DebugLevel as JsonObject | undefined)?.DeveloperName)).filter(Boolean)
  );
  const hasFullCoverage = activeRecords.length === params.resolvedIds.length;
  const singleActiveRecord =
    activeRecords.length === 1 && params.resolvedIds.length === 1 ? activeRecords[0] : undefined;

  return {
    target: params.target,
    targetLabel: params.targetLabel,
    targetAvailable: true,
    isActive: activeRecords.length > 0,
    traceFlagId: singleActiveRecord ? asString(singleActiveRecord.Id) : undefined,
    traceFlagIds: activeRecords.map(record => asString(record.Id)).filter((id): id is string => Boolean(id)),
    debugLevelName: hasFullCoverage && debugLevels.size === 1 ? Array.from(debugLevels)[0] : undefined,
    debugLevelMixed:
      activeRecords.length > 0 && params.resolvedIds.length > 1 && (!hasFullCoverage || debugLevels.size > 1),
    resolvedTargetCount: params.resolvedIds.length,
    activeTargetCount: activeRecords.length,
    startDate: singleActiveRecord ? asString(singleActiveRecord.StartDate) : undefined,
    expirationDate: singleActiveRecord ? asString(singleActiveRecord.ExpirationDate) : undefined
  };
}

async function traceFlagStatusNative(params: {
  targetOrg?: string;
  target: TraceFlagTarget;
}): Promise<TraceFlagTargetStatus> {
  const ctx = await getConnectionContext(params.targetOrg);
  const ids = await resolveTraceTargets(ctx, params.target);
  const label = targetLabel(params.target);
  if (ids.length === 0) {
    return { target: params.target, targetLabel: label, targetAvailable: false, isActive: false };
  }
  const idList = ids.map(id => `'${escapeSoqlLiteral(id)}'`).join(',');
  const result = await toolingQuery<JsonObject>(
    ctx.connection,
    `SELECT Id, TracedEntityId, StartDate, ExpirationDate, DebugLevel.DeveloperName FROM TraceFlag WHERE TracedEntityId IN (${idList}) AND LogType = 'USER_DEBUG' ORDER BY CreatedDate DESC`
  );
  return summarizeTraceFlagRecords({
    target: params.target,
    targetLabel: label,
    resolvedIds: ids,
    records: result.records || []
  });
}

async function getDebugLevelIdByName(ctx: ConnectionContext, debugLevelName: string): Promise<string> {
  const result = await toolingQuery<{ Id?: string }>(
    ctx.connection,
    `SELECT Id FROM DebugLevel WHERE DeveloperName = '${escapeSoqlLiteral(debugLevelName)}' LIMIT 1`
  );
  const id = result.records?.[0]?.Id;
  if (!id) throw new Error(`Debug level '${debugLevelName}' was not found.`);
  return id;
}

async function latestTraceFlagId(ctx: ConnectionContext, tracedEntityId: string): Promise<string | undefined> {
  const result = await toolingQuery<{ Id?: string }>(
    ctx.connection,
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${escapeSoqlLiteral(tracedEntityId)}' AND LogType = 'USER_DEBUG' ORDER BY CreatedDate DESC LIMIT 1`
  );
  return asString(result.records?.[0]?.Id);
}

async function traceFlagIdsForTarget(ctx: ConnectionContext, tracedEntityId: string): Promise<string[]> {
  const result = await toolingQuery<{ Id?: string }>(
    ctx.connection,
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${escapeSoqlLiteral(tracedEntityId)}' AND LogType = 'USER_DEBUG' ORDER BY CreatedDate DESC LIMIT 200`
  );
  return (result.records || []).map(record => asString(record.Id)).filter((id): id is string => Boolean(id));
}

async function traceFlagApplyNative(params: TraceFlagApplyParams): Promise<TraceFlagApplyResult> {
  const ctx = await getConnectionContext(params.targetOrg);
  const ids = await resolveTraceTargets(ctx, params.target);
  if (ids.length === 0) {
    throw new Error(`trace flag target '${targetLabel(params.target)}' was not found`);
  }
  const debugLevelId = await getDebugLevelIdByName(ctx, params.debugLevelName);
  const startDate = sfDateTime(new Date(Date.now() - 60_000));
  const expirationDate = sfDateTime(new Date(Date.now() + clampInt(params.ttlMinutes, 30, 1, 1440) * 60_000));
  if (params.dryRun || !params.confirmed) {
    return {
      status: 'dry-run',
      dryRun: true,
      created: false,
      createdCount: 0,
      updatedCount: 0,
      resolvedTargetCount: ids.length,
      traceFlagIds: []
    };
  }
  const traceFlagIds: string[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  for (const tracedEntityId of ids) {
    const existingId = await latestTraceFlagId(ctx, tracedEntityId);
    if (existingId) {
      await connectionRequest(
        ctx.connection,
        'PATCH',
        `/services/data/v${apiVersion(ctx.connection)}/tooling/sobjects/TraceFlag/${existingId}`,
        {
          DebugLevelId: debugLevelId,
          StartDate: startDate,
          ExpirationDate: expirationDate
        }
      );
      updatedCount += 1;
      traceFlagIds.push(existingId);
      continue;
    }
    const payload = {
      TracedEntityId: tracedEntityId,
      LogType: 'USER_DEBUG',
      DebugLevelId: debugLevelId,
      StartDate: startDate,
      ExpirationDate: expirationDate
    };
    const result = await connectionRequest<{ id?: string }>(
      ctx.connection,
      'POST',
      `/services/data/v${apiVersion(ctx.connection)}/tooling/sobjects/TraceFlag`,
      payload
    );
    const id = asString(result.id);
    if (id) traceFlagIds.push(id);
    createdCount += 1;
  }
  return {
    status: 'success',
    dryRun: false,
    created: createdCount > 0 && updatedCount === 0,
    createdCount,
    updatedCount,
    resolvedTargetCount: ids.length,
    traceFlagIds
  };
}

async function traceFlagRemoveNative(params: TraceFlagRemoveParams): Promise<TraceFlagRemoveResult> {
  const ctx = await getConnectionContext(params.targetOrg);
  const targetIds = await resolveTraceTargets(ctx, params.target);
  if (targetIds.length === 0) {
    throw new Error(`trace flag target '${targetLabel(params.target)}' was not found`);
  }
  const ids = (await Promise.all(targetIds.map(tracedEntityId => traceFlagIdsForTarget(ctx, tracedEntityId)))).flat();
  if (params.dryRun || !params.confirmed) {
    return {
      status: 'dry-run',
      removedCount: 0,
      resolvedTargetCount: targetIds.length,
      traceFlagIds: ids,
      dryRun: true
    };
  }
  let removed = 0;
  for (const id of ids) {
    await connectionRequest(
      ctx.connection,
      'DELETE',
      `/services/data/v${apiVersion(ctx.connection)}/tooling/sobjects/TraceFlag/${id}`
    );
    removed += 1;
  }
  return {
    status: 'success',
    removedCount: removed,
    resolvedTargetCount: targetIds.length,
    traceFlagIds: ids,
    dryRun: false
  };
}

async function toolingQueryNative(params: ToolingQueryParams): Promise<ToolingQueryResult> {
  const ctx = await getConnectionContext(params.targetOrg);
  return toolingQuery(ctx.connection, params.soql);
}

async function toolingRequestGetNative(params: ToolingRequestGetParams): Promise<unknown> {
  const ctx = await getConnectionContext(params.targetOrg);
  return connectionRequest(ctx.connection, 'GET', resolveOrgRequestPath(ctx, params.path));
}

async function doctorNative(params: DoctorParams = {}): Promise<DoctorResult> {
  const workspaceRoot = process.cwd();
  const apexlogsRoot = resolveApexlogsRoot(workspaceRoot);
  const result: DoctorResult = {
    status: 'ok',
    runtimeVersion: packageVersion(),
    platform: process.platform,
    arch: process.arch,
    workspaceRoot,
    apexlogsRoot,
    sf: { ok: true, message: '@salesforce/core is available' },
    cacheLayout: { ok: true, message: 'org-first apexlogs layout is enabled' },
    writableApexlogs: { ok: true, message: 'apexlogs is writable' }
  };
  try {
    await fs.mkdir(apexlogsRoot, { recursive: true });
    await fs.access(apexlogsRoot);
  } catch (error) {
    result.status = 'error';
    result.writableApexlogs = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const auth = await getOrgAuthFromCore({ username: params.targetOrg });
    result.orgAuth = { ok: true, message: `authenticated as ${auth.username || '(unknown)'}` };
  } catch (error) {
    result.status = result.status === 'error' ? 'error' : 'warning';
    result.orgAuth = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return result;
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index] || '');
    if (!raw) continue;
    if (raw === '--json') {
      json = true;
      continue;
    }
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq > 0) {
        flags.set(raw.slice(2, eq), raw.slice(eq + 1));
        continue;
      }
      const name = raw.slice(2);
      const next = argv[index + 1];
      if (next && !String(next).startsWith('-')) {
        flags.set(name, String(next));
        index += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    positionals.push(raw);
  }
  if (positionals[0] === 'electivus') {
    positionals.shift();
  }
  return { positionals, flags, json };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function jsonStringRecordFlag(args: ParsedArgs, name: string): Record<string, string> | undefined {
  const value = flag(args, name);
  if (!value) return undefined;
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

function targetOrg(args: ParsedArgs): string | undefined {
  return flag(args, 'target-org');
}

function logDeleteScope(args: ParsedArgs): 'mine' | 'all' {
  if (!args.flags.has('scope')) return 'mine';
  const value = flag(args, 'scope');
  if (value === 'mine' || value === 'all') return value;
  throw new Error('Invalid --scope value. Expected one of: mine, all.');
}

function traceTarget(args: ParsedArgs): TraceFlagTarget {
  const selectedTargets: string[] = [];
  const userId = flag(args, 'user-id');
  if (args.flags.has('user-id')) {
    if (!userId) {
      throw new Error('The --user-id flag requires a Salesforce User id.');
    }
    selectedTargets.push('--user-id');
  }
  if (boolFlag(args, 'current-user')) selectedTargets.push('--current-user');
  if (boolFlag(args, 'automated-process')) selectedTargets.push('--automated-process');
  if (boolFlag(args, 'platform-integration')) selectedTargets.push('--platform-integration');
  if (selectedTargets.length > 1) {
    throw new Error(`Trace flag target flags are mutually exclusive: ${selectedTargets.join(', ')}.`);
  }
  if (userId) return { type: 'user', userId };
  if (boolFlag(args, 'automated-process')) return { type: 'automatedProcess' };
  if (boolFlag(args, 'platform-integration')) return { type: 'platformIntegration' };
  return { type: 'user', userId: 'current' };
}

async function normalizeCurrentUserTarget(target: TraceFlagTarget, targetOrgValue?: string): Promise<TraceFlagTarget> {
  if (target.type !== 'user' || target.userId !== 'current') return target;
  const ctx = await getConnectionContext(targetOrgValue);
  const userId = await getCurrentUserId(ctx);
  if (!userId) throw new Error('Unable to determine current user id.');
  return { type: 'user', userId };
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function countFiles(dirPath: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(childPath);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

function currentModuleDir(): string {
  if (typeof __dirname === 'string') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

async function resolveBundledSkillDir(): Promise<string> {
  const moduleDir = currentModuleDir();
  const candidates = [
    path.resolve(moduleDir, '..', '..', '..', '.codex', 'skills', 'apex-log-viewer-cli'),
    path.resolve(moduleDir, 'skills', 'apex-log-viewer-cli'),
    path.resolve(moduleDir, '..', 'skills', 'apex-log-viewer-cli'),
    path.resolve(process.cwd(), '.codex', 'skills', 'apex-log-viewer-cli')
  ];
  for (const candidate of candidates) {
    if (await directoryExists(candidate)) return candidate;
  }
  throw new Error('Bundled apex-log-viewer-cli Codex skill was not found.');
}

async function skillsInstallNative(): Promise<SkillsInstallResult> {
  const source = await resolveBundledSkillDir();
  const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  const destination = path.join(codexHome, 'skills', 'apex-log-viewer-cli');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
  return {
    status: 'installed',
    skillName: 'apex-log-viewer-cli',
    source,
    destination,
    files: await countFiles(destination)
  };
}

export async function executeElectivus(argv: readonly string[]): Promise<unknown> {
  const args = parseArgv(argv);
  const [topic, command, subcommand] = args.positionals;
  if (!topic || topic === 'doctor') return doctorNative({ targetOrg: targetOrg(args) });
  if (topic === 'skills' && command === 'install') return skillsInstallNative();
  if (topic === 'orgs' && command === 'list') return listOrgsNative({ forceRefresh: boolFlag(args, 'force-refresh') });
  if (topic === 'orgs' && command === 'auth')
    return getOrgAuthFromCore({ username: targetOrg(args) || flag(args, 'username') });
  if (topic === 'orgs' && command === 'resolve') return resolveOrgNative({ targetOrg: targetOrg(args) });
  if (topic === 'logs' && command === 'list') {
    const beforeStartTime = flag(args, 'before-start-time');
    const beforeId = flag(args, 'before-id');
    return listLogsNative({
      username: targetOrg(args),
      limit: asNumber(flag(args, 'limit')),
      offset: asNumber(flag(args, 'offset')),
      cursor: beforeStartTime && beforeId ? { beforeStartTime, beforeId } : undefined
    });
  }
  if (topic === 'logs' && command === 'sync')
    return logsSyncNative({
      targetOrg: targetOrg(args),
      workspaceRoot: flag(args, 'workspace-root') || process.cwd(),
      forceFull: boolFlag(args, 'force-full'),
      concurrency: asNumber(flag(args, 'concurrency'))
    });
  if (topic === 'logs' && command === 'status')
    return logsStatusNative({
      targetOrg: targetOrg(args),
      workspaceRoot: flag(args, 'workspace-root') || process.cwd()
    });
  if (topic === 'logs' && command === 'read')
    return logsReadNative({
      logId: args.positionals[2] || '',
      targetOrg: targetOrg(args),
      workspaceRoot: flag(args, 'workspace-root') || process.cwd(),
      maxBytes: asNumber(flag(args, 'max-bytes'))
    });
  if (topic === 'logs' && command === 'resolve')
    return logsResolveNative({
      logId: args.positionals[2] || '',
      targetOrg: targetOrg(args),
      workspaceRoot: flag(args, 'workspace-root') || process.cwd()
    });
  if (topic === 'logs' && command === 'resolve-cached-path')
    return resolveCachedLogPathNative({
      logId: args.positionals[2] || '',
      username: flag(args, 'username'),
      workspaceRoot: flag(args, 'workspace-root') || process.cwd()
    });
  if (topic === 'logs' && command === 'triage')
    return logsTriageNative({
      username: targetOrg(args),
      logIds: args.positionals.slice(2),
      logStartTimes: jsonStringRecordFlag(args, 'log-start-times'),
      workspaceRoot: flag(args, 'workspace-root') || process.cwd()
    });
  if (topic === 'logs' && command === 'delete')
    return logsDeleteNative({
      targetOrg: targetOrg(args),
      workspaceRoot: flag(args, 'workspace-root') || process.cwd(),
      scope: logDeleteScope(args),
      ids: await resolveLogDeleteIds({
        ids: flag(args, 'ids'),
        idsProvided: args.flags.has('ids'),
        idsFile: flag(args, 'ids-file'),
        idsFileProvided: args.flags.has('ids-file'),
        cwd: process.cwd()
      }),
      limit: asNumber(flag(args, 'limit')),
      dryRun: boolFlag(args, 'dry-run'),
      confirmed: boolFlag(args, 'yes')
    });
  if (topic === 'users' && command === 'search')
    return usersSearchNative({
      targetOrg: targetOrg(args),
      query: args.positionals[2],
      limit: asNumber(flag(args, 'limit'))
    });
  if (topic === 'trace-flags' && command === 'status')
    return traceFlagStatusNative({
      targetOrg: targetOrg(args),
      target: await normalizeCurrentUserTarget(traceTarget(args), targetOrg(args))
    });
  if (topic === 'trace-flags' && command === 'apply')
    return traceFlagApplyNative({
      targetOrg: targetOrg(args),
      target: await normalizeCurrentUserTarget(traceTarget(args), targetOrg(args)),
      debugLevelName: flag(args, 'debug-level') || '',
      ttlMinutes: asNumber(flag(args, 'ttl-minutes')),
      dryRun: boolFlag(args, 'dry-run'),
      confirmed: boolFlag(args, 'yes')
    });
  if (topic === 'trace-flags' && command === 'remove')
    return traceFlagRemoveNative({
      targetOrg: targetOrg(args),
      target: await normalizeCurrentUserTarget(traceTarget(args), targetOrg(args)),
      dryRun: boolFlag(args, 'dry-run'),
      confirmed: boolFlag(args, 'yes')
    });
  if (topic === 'debug-levels' && command === 'list') return debugLevelsListNative({ targetOrg: targetOrg(args) });
  if (topic === 'debug-levels' && command === 'get')
    return debugLevelGetNative({
      targetOrg: targetOrg(args),
      id: flag(args, 'id'),
      developerName: flag(args, 'developer-name')
    });
  if (topic === 'debug-levels' && command === 'create') return debugLevelCreateNative(debugLevelParams(args));
  if (topic === 'debug-levels' && command === 'update') return debugLevelUpdateNative(debugLevelParams(args));
  if (topic === 'debug-levels' && command === 'delete')
    return debugLevelDeleteNative({
      targetOrg: targetOrg(args),
      id: flag(args, 'id') || '',
      dryRun: boolFlag(args, 'dry-run'),
      confirmed: boolFlag(args, 'yes')
    });
  if (topic === 'tooling' && command === 'query')
    return toolingQueryNative({ targetOrg: targetOrg(args), soql: args.positionals.slice(2).join(' ') });
  if (topic === 'tooling' && command === 'request' && subcommand === 'get')
    return toolingRequestGetNative({ targetOrg: targetOrg(args), path: args.positionals[3] || '' });
  throw new Error(`Unknown sf electivus command: ${args.positionals.join(' ')}`);
}

function debugLevelParams(args: ParsedArgs): DebugLevelWriteParams {
  const record: RuntimeDebugLevelRecord = {
    id: flag(args, 'id'),
    developerName: flag(args, 'developer-name') || '',
    masterLabel: flag(args, 'master-label') || flag(args, 'developer-name') || '',
    language: flag(args, 'language') || 'None',
    workflow: flag(args, 'workflow') || 'INFO',
    validation: flag(args, 'validation') || 'INFO',
    callout: flag(args, 'callout') || 'INFO',
    apexCode: flag(args, 'apex-code') || 'DEBUG',
    apexProfiling: flag(args, 'apex-profiling') || 'INFO',
    visualforce: flag(args, 'visualforce') || 'INFO',
    system: flag(args, 'system') || 'DEBUG',
    database: flag(args, 'database') || 'INFO',
    wave: flag(args, 'wave') || 'INFO',
    nba: flag(args, 'nba') || 'INFO',
    dataAccess: flag(args, 'data-access') || 'INFO'
  };
  return {
    targetOrg: targetOrg(args),
    id: record.id,
    record,
    dryRun: boolFlag(args, 'dry-run'),
    confirmed: boolFlag(args, 'yes')
  };
}

function isLogsReadResult(value: unknown): value is LogsReadResult {
  const result = value as LogsReadResult | undefined;
  return (
    Boolean(result) &&
    typeof result === 'object' &&
    typeof result.logId === 'string' &&
    typeof result.path === 'string' &&
    typeof result.body === 'string' &&
    typeof result.sizeBytes === 'number' &&
    typeof result.truncated === 'boolean'
  );
}

export function formatTextResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isLogsReadResult(value)) return value.body;
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatJsonResult(value: unknown): string {
  return `${JSON.stringify(value === undefined ? null : value)}\n`;
}
