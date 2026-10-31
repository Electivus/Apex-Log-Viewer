import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuthInfo, ConfigAggregator, Connection, OrgConfigProperties, StateAggregator } from '@salesforce/core';

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
  LogsResolveParams,
  LogsSyncParams,
  LogsStatusParams,
  LogsTriageParams,
  OrgAuth,
  OrgAuthParams,
  OrgListItem,
  OrgListParams,
  OrgResolveParams,
  OrgResolveResult,
  RuntimeDebugLevelRecord,
  RuntimeLogRow,
  RuntimeLogTriageSummary,
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
import { createCustomLogApi, type CaptureRunEvent, type CustomLogEnv } from './customLogs/api.js';
import type {
  CustomLogCaptureParams,
  CustomLogCaptureResult,
  CustomLogCaptureUpdate,
  CustomLogEntryParams,
  CustomLogGetParams,
  CustomLogListParams,
  CustomLogSourcesParams
} from './customLogs/contracts.js';
import { queryData, toolingQuery } from './dataQuery.js';
import { AlvError, abortError, awaitWithAbort, throwIfAborted } from './errors.js';
import {
  ApexLogLifecycleError,
  createApexLogLifecycle,
  type ApexLogCallOptions,
  type ApexLogLifecycle,
  type ApexLogRemote,
  type ReadApexLogRequest,
  type ReadApexLogResult,
  type StoredApexLogBody
} from './logLifecycle.js';
import { escapeSoqlLikeLiteral, escapeSoqlLiteral, isSalesforceId, normalizeSoqlDateTimeLiteral } from './soql.js';

export { AlvError, awaitWithAbort };

export type CoreCallOptions = {
  signal?: AbortSignal;
};

export type CaptureCallOptions = CoreCallOptions & {
  /** Every state change and every durable batch of the capture. */
  onUpdate?: (update: CustomLogCaptureUpdate) => void;
};

export type CoreInstrumentation = {
  onCall?: (event: {
    method: string;
    outcome: 'ok' | 'error' | 'cancelled';
    durationMs: number;
    error?: unknown;
  }) => void;
  /**
   * One `start` and one `end` per capture run, not per caller. `customLog.capture` lasts as long as
   * the stream does, so it is not timed as one `onCall`.
   */
  onCapture?: (event: CaptureRunEvent) => void;
};

const DEFAULT_API_VERSION = '63.0';
const APEX_LOG_ID_REGEX = /^07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;
const DEBUG_LEVEL_FIELDS =
  'Id, DeveloperName, Language, MasterLabel, Workflow, Validation, Callout, ApexCode, ApexProfiling, ' +
  'Visualforce, System, Database, Wave, Nba, DataAccess';
const AUTOMATED_PROCESS_USER_TYPE = 'AutomatedProcess';
const PLATFORM_INTEGRATION_USER_TYPE = 'CloudIntegrationUser';

type JsonObject = Record<string, unknown>;

type SalesforceLogRecord = {
  Id?: string;
  StartTime?: string;
  Operation?: string;
  Application?: string;
  DurationMilliseconds?: number;
  Status?: string;
  Request?: string;
  LogLength?: number;
  LogUser?: { Name?: string };
};

type OrgConnection = {
  connection: Connection;
  username: string;
  instanceUrl?: string;
};

type ConnectionContext = OrgConnection & {
  alias?: string;
};

