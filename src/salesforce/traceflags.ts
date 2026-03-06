import type { ApplyUserTraceFlagInput, DebugFlagUser, DebugLevelRecord, UserTraceFlagStatus } from '../shared/debugFlagsTypes';
import { CacheManager } from '../utils/cacheManager';
import { getBooleanConfig, getConfig, getNumberConfig } from '../utils/config';
import { logTrace } from '../utils/logger';
import path from 'path';
import { CLI_TIMEOUT_MS, execCommand } from './exec';
import { getEffectiveApiVersion, httpsRequestWith401Retry } from './http';
import { resolvePATHFromLoginShell } from './path';
import type { OrgAuth } from './types';

const userIdCache = new Map<string, string>();
const SALESFORCE_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;

type QueryResponse<TRecord = any> = {
  records?: TRecord[];
};

type DebugLevelQueryRecord = {
  Id?: string;
  DeveloperName?: string;
  MasterLabel?: string;
  Language?: string;
  Workflow?: string;
  Validation?: string;
  Callout?: string;
  ApexCode?: string;
  ApexProfiling?: string;
  Visualforce?: string;
  System?: string;
  Database?: string;
  Wave?: string;
  Nba?: string;
  DataAccess?: string;
};

const DEBUG_LEVEL_FIELDS =
  'Id, DeveloperName, Language, MasterLabel, Workflow, Validation, Callout, ApexCode, ApexProfiling, ' +
  'Visualforce, System, Database, Wave, Nba, DataAccess';
const DEBUG_LEVEL_EXTENDED_FIELDS_MIN_API_VERSION = '63.0';
const debugLevelApiVersionByOrg = new Map<string, string>();

function getDebugLevelsCacheConfig() {
  try {
    const enabled = getBooleanConfig('sfLogs.cliCache.enabled', true);
    const ttl =
      Math.max(0, getNumberConfig('sfLogs.cliCache.debugLevelsTtlSeconds', 300, 0, Number.MAX_SAFE_INTEGER)) * 1000;
    return { enabled, ttl };
  } catch {
    return { enabled: true, ttl: 300000 };
  }
}

function escapeSoqlLiteral(value: string): string {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function escapeSoqlLikeLiteral(value: string): string {
  return escapeSoqlLiteral(value)
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function isSalesforceId(value: string | undefined): value is string {
  return typeof value === 'string' && SALESFORCE_ID_REGEX.test(value);
}

function clampTtlMinutes(value: number | undefined): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return 30;
  }
  return Math.max(1, Math.min(1440, Math.floor(raw)));
}

function getDebugLevelsCacheKey(auth: OrgAuth): string {
  const key = auth.instanceUrl || auth.username || '';
  return `debugLevels:${key}`;
}

function getDebugLevelDetailsCacheKey(auth: OrgAuth): string {
  const key = auth.instanceUrl || auth.username || '';
  return `debugLevelDetails:${key}`;
}

function getDebugLevelApiVersionCacheKey(auth: OrgAuth): string {
  return `${String(auth.instanceUrl || '').trim().toLowerCase()}|${String(auth.username || '').trim().toLowerCase()}`;
}

function parseApiVersionNumber(value: string | undefined): number | undefined {
  const raw = String(value || '').trim();
  if (!/^\d+\.\d+$/.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function getDebugLevelApiVersion(auth: OrgAuth): Promise<string> {
  const currentVersion = getEffectiveApiVersion(auth);
  const currentNumeric = parseApiVersionNumber(currentVersion);
  const requiredNumeric = parseApiVersionNumber(DEBUG_LEVEL_EXTENDED_FIELDS_MIN_API_VERSION);
  if (currentNumeric === undefined || requiredNumeric === undefined || currentNumeric >= requiredNumeric) {
    return currentVersion;
  }

  const cacheKey = getDebugLevelApiVersionCacheKey(auth);
  const cached = debugLevelApiVersionByOrg.get(cacheKey);
  const cachedNumeric = parseApiVersionNumber(cached);
  if (cached && cachedNumeric !== undefined && cachedNumeric >= requiredNumeric) {
    return cached;
  }

  try {
    const url = `${auth.instanceUrl}/services/data`;
    const body = await httpsRequestWith401Retry(
      auth,
      'GET',
      url,
      {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json'
      }
    );
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) {
      return currentVersion;
    }

    let maxVersion = currentVersion;
    let maxNumeric = currentNumeric;
    for (const item of parsed) {
      const candidate = String(item?.version || '').trim();
      const candidateNumeric = parseApiVersionNumber(candidate);
      if (candidateNumeric !== undefined && (maxNumeric === undefined || candidateNumeric > maxNumeric)) {
        maxVersion = candidate;
        maxNumeric = candidateNumeric;
      }
    }

    if (maxNumeric !== undefined && maxNumeric >= requiredNumeric) {
      debugLevelApiVersionByOrg.set(cacheKey, maxVersion);
      return maxVersion;
    }
  } catch (e) {
    try {
      logTrace('getDebugLevelApiVersion: failed to discover org max API version ->', String((e as Error)?.message || e));
    } catch {}
  }

  return currentVersion;
}

async function invalidateDebugLevelsCache(auth: OrgAuth): Promise<void> {
  await Promise.all([
    CacheManager.delete('cli', getDebugLevelsCacheKey(auth)),
    CacheManager.delete('cli', getDebugLevelDetailsCacheKey(auth))
  ]);
}

export function __resetDebugLevelApiVersionCacheForTests(): void {
  debugLevelApiVersionByOrg.clear();
}

function mapDebugLevelRecord(record: DebugLevelQueryRecord): DebugLevelRecord {
  return {
    id: typeof record.Id === 'string' ? record.Id : undefined,
    developerName: typeof record.DeveloperName === 'string' ? record.DeveloperName : '',
    masterLabel: typeof record.MasterLabel === 'string' ? record.MasterLabel : '',
    language: typeof record.Language === 'string' ? record.Language : '',
    workflow: typeof record.Workflow === 'string' ? record.Workflow : '',
    validation: typeof record.Validation === 'string' ? record.Validation : '',
    callout: typeof record.Callout === 'string' ? record.Callout : '',
    apexCode: typeof record.ApexCode === 'string' ? record.ApexCode : '',
    apexProfiling: typeof record.ApexProfiling === 'string' ? record.ApexProfiling : '',
    visualforce: typeof record.Visualforce === 'string' ? record.Visualforce : '',
    system: typeof record.System === 'string' ? record.System : '',
    database: typeof record.Database === 'string' ? record.Database : '',
    wave: typeof record.Wave === 'string' ? record.Wave : '',
    nba: typeof record.Nba === 'string' ? record.Nba : '',
    dataAccess: typeof record.DataAccess === 'string' ? record.DataAccess : ''
  };
}

function buildDebugLevelPayload(input: DebugLevelRecord) {
  return {
    DeveloperName: String(input.developerName || '').trim(),
    MasterLabel: String(input.masterLabel || '').trim(),
    Language: String(input.language || '').trim(),
    Workflow: String(input.workflow || '').trim(),
    Validation: String(input.validation || '').trim(),
    Callout: String(input.callout || '').trim(),
    ApexCode: String(input.apexCode || '').trim(),
    ApexProfiling: String(input.apexProfiling || '').trim(),
    Visualforce: String(input.visualforce || '').trim(),
    System: String(input.system || '').trim(),
    Database: String(input.database || '').trim(),
    Wave: String(input.wave || '').trim(),
    Nba: String(input.nba || '').trim(),
    DataAccess: String(input.dataAccess || '').trim()
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseCliJson(stdout: string): any {
  const raw = String(stdout || '').trim();
  if (!raw) {
    throw new Error('empty CLI output');
  }
  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = stripAnsi(raw);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('invalid CLI JSON output');
  }
}

function quoteWindowsCmdArg(value: string): string {
  const raw = String(value ?? '');
  return `"${raw.replace(/"/g, '""')}"`;
}

async function execSfCommand(
  program: string,
  args: string[],
  envOverride?: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform === 'win32' && /\.cmd$/i.test(program)) {
    const command = [program, ...args].map(quoteWindowsCmdArg).join(' ');
    return execCommand('cmd.exe', ['/d', '/s', '/c', command], envOverride, CLI_TIMEOUT_MS);
  }
  return execCommand(program, args, envOverride, CLI_TIMEOUT_MS);
}

function getSfCliProgramCandidates(): string[] {
  const configured = String(getConfig<string | undefined>('sfLogs.cliPath', undefined) || '').trim();
  const windowsAppDataSf =
    process.platform === 'win32' && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'sf.cmd')
      : '';
  const windowsUserProfileSf =
    process.platform === 'win32' && process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'sf.cmd')
      : '';
  return Array.from(
    new Set([configured, windowsAppDataSf, windowsUserProfileSf, process.platform === 'win32' ? 'sf.cmd' : '', 'sf'].filter(Boolean))
  );
}