function packageVersion(): string {
  return process.env.ALVE_PLUGIN_VERSION || process.env.npm_package_version || '0.0.0';
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

function syncStatePath(workspaceRoot?: string): string {
  return path.join(resolveApexlogsRoot(workspaceRoot), '.alv', 'sync-state.json');
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

export function parseApexLogIds(value: string | null | undefined): string[] {
  const ids = new Set<string>();
  for (const token of (value ?? '').split(/[\s,]+/)) {
    const id = token.trim();
    if (APEX_LOG_ID_REGEX.test(id)) {
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

async function connectOrg(username: string): Promise<OrgConnection> {
  const authInfo = await AuthInfo.create({ username });
  const connection = await Connection.create({ authInfo });
  await alignConnectionApiVersion(connection);
  const fields = authInfo.getFields(true);
  return {
    connection,
    username: asString(connection.getUsername()) ?? asString(fields.username) ?? username,
    instanceUrl:
      asString(fields.instanceUrl) ?? asString((connection as unknown as { instanceUrl?: string }).instanceUrl)
  };
}

function isSessionRejected(error: unknown): boolean {
  return (
    (error as { errorCode?: unknown } | undefined)?.errorCode === 'INVALID_SESSION_ID' ||
    (error instanceof Error &&
      (error.message.startsWith('Unable to refresh session due to:') ||
        // jsforce wraps a failed refresh only for the request that started it; requests awaiting it get the SDK error.
        error.name === 'RefreshTokenAuthError' ||
        error.name === 'JwtAuthError'))
  );
}

type OrgConnections = {
  use<T>(
    targetOrg: string | undefined,
    signal: AbortSignal | undefined,
    run: (ctx: ConnectionContext) => Promise<T>
  ): Promise<T>;
  /** The cached connection of a resolved username. `fresh` drops the cached one first, so the next one re-authenticates. */
  connect(username: string, options: { fresh?: boolean; signal?: AbortSignal }): Promise<ConnectionContext>;
  clear(): void;
};

function createOrgConnections(): OrgConnections {
  const byUsername = new Map<string, Promise<OrgConnection>>();
  const evict = (username: string, pending: Promise<OrgConnection>): void => {
    if (byUsername.get(username) === pending) byUsername.delete(username);
  };
  const cachedConnection = (username: string): Promise<OrgConnection> => {
    const existing = byUsername.get(username);
    if (existing) return existing;
    const pending = connectOrg(username);
    byUsername.set(username, pending);
    pending.catch(() => evict(username, pending));
    return pending;
  };
  return {
    async use(targetOrg, signal, run) {
      throwIfAborted(signal);
      const resolved = await awaitWithAbort(resolveUsername(targetOrg), signal);
      const cached = cachedConnection(resolved.username);
      const ctx = { ...(await awaitWithAbort(cached, signal)), alias: resolved.alias };
      try {
        return await run(ctx);
      } catch (error) {
        if (!isSessionRejected(error)) throw error;
        evict(resolved.username, cached);
        return run({ ...(await awaitWithAbort(cachedConnection(resolved.username), signal)), alias: resolved.alias });
      }
    },
    async connect(username, { fresh, signal }) {
      throwIfAborted(signal);
      if (fresh) byUsername.delete(username);
      const alias = await awaitWithAbort(findAliasForUsername(username), signal);
      return { ...(await awaitWithAbort(cachedConnection(username), signal)), alias };
    },
    clear: () => byUsername.clear()
  };
}

function toOrgAuth(token: unknown, url: unknown, username: string): OrgAuth {
  const accessToken = asString(token);
  const instanceUrl = asString(url);
  if (!accessToken || !instanceUrl) {
    throw new Error('Unable to retrieve Salesforce org authentication from @salesforce/core.');
  }
  return { accessToken, instanceUrl, username };
}

async function getOrgAuthFromCore(params: OrgAuthParams = {}): Promise<OrgAuth> {
  const resolved = await resolveUsername(params.username);
  const authInfo = await AuthInfo.create({ username: resolved.username });
  const fields = authInfo.getFields(true);
  return toOrgAuth(fields.accessToken, fields.instanceUrl, asString(authInfo.getUsername()) ?? resolved.username);
}

async function refreshOrgAuth(ctx: ConnectionContext): Promise<OrgAuth> {
  await ctx.connection.refreshAuth();
  return toOrgAuth(ctx.connection.accessToken, ctx.connection.instanceUrl, ctx.username);
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

async function resolveOrgNative(
  connections: OrgConnections,
  params: OrgResolveParams = {},
  signal?: AbortSignal
): Promise<OrgResolveResult> {
  const resolved = await resolveUsername(params.targetOrg);
  return connections.use(resolved.username, signal, async ctx => ({
    requested: resolved.requested,
    username: ctx.username,
    alias: resolved.alias,
    instanceUrl: ctx.instanceUrl,
    source: resolved.source
  }));
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
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  throwIfAborted(signal);
  const request: JsonObject = {
    method,
    url: pathOrUrl
  };
  if (body !== undefined) {
    request.body = typeof body === 'string' ? body : JSON.stringify(body);
    request.headers = { 'Content-Type': 'application/json' };
  }
  return (await awaitWithAbort(connection.request(request as never), signal)) as T;
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

async function listLogsNative(
  ctx: ConnectionContext,
  params: LogsListParams,
  signal?: AbortSignal
): Promise<RuntimeLogRow[]> {
  const limit = clampInt(params.limit, 50, 1, 200);
  const offset = clampInt(params.offset, 0, 0, 2000);
  const soql = buildApexLogListSoql({ limit, offset, cursor: params.cursor });
  const result = await toolingQuery<SalesforceLogRecord>(ctx.connection, soql, signal);
  return (result.records ?? []).flatMap(record =>
    record.Id
      ? [
          {
            id: record.Id,
            startTime: record.StartTime,
            operation: record.Operation,
            application: record.Application,
            durationMilliseconds: record.DurationMilliseconds,
            status: record.Status,
            request: record.Request,
            logLength: record.LogLength,
            logUser: record.LogUser ? { name: record.LogUser.Name } : undefined
          }
        ]
      : []
  );
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

async function fetchLogBody(ctx: ConnectionContext, logId: string, signal?: AbortSignal): Promise<string> {
  const value = await connectionRequest<unknown>(
    ctx.connection,
    'GET',
    `/services/data/v${apiVersion(ctx.connection)}/tooling/sobjects/ApexLog/${logId}/Body`,
    undefined,
    signal
  );
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
}

export async function runLimited<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (index < items.length) {
      throwIfAborted(signal);
      const item = items[index++]!;
      await worker(item);
      throwIfAborted(signal);
    }
  });
  await Promise.all(workers);
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

async function getCurrentUserId(ctx: ConnectionContext, signal?: AbortSignal): Promise<string | undefined> {
  throwIfAborted(signal);
  const username = escapeSoqlLiteral(ctx.username);
  const result = await queryData<{ Id?: string }>(
    ctx.connection,
    `SELECT Id FROM User WHERE Username = '${username}' LIMIT 1`,
    { maxRecords: 1, signal }
  );
  throwIfAborted(signal);
  return asString(result.records?.[0]?.Id);
}

async function listApexLogIds(
  ctx: ConnectionContext,
  scope: 'mine' | 'all',
  limit?: number,
  signal?: AbortSignal
): Promise<string[]> {
  throwIfAborted(signal);
  const clauses: string[] = [];
  if (scope === 'mine') {
    const userId = await getCurrentUserId(ctx, signal);
    if (!userId) return [];
    clauses.push(`LogUserId = '${escapeSoqlLiteral(userId)}'`);
  }
  const limitClause = limit ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : '';
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const result = await toolingQuery<{ Id?: string }>(
    ctx.connection,
    `SELECT Id FROM ApexLog${where} ORDER BY StartTime DESC, Id DESC${limitClause}`,
    signal
  );
  throwIfAborted(signal);
  return (result.records || []).map(record => record.Id).filter((id): id is string => isSalesforceId(id));
}

export async function deleteApexLogIds(
  ctx: ConnectionContext,
  ids: string[],
  concurrency = 3,
  signal?: AbortSignal
): Promise<{ deleted: number; failed: number; failedLogIds: string[] }> {
  throwIfAborted(signal);
  let deleted = 0;
  let failed = 0;
  const failedLogIds: string[] = [];
  let rejectedSession: unknown;
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 200) {
    chunks.push(ids.slice(index, index + 200));
  }
  await runLimited(
    chunks,
    concurrency,
    async chunk => {
      try {
        const query = chunk.join(',');
        const result = await connectionRequest<unknown>(
          ctx.connection,
          'DELETE',
          `/services/data/v${apiVersion(ctx.connection)}/composite/sobjects?ids=${query}&allOrNone=false`,
          undefined,
          signal
        );
        throwIfAborted(signal);
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
      } catch (error) {
        if (signal?.aborted || (error instanceof AlvError && error.code === 'ABORTED')) throw abortError();
        if (isSessionRejected(error)) rejectedSession ??= error;
        failed += chunk.length;
        failedLogIds.push(...chunk);
      }
    },
    signal
  );
  throwIfAborted(signal);
  if (deleted === 0 && rejectedSession) throw rejectedSession;
  return { deleted, failed, failedLogIds };
}

async function logsDeleteNative(
  ctx: ConnectionContext,
  params: LogsDeleteParams,
  signal?: AbortSignal
): Promise<LogsDeleteResult> {
  const scope = params.scope === 'all' ? 'all' : 'mine';
  const ids = Array.isArray(params.ids)
    ? params.ids.filter(isSalesforceId)
    : await listApexLogIds(ctx, scope, params.limit, signal);
  throwIfAborted(signal);
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
  const summary = await deleteApexLogIds(ctx, ids, 3, signal);
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

async function debugLevelsListNative(ctx: ConnectionContext): Promise<RuntimeDebugLevelRecord[]> {
  const result = await toolingQuery<JsonObject>(
    ctx.connection,
    `SELECT ${DEBUG_LEVEL_FIELDS} FROM DebugLevel ORDER BY DeveloperName`
  );
  return (result.records || []).map(mapDebugLevel);
}

async function debugLevelGetNative(
  ctx: ConnectionContext,
  params: DebugLevelGetParams
): Promise<RuntimeDebugLevelRecord | undefined> {
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

async function debugLevelCreateNative(
  ctx: ConnectionContext,
  params: DebugLevelWriteParams
): Promise<DebugLevelWriteResult> {
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

async function debugLevelUpdateNative(
  ctx: ConnectionContext,
  params: DebugLevelWriteParams
): Promise<DebugLevelWriteResult> {
  const record = params.record;
  const id = params.id || record.id || (await debugLevelGetNative(ctx, { developerName: record.developerName }))?.id;
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

async function debugLevelDeleteNative(
  ctx: ConnectionContext,
  params: DebugLevelDeleteParams
): Promise<DebugLevelWriteResult> {
  if (params.dryRun || !params.confirmed) return { status: 'success', id: params.id, dryRun: true };
  await connectionRequest(
    ctx.connection,
    'DELETE',
    `/services/data/v${apiVersion(ctx.connection)}/tooling/sobjects/DebugLevel/${params.id}`
  );
  return { status: 'success', id: params.id, dryRun: false };
}

async function usersSearchNative(ctx: ConnectionContext, params: UserSearchParams): Promise<UserSearchResult> {
  const limit = clampInt(params.limit, 50, 1, 200);
  const query = asString(params.query);
  const clauses = ['IsActive = true'];
  if (query) {
    const escaped = escapeSoqlLikeLiteral(query);
    clauses.push(`(Name LIKE '%${escaped}%' OR Username LIKE '%${escaped}%')`);
  }
  const result = await queryData<JsonObject>(
    ctx.connection,
    `SELECT Id, Name, Username, IsActive FROM User WHERE ${clauses.join(' AND ')} ORDER BY Name NULLS LAST LIMIT ${limit}`,
    { maxRecords: limit }
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
  const result = await queryData<{ Id?: string }>(
    ctx.connection,
    `SELECT Id FROM User WHERE UserType = '${escapeSoqlLiteral(userType)}' AND IsActive = true ORDER BY Id LIMIT 200`,
    { maxRecords: 200 }
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

async function traceFlagStatusNative(
  ctx: ConnectionContext,
  params: { target: TraceFlagTarget }
): Promise<TraceFlagTargetStatus> {
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

async function traceFlagApplyNative(
  ctx: ConnectionContext,
  params: TraceFlagApplyParams
): Promise<TraceFlagApplyResult> {
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

async function traceFlagRemoveNative(
  ctx: ConnectionContext,
  params: TraceFlagRemoveParams
): Promise<TraceFlagRemoveResult> {
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

async function normalizeCurrentUserTarget(ctx: ConnectionContext, target: TraceFlagTarget): Promise<TraceFlagTarget> {
  if (target.type !== 'user' || target.userId !== 'current') return target;
  const userId = await getCurrentUserId(ctx);
  if (!userId) throw new Error('Unable to determine current user id.');
  return { type: 'user', userId };
}

async function instrumentedCall<T>(
  instrumentation: CoreInstrumentation | undefined,
  method: string,
  options: CoreCallOptions | undefined,
  run: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    throwIfAborted(options?.signal);
    const result = await run(options?.signal);
    throwIfAborted(options?.signal);
    instrumentation?.onCall?.({ method, outcome: 'ok', durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    const cancelled = options?.signal?.aborted || (error instanceof AlvError && error.code === 'ABORTED');
    instrumentation?.onCall?.({
      method,
      outcome: cancelled ? 'cancelled' : 'error',
      durationMs: Date.now() - startedAt,
      error
    });
    if (cancelled && !(error instanceof AlvError)) throw abortError();
    throw error;
  }
}

export type ApexLogViewerCore = ReturnType<typeof createApexLogViewerCore>;

function createRuntimeApexLogRemote(connections: OrgConnections): ApexLogRemote {
  return {
    resolveOrg(targetOrg, signal) {
      return connections.use(targetOrg, signal, async ctx => ({
        username: ctx.username,
        alias: ctx.alias,
        instanceUrl: ctx.instanceUrl
      }));
    },
    async listLogs(request, signal) {
      const rows = await connections.use(request.org.username, signal, ctx =>
        listLogsNative(ctx, { limit: request.limit, cursor: request.cursor, offset: 0 }, signal)
      );
      return rows.map(row => ({
        logId: row.id,
        startTime: row.startTime,
        operation: row.operation,
        application: row.application,
        status: row.status,
        logLength: row.logLength
      }));
    },
    readBody(request, signal) {
      return connections.use(request.org.username, signal, ctx => fetchLogBody(ctx, request.logId, signal));
    }
  };
}

export function createApexLogViewerCore(
  options: {
    instrumentation?: CoreInstrumentation;
    apexLogRemote?: ApexLogRemote;
    surface?: CustomLogEnv['surface'];
  } = {}
) {
  const call = <T>(
    method: string,
    callOptions: CoreCallOptions | undefined,
    run: (signal?: AbortSignal) => Promise<T>
  ) => instrumentedCall(options.instrumentation, method, callOptions, run);
  const connections = createOrgConnections();
  const orgCall = <T>(
    method: string,
    targetOrg: string | undefined,
    callOptions: CoreCallOptions | undefined,
    run: (ctx: ConnectionContext, signal?: AbortSignal) => Promise<T>
  ) => call(method, callOptions, signal => connections.use(targetOrg, signal, ctx => run(ctx, signal)));
  const customLogs = createCustomLogApi({
    hooks: {
      onCapture: event => options.instrumentation?.onCapture?.(event),
      onCallbackError: error =>
        options.instrumentation?.onCall?.({
          method: 'customLog.capture.callback',
          outcome: 'error',
          durationMs: 0,
          error
        })
    }
  });
  const customLogEnv = async (
    targetOrg: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<CustomLogEnv> => {
    const { username } = await awaitWithAbort(resolveUsername(targetOrg), signal);
    return {
      username,
      surface: options.surface ?? 'cli',
      use: (use, useSignal = signal) => connections.use(username, useSignal, use),
      connection: ({ fresh, signal: connectionSignal = signal } = {}) =>
        connections.connect(username, { fresh, signal: connectionSignal })
    };
  };
  const customLogCall = <T>(
    method: string,
    targetOrg: string | undefined,
    callOptions: CoreCallOptions | undefined,
    run: (env: CustomLogEnv, signal?: AbortSignal) => Promise<T>
  ) => call(method, callOptions, async signal => run(await customLogEnv(targetOrg, signal), signal));
  const apexLogRemote = options.apexLogRemote ?? createRuntimeApexLogRemote(connections);
  const rawLogLifecycle = createApexLogLifecycle({ remote: apexLogRemote });
  const lifecycleCall = <T>(
    method: string,
    callOptions: ApexLogCallOptions | undefined,
    run: (options: ApexLogCallOptions) => Promise<T>
  ): Promise<T> => {
    const startedAt = Date.now();
    return run(callOptions ?? {}).then(
      result => {
        options.instrumentation?.onCall?.({ method, outcome: 'ok', durationMs: Date.now() - startedAt });
        return result;
      },
      error => {
        const cancelled =
          callOptions?.signal?.aborted || (error instanceof ApexLogLifecycleError && error.code === 'cancelled');
        options.instrumentation?.onCall?.({
          method,
          outcome: cancelled ? 'cancelled' : 'error',
          durationMs: Date.now() - startedAt,
          error
        });
        throw error;
      }
    );
  };
  function readLifecycle(
    request: ReadApexLogRequest & { persistence?: 'required' },
    callOptions?: ApexLogCallOptions
  ): Promise<StoredApexLogBody>;
  function readLifecycle(
    request: ReadApexLogRequest & { persistence: 'best-effort' },
    callOptions?: ApexLogCallOptions
  ): Promise<ReadApexLogResult>;
  function readLifecycle(request: ReadApexLogRequest, callOptions?: ApexLogCallOptions): Promise<ReadApexLogResult> {
    if (request.persistence === 'best-effort') {
      return lifecycleCall('log.lifecycle.read', callOptions, lifecycleOptions =>
        rawLogLifecycle.read(request as ReadApexLogRequest & { persistence: 'best-effort' }, lifecycleOptions)
      );
    }
    return lifecycleCall('log.lifecycle.read', callOptions, lifecycleOptions =>
      rawLogLifecycle.read(request as ReadApexLogRequest & { persistence?: 'required' }, lifecycleOptions)
    );
  }
  const logLifecycle: ApexLogLifecycle = {
    requireLocalPath: (request, callOptions) =>
      lifecycleCall('log.lifecycle.requireLocalPath', callOptions, lifecycleOptions =>
        rawLogLifecycle.requireLocalPath(request, lifecycleOptions)
      ),
    availableLocalPaths: (request, callOptions) =>
      lifecycleCall('log.lifecycle.availableLocalPaths', callOptions, lifecycleOptions =>
        rawLogLifecycle.availableLocalPaths(request, lifecycleOptions)
      ),
    read: readLifecycle,
    sync: (request, callOptions) =>
      lifecycleCall('log.lifecycle.sync', callOptions, lifecycleOptions =>
        rawLogLifecycle.sync(request, lifecycleOptions)
      ),
    status: (request, callOptions) =>
      lifecycleCall('log.lifecycle.status', callOptions, lifecycleOptions =>
        rawLogLifecycle.status(request, lifecycleOptions)
      ),
    triage: (request, callOptions) =>
      lifecycleCall('log.lifecycle.triage', callOptions, lifecycleOptions =>
        rawLogLifecycle.triage(request, lifecycleOptions)
      ),
    purge: (request, callOptions) =>
      lifecycleCall('log.lifecycle.purge', callOptions, lifecycleOptions =>
        rawLogLifecycle.purge(request, lifecycleOptions)
      ),
    dispose: () => rawLogLifecycle.dispose()
  };

  return {
    logLifecycle,
    doctor: (params: DoctorParams = {}, callOptions?: CoreCallOptions) =>
      call('doctor', callOptions, () => doctorNative(params)),
    org: {
      list: (params: OrgListParams = {}, callOptions?: CoreCallOptions) =>
        call('org.list', callOptions, () => {
          if (params.forceRefresh) connections.clear();
          return listOrgsNative(params);
        }),
      resolve: (params: OrgResolveParams = {}, callOptions?: CoreCallOptions) =>
        call('org.resolve', callOptions, signal => resolveOrgNative(connections, params, signal)),
      getAuth: (params: OrgAuthParams = {}, callOptions?: CoreCallOptions) =>
        params.refresh
          ? orgCall('org.getAuth', params.username, callOptions, refreshOrgAuth)
          : call('org.getAuth', callOptions, () => getOrgAuthFromCore(params))
    },
    log: {
      list: (params: LogsListParams = {}, callOptions?: CoreCallOptions) =>
        call('log.list', callOptions, async signal => {
          if (!options.apexLogRemote) {
            return connections.use(params.username, signal, ctx => listLogsNative(ctx, params, signal));
          }
          const org = await apexLogRemote.resolveOrg(params.username, signal);
          const rows = await apexLogRemote.listLogs(
            {
              org,
              limit: clampInt(params.limit, 50, 1, 200),
              cursor: params.cursor
            },
            signal
          );
          return rows.map(row => ({
            id: row.logId,
            startTime: row.startTime,
            operation: row.operation,
            application: row.application,
            status: row.status,
            logLength: row.logLength,
            logUser: row.logUser
          }));
        }),
      sync: (params: LogsSyncParams = {}, callOptions?: CoreCallOptions) =>
        call('log.sync', callOptions, async signal => {
          const workspaceRoot = asString(params.workspaceRoot);
          if (!workspaceRoot) throw new AlvError('INVALID_ARGUMENT', 'workspaceRoot is required.');
          const result = await rawLogLifecycle.sync(
            {
              workspaceRoot,
              targetOrg: params.targetOrg,
              mode: params.forceFull ? 'full' : 'incremental',
              concurrency: params.concurrency
            },
            { signal }
          );
          return {
            status: result.status,
            targetOrg: result.resolvedUsername,
            safeTargetOrg: safeTargetOrg(result.resolvedUsername),
            apexlogsRoot: resolveApexlogsRoot(workspaceRoot),
            orgLogsRoot: path.join(
              resolveApexlogsRoot(workspaceRoot),
              'orgs',
              safeTargetOrg(result.resolvedUsername),
              'logs'
            ),
            downloaded: result.downloaded,
            cached: result.existing + result.materialized,
            failed: result.failures.length,
            failures: result.failures.map(failure => ({ logId: failure.logId, code: failure.error.code })),
            checkpointAdvanced: result.checkpoint.advanced,
            stateFile: syncStatePath(workspaceRoot),
            lastSyncedLogId: result.checkpoint.lastLogId
          };
        }),
      status: (params: LogsStatusParams = {}, callOptions?: CoreCallOptions) =>
        call('log.status', callOptions, async signal => {
          const workspaceRoot = asString(params.workspaceRoot) ?? process.cwd();
          const result = await rawLogLifecycle.status({ workspaceRoot, targetOrg: params.targetOrg }, { signal });
          const targetOrg = result.resolvedUsername ?? asString(params.targetOrg) ?? 'default';
          return {
            targetOrg,
            safeTargetOrg: safeTargetOrg(targetOrg),
            workspaceRoot,
            apexlogsRoot: resolveApexlogsRoot(workspaceRoot),
            ...(result.resolvedUsername
              ? {
                  orgLogsRoot: path.join(
                    resolveApexlogsRoot(workspaceRoot),
                    'orgs',
                    safeTargetOrg(result.resolvedUsername),
                    'logs'
                  )
                }
              : {}),
            stateFile: syncStatePath(workspaceRoot),
            logCount: result.localLogCount,
            hasState: result.hasState,
            lastSyncStartedAt: result.lastSyncStartedAt,
            lastSyncCompletedAt: result.lastSyncCompletedAt,
            lastSyncedLogId: result.lastSyncedLogId,
            lastSyncedStartTime: result.lastSyncedStartTime,
            downloadedCount: result.lastSync.downloaded,
            cachedCount: result.lastSync.existing + result.lastSync.materialized,
            failedCount: result.lastSync.failed
          };
        }),
      read: (params: LogsReadParams, callOptions?: CoreCallOptions) =>
        call('log.read', callOptions, async signal => {
          const workspaceRoot = asString(params.workspaceRoot);
          if (!workspaceRoot) throw new AlvError('INVALID_ARGUMENT', 'workspaceRoot is required.');
          const result = await rawLogLifecycle.read(
            {
              workspaceRoot,
              targetOrg: params.targetOrg,
              log: { logId: params.logId },
              maxBytes: params.maxBytes
            },
            { signal }
          );
          return {
            logId: result.logId,
            path: result.localPath,
            body: result.body,
            sizeBytes: result.sizeBytes,
            truncated: result.truncated
          };
        }),
      resolve: (params: LogsResolveParams, callOptions?: CoreCallOptions) =>
        call('log.resolve', callOptions, async signal => {
          const workspaceRoot = asString(params.workspaceRoot) ?? process.cwd();
          const result = await rawLogLifecycle.availableLocalPaths(
            {
              workspaceRoot,
              targetOrg: params.targetOrg,
              logs: [{ logId: params.logId }]
            },
            { signal }
          );
          if (result.failures[0]) throw result.failures[0].error;
          const localPath = result.available[0]?.localPath;
          return { logId: params.logId, path: localPath, cached: Boolean(localPath) };
        }),
      triage: (params: LogsTriageParams, callOptions?: CoreCallOptions) =>
        call('log.triage', callOptions, async signal => {
          const workspaceRoot = asString(params.workspaceRoot);
          if (!workspaceRoot) throw new AlvError('INVALID_ARGUMENT', 'workspaceRoot is required.');
          const result = await rawLogLifecycle.triage(
            {
              workspaceRoot,
              targetOrg: params.username,
              logs: params.logIds.map(logId => ({ logId, startTime: params.logStartTimes?.[logId] }))
            },
            { signal }
          );
          return result.entries.map(entry =>
            entry.status === 'triaged'
              ? { logId: entry.log.logId, summary: entry.summary }
              : { logId: entry.log.logId, summary: unreadableLogSummary(entry.error.message) }
          );
        }),
      delete: (params: LogsDeleteParams = {}, callOptions?: CoreCallOptions) =>
        orgCall('log.delete', params.targetOrg, callOptions, (ctx, signal) => logsDeleteNative(ctx, params, signal))
    },
    customLog: {
      sources: (params: CustomLogSourcesParams, callOptions?: CoreCallOptions) =>
        customLogCall('customLog.sources', params.targetOrg, callOptions, (env, signal) =>
          customLogs.sources(env, params, signal)
        ),
      list: (params: CustomLogListParams, callOptions?: CoreCallOptions) =>
        customLogCall('customLog.list', params.targetOrg, callOptions, (env, signal) =>
          customLogs.list(env, params, signal)
        ),
      get: (params: CustomLogGetParams, callOptions?: CoreCallOptions) =>
        customLogCall('customLog.get', params.targetOrg, callOptions, (env, signal) =>
          customLogs.get(env, params, signal)
        ),
      entry: (params: CustomLogEntryParams, callOptions?: CoreCallOptions) =>
        customLogCall('customLog.entry', params.targetOrg, callOptions, (env, signal) =>
          customLogs.entry(env, params, signal)
        ),
      // The username resolves from local files, so it ignores the signal: an aborted capture resolves with
      // outcome `aborted` from the api, at whatever step it stopped, and never rejects with ABORTED.
      capture: async (
        params: CustomLogCaptureParams,
        callOptions?: CaptureCallOptions
      ): Promise<CustomLogCaptureResult> =>
        customLogs.capture(await customLogEnv(params.targetOrg, undefined), params, callOptions)
    },
    user: {
      search: (params: UserSearchParams = {}, callOptions?: CoreCallOptions) =>
        orgCall('user.search', params.targetOrg, callOptions, ctx => usersSearchNative(ctx, params))
    },
    traceFlag: {
      status: (params: { targetOrg?: string; target: TraceFlagTarget }, callOptions?: CoreCallOptions) =>
        orgCall('traceFlag.status', params.targetOrg, callOptions, async ctx =>
          traceFlagStatusNative(ctx, { target: await normalizeCurrentUserTarget(ctx, params.target) })
        ),
      apply: (params: TraceFlagApplyParams, callOptions?: CoreCallOptions) =>
        orgCall('traceFlag.apply', params.targetOrg, callOptions, async ctx =>
          traceFlagApplyNative(ctx, { ...params, target: await normalizeCurrentUserTarget(ctx, params.target) })
        ),
      remove: (params: TraceFlagRemoveParams, callOptions?: CoreCallOptions) =>
        orgCall('traceFlag.remove', params.targetOrg, callOptions, async ctx =>
          traceFlagRemoveNative(ctx, { ...params, target: await normalizeCurrentUserTarget(ctx, params.target) })
        )
    },
    debugLevel: {
      list: (params: DebugLevelListParams = {}, callOptions?: CoreCallOptions) =>
        orgCall('debugLevel.list', params.targetOrg, callOptions, ctx => debugLevelsListNative(ctx)),
      get: (params: DebugLevelGetParams = {}, callOptions?: CoreCallOptions) =>
        orgCall('debugLevel.get', params.targetOrg, callOptions, ctx => debugLevelGetNative(ctx, params)),
      create: (params: DebugLevelWriteParams, callOptions?: CoreCallOptions) =>
        orgCall('debugLevel.create', params.targetOrg, callOptions, ctx => debugLevelCreateNative(ctx, params)),
      update: (params: DebugLevelWriteParams, callOptions?: CoreCallOptions) =>
        orgCall('debugLevel.update', params.targetOrg, callOptions, ctx => debugLevelUpdateNative(ctx, params)),
      delete: (params: DebugLevelDeleteParams, callOptions?: CoreCallOptions) =>
        orgCall('debugLevel.delete', params.targetOrg, callOptions, ctx => debugLevelDeleteNative(ctx, params))
    },
    tooling: {
      query: (params: ToolingQueryParams, callOptions?: CoreCallOptions): Promise<ToolingQueryResult> =>
        orgCall('tooling.query', params.targetOrg, callOptions, ctx => toolingQuery(ctx.connection, params.soql)),
      get: (params: ToolingRequestGetParams, callOptions?: CoreCallOptions) =>
        orgCall('tooling.get', params.targetOrg, callOptions, ctx =>
          connectionRequest(ctx.connection, 'GET', resolveOrgRequestPath(ctx, params.path))
        )
    },
    /** Ends the capture runs and releases their leases before the connections are cleared. */
    dispose: async (): Promise<void> => {
      await customLogs.dispose();
      connections.clear();
      rawLogLifecycle.dispose();
    }
  };
}