async function runSfJson(args: string[]): Promise<any> {
  let lastError: unknown;
  let sawEnoent = false;
  for (const program of getSfCliProgramCandidates()) {
    try {
      const { stdout } = await execSfCommand(program, [...args, '--json']);
      return parseCliJson(stdout);
    } catch (e) {
      lastError = e;
      if ((e as any)?.code === 'ENOENT') {
        sawEnoent = true;
      }
    }
  }

  if (sawEnoent) {
    const loginPath = await resolvePATHFromLoginShell();
    if (loginPath) {
      const envOverride: NodeJS.ProcessEnv = { ...process.env, PATH: loginPath };
      for (const program of getSfCliProgramCandidates()) {
        try {
          const { stdout } = await execSfCommand(program, [...args, '--json'], envOverride);
          return parseCliJson(stdout);
        } catch (e) {
          lastError = e;
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to execute Salesforce CLI JSON command.');
}

function encodeSfValue(value: string): string {
  const normalized = String(value ?? '');
  if (!normalized) {
    return "''";
  }
  if (/[\s'"]/.test(normalized)) {
    return `'${normalized.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  return normalized;
}

function buildSfValuesArg(payload: Record<string, string>): string {
  return Object.entries(payload)
    .map(([field, value]) => `${field}=${encodeSfValue(value)}`)
    .join(' ');
}

function queryTooling<TRecord>(auth: OrgAuth, soql: string): Promise<QueryResponse<TRecord>> {
  return queryToolingWithVersion(auth, soql, getEffectiveApiVersion(auth));
}

function queryToolingWithVersion<TRecord>(
  auth: OrgAuth,
  soql: string,
  apiVersion: string
): Promise<QueryResponse<TRecord>> {
  const encoded = encodeURIComponent(soql);
  const url = `${auth.instanceUrl}/services/data/v${apiVersion}/tooling/query?q=${encoded}`;
  return httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  }).then(body => JSON.parse(body) as QueryResponse<TRecord>);
}

function queryStandard<TRecord>(auth: OrgAuth, soql: string): Promise<QueryResponse<TRecord>> {
  const encoded = encodeURIComponent(soql);
  const url = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/query?q=${encoded}`;
  return httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  }).then(body => JSON.parse(body) as QueryResponse<TRecord>);
}

export async function listDebugLevels(auth: OrgAuth): Promise<string[]> {
  const { enabled, ttl } = getDebugLevelsCacheConfig();
  const cacheKey = getDebugLevelsCacheKey(auth);
  if (enabled && ttl > 0) {
    const cached = CacheManager.get<string[]>('cli', cacheKey);
    if (Array.isArray(cached)) {
      try {
        logTrace('listDebugLevels: cache hit for', auth.instanceUrl || auth.username || '');
      } catch {}
      return cached;
    }
  }

  const soql = 'SELECT DeveloperName FROM DebugLevel ORDER BY DeveloperName';
  const json = await queryTooling<{ DeveloperName?: string }>(auth, soql);
  const names = (json.records || [])
    .map(r => r?.DeveloperName)
    .filter((n): n is string => typeof n === 'string');

  if (enabled && ttl > 0) {
    await CacheManager.set('cli', cacheKey, names, ttl);
  }
  return names;
}

export async function listDebugLevelDetails(auth: OrgAuth): Promise<DebugLevelRecord[]> {
  const { enabled, ttl } = getDebugLevelsCacheConfig();
  const cacheKey = getDebugLevelDetailsCacheKey(auth);
  if (enabled && ttl > 0) {
    const cached = CacheManager.get<DebugLevelRecord[]>('cli', cacheKey);
    if (Array.isArray(cached)) {
      return cached;
    }
  }

  const soql = `SELECT ${DEBUG_LEVEL_FIELDS} FROM DebugLevel ORDER BY DeveloperName`;
  const apiVersion = await getDebugLevelApiVersion(auth);
  const json = await queryToolingWithVersion<DebugLevelQueryRecord>(auth, soql, apiVersion);
  const records = (json.records || []).map(mapDebugLevelRecord);

  if (enabled && ttl > 0) {
    await CacheManager.set('cli', cacheKey, records, ttl);
  }
  return records;
}

export async function listActiveUsers(auth: OrgAuth, query = '', limit = 50): Promise<DebugFlagUser[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  const trimmed = String(query || '').trim();
  const clauses = ['IsActive = true'];
  if (trimmed) {
    const escaped = escapeSoqlLikeLiteral(trimmed);
    // Some orgs reject the SOQL ESCAPE clause with MALFORMED_QUERY.
    // Keep LIKE portable and rely on local fallback filtering below for consistency.
    clauses.push(`(Name LIKE '%${escaped}%' OR Username LIKE '%${escaped}%')`);
  }
  const soql =
    `SELECT Id, Name, Username, IsActive FROM User ` +
    `WHERE ${clauses.join(' AND ')} ORDER BY Name NULLS LAST LIMIT ${safeLimit}`;
  const json = await queryStandard<{ Id?: string; Name?: string; Username?: string; IsActive?: boolean }>(auth, soql);
  const users = (json.records || [])
    .filter(record => isSalesforceId(record?.Id))
    .map(record => ({
      id: record.Id!,
      name: typeof record.Name === 'string' && record.Name.trim() ? record.Name.trim() : record.Username || record.Id!,
      username: typeof record.Username === 'string' ? record.Username : '',
      active: Boolean(record.IsActive)
    }));

  if (!trimmed) {
    return users;
  }

  // Defensive fallback: some org/API combinations may return broader User sets than requested.
  // Keep the UI behavior consistent by enforcing the query on the mapped payload too.
  const needle = trimmed.toLowerCase();
  return users.filter(user => {
    const name = user.name.toLowerCase();
    const username = user.username.toLowerCase();
    return name.includes(needle) || username.includes(needle);
  });
}

export async function getActiveUserDebugLevel(auth: OrgAuth): Promise<string | undefined> {
  const userId = await getCurrentUserId(auth);
  if (!userId) {
    return undefined;
  }
  const status = await getUserTraceFlagStatus(auth, userId);
  return status?.debugLevelName;
}

// Format date as Salesforce datetime: YYYY-MM-DDTHH:mm:ss.SSS+0000 (UTC)
function toSfDateTimeUTC(d: Date): string {
  const pad = (n: number, w: number = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-` +
    `${pad(d.getUTCMonth() + 1)}-` +
    `${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:` +
    `${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}+0000`
  );
}

function isTraceFlagActive(startDate: string | undefined, expirationDate: string | undefined): boolean {
  const now = Date.now();
  const startMs = startDate ? Date.parse(startDate) : Number.NEGATIVE_INFINITY;
  const expMs = expirationDate ? Date.parse(expirationDate) : Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(expMs)) {
    return false;
  }
  return startMs <= now && now <= expMs;
}

export async function getCurrentUserId(auth: OrgAuth): Promise<string | undefined> {
  const username = (auth.username || '').trim();
  if (!username) {
    return undefined;
  }
  const key = `${auth.instanceUrl || ''}::${username}`;
  const cached = userIdCache.get(key);
  if (cached) {
    return cached;
  }

  const esc = escapeSoqlLiteral(username);
  const soql = `SELECT Id FROM User WHERE Username = '${esc}' LIMIT 1`;
  const userJson = await queryStandard<{ Id?: string }>(auth, soql);
  const userId: string | undefined = Array.isArray(userJson.records) ? userJson.records[0]?.Id : undefined;
  if (userId) {
    userIdCache.set(key, userId);
  }
  return userId;
}

export function __resetUserIdCacheForTests(): void {
  userIdCache.clear();
}

async function getDebugLevelIdByName(auth: OrgAuth, developerName: string): Promise<string | undefined> {
  const name = (developerName || '').trim();
  if (!name) {
    return undefined;
  }
  const esc = escapeSoqlLiteral(name);
  const soql = `SELECT Id FROM DebugLevel WHERE DeveloperName = '${esc}' LIMIT 1`;
  const json = await queryTooling<{ Id?: string }>(auth, soql);
  const rec = (json.records || [])[0];
  return rec?.Id;
}

export async function createDebugLevel(
  auth: OrgAuth,
  input: DebugLevelRecord
): Promise<{ id: string }> {
  const payload = buildDebugLevelPayload(input);
  const apiVersion = await getDebugLevelApiVersion(auth);
  if (auth.username) {
    try {
      const cli = await runSfJson([
        'data',
        'create',
        'record',
        '--use-tooling-api',
        '--target-org',
        auth.username,
        '--api-version',
        apiVersion,
        '--sobject',
        'DebugLevel',
        '--values',
        buildSfValuesArg(payload)
      ]);
      const result = cli?.result || cli;
      if (result?.success && result?.id) {
        await invalidateDebugLevelsCache(auth);
        return { id: String(result.id) };
      }
    } catch (e) {
      try {
        logTrace('createDebugLevel: CLI mutation failed, falling back to HTTP ->', String((e as Error)?.message || e));
      } catch {}
    }
  }

  const createUrl = `${auth.instanceUrl}/services/data/v${apiVersion}/tooling/sobjects/DebugLevel`;
  const resBody = await httpsRequestWith401Retry(
    auth,
    'POST',
    createUrl,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    JSON.stringify(payload)
  );
  const res = JSON.parse(resBody);
  if (!res?.success || !res?.id) {
    throw new Error('Failed to create DebugLevel.');
  }
  await invalidateDebugLevelsCache(auth);
  return { id: String(res.id) };
}

export async function updateDebugLevel(
  auth: OrgAuth,
  debugLevelId: string,
  input: DebugLevelRecord
): Promise<void> {
  if (!isSalesforceId(debugLevelId)) {
    throw new Error('Invalid DebugLevel id.');
  }
  const payload = buildDebugLevelPayload(input);
  const apiVersion = await getDebugLevelApiVersion(auth);
  if (auth.username) {
    try {
      const cli = await runSfJson([
        'data',
        'update',
        'record',
        '--use-tooling-api',
        '--target-org',
        auth.username,
        '--api-version',
        apiVersion,
        '--sobject',
        'DebugLevel',
        '--record-id',
        debugLevelId,
        '--values',
        buildSfValuesArg(payload)
      ]);
      const result = cli?.result || cli;
      if (result?.success !== false) {
        await invalidateDebugLevelsCache(auth);
        return;
      }
    } catch (e) {
      try {
        logTrace('updateDebugLevel: CLI mutation failed, falling back to HTTP ->', String((e as Error)?.message || e));
      } catch {}
    }
  }

  const updateUrl =
    `${auth.instanceUrl}/services/data/v${apiVersion}/tooling/sobjects/DebugLevel/${debugLevelId}`;
  await httpsRequestWith401Retry(
    auth,
    'PATCH',
    updateUrl,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    JSON.stringify(payload)
  );
  await invalidateDebugLevelsCache(auth);
}

export async function deleteDebugLevel(auth: OrgAuth, debugLevelId: string): Promise<void> {
  if (!isSalesforceId(debugLevelId)) {
    throw new Error('Invalid DebugLevel id.');
  }
  const apiVersion = await getDebugLevelApiVersion(auth);
  if (auth.username) {
    try {
      const cli = await runSfJson([
        'data',
        'delete',
        'record',
        '--use-tooling-api',
        '--target-org',
        auth.username,
        '--api-version',
        apiVersion,
        '--sobject',
        'DebugLevel',
        '--record-id',
        debugLevelId
      ]);
      const result = cli?.result || cli;
      if (result?.success !== false) {
        await invalidateDebugLevelsCache(auth);
        return;
      }
    } catch (e) {
      try {
        logTrace('deleteDebugLevel: CLI mutation failed, falling back to HTTP ->', String((e as Error)?.message || e));
      } catch {}
    }
  }

  const deleteUrl =
    `${auth.instanceUrl}/services/data/v${apiVersion}/tooling/sobjects/DebugLevel/${debugLevelId}`;
  await httpsRequestWith401Retry(auth, 'DELETE', deleteUrl, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  await invalidateDebugLevelsCache(auth);
}

async function getLatestUserDebugTraceFlagRecord(auth: OrgAuth, userId: string): Promise<any | undefined> {
  if (!isSalesforceId(userId)) {
    return undefined;
  }
  const soql =
    `SELECT Id, DebugLevel.DeveloperName, StartDate, ExpirationDate ` +
    `FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'USER_DEBUG' ` +
    `ORDER BY CreatedDate DESC LIMIT 1`;
  const json = await queryTooling<any>(auth, soql);
  return (json.records || [])[0];
}

async function getLatestUserDebugTraceFlagId(auth: OrgAuth, userId: string): Promise<string | undefined> {
  if (!isSalesforceId(userId)) {
    return undefined;
  }
  const soql =
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'USER_DEBUG' ` +
    `ORDER BY CreatedDate DESC LIMIT 1`;
  const json = await queryTooling<{ Id?: string }>(auth, soql);
  return (json.records || [])[0]?.Id;
}

export async function getUserTraceFlagStatus(auth: OrgAuth, userId: string): Promise<UserTraceFlagStatus | undefined> {
  const record = await getLatestUserDebugTraceFlagRecord(auth, userId);
  if (!record?.Id) {
    return undefined;
  }
  const startDate = typeof record.StartDate === 'string' ? record.StartDate : undefined;
  const expirationDate = typeof record.ExpirationDate === 'string' ? record.ExpirationDate : undefined;
  return {
    traceFlagId: String(record.Id),
    debugLevelName:
      typeof record.DebugLevel?.DeveloperName === 'string' ? record.DebugLevel.DeveloperName : '(unknown)',
    startDate,
    expirationDate,
    isActive: isTraceFlagActive(startDate, expirationDate)
  };
}

export async function upsertUserTraceFlag(
  auth: OrgAuth,
  input: ApplyUserTraceFlagInput
): Promise<{ created: boolean; traceFlagId?: string }> {
  if (!isSalesforceId(input?.userId)) {
    throw new Error('Invalid Salesforce user id.');
  }
  const debugLevelName = String(input.debugLevelName || '').trim();
  if (!debugLevelName) {
    throw new Error('Debug level is required.');
  }

  const debugLevelId = await getDebugLevelIdByName(auth, debugLevelName);
  if (!debugLevelId) {
    throw new Error(`Debug level '${debugLevelName}' was not found.`);
  }

  const ttlMinutes = clampTtlMinutes(input.ttlMinutes);
  const now = new Date();
  const start = toSfDateTimeUTC(new Date(now.getTime() - 1000));
  const exp = toSfDateTimeUTC(new Date(now.getTime() + ttlMinutes * 60 * 1000));

  const existingId = await getLatestUserDebugTraceFlagId(auth, input.userId);
  if (existingId) {
    const patchUrl = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/sobjects/TraceFlag/${existingId}`;
    await httpsRequestWith401Retry(
      auth,
      'PATCH',
      patchUrl,
      {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json'
      },
      JSON.stringify({
        DebugLevelId: debugLevelId,
        StartDate: start,
        ExpirationDate: exp
      })
    );
    return { created: false, traceFlagId: existingId };
  }

  const createUrl = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/sobjects/TraceFlag`;
  const payload = {
    TracedEntityId: input.userId,
    LogType: 'USER_DEBUG',
    DebugLevelId: debugLevelId,
    StartDate: start,
    ExpirationDate: exp
  };
  const resBody = await httpsRequestWith401Retry(
    auth,
    'POST',
    createUrl,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    JSON.stringify(payload)
  );
  const res = JSON.parse(resBody);
  if (res && res.success) {
    return { created: true, traceFlagId: res.id };
  }
  throw new Error('Failed to create USER_DEBUG TraceFlag.');
}

export async function removeUserTraceFlags(auth: OrgAuth, userId: string): Promise<number> {
  if (!isSalesforceId(userId)) {
    throw new Error('Invalid Salesforce user id.');
  }
  const soql =
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'USER_DEBUG' ` +
    `ORDER BY CreatedDate DESC LIMIT 200`;
  const json = await queryTooling<{ Id?: string }>(auth, soql);
  const ids = (json.records || [])
    .map(record => record?.Id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  for (const id of ids) {
    const deleteUrl = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/sobjects/TraceFlag/${id}`;
    await httpsRequestWith401Retry(auth, 'DELETE', deleteUrl, {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    });
  }

  return ids.length;
}

export async function ensureUserTraceFlag(
  auth: OrgAuth,
  developerName: string,
  ttlMinutes: number = 30
): Promise<boolean> {
  // Returns true if created a new TraceFlag, false if updated or not possible.
  try {
    const userId = await getCurrentUserId(auth);
    if (!userId) {
      try {
        logTrace('ensureUserTraceFlag: no user id');
      } catch {}
      return false;
    }
    const result = await upsertUserTraceFlag(auth, {
      userId,
      debugLevelName: developerName,
      ttlMinutes
    });
    return result.created;
  } catch (_e) {
    // Swallow errors to avoid breaking tail; caller can log a warning.
    return false;
  }
}
