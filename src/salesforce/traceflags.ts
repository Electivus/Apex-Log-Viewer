import type { ApplyUserTraceFlagInput, DebugFlagUser, UserTraceFlagStatus } from '../shared/debugFlagsTypes';
import { CacheManager } from '../utils/cacheManager';
import { getBooleanConfig, getNumberConfig } from '../utils/config';
import { logTrace } from '../utils/logger';
import { getEffectiveApiVersion, httpsRequestWith401Retry } from './http';
import type { OrgAuth } from './types';

const userIdCache = new Map<string, string>();
const SALESFORCE_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;

type QueryResponse<TRecord = any> = {
  records?: TRecord[];
};

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

function queryTooling<TRecord>(auth: OrgAuth, soql: string): Promise<QueryResponse<TRecord>> {
  const encoded = encodeURIComponent(soql);
  const url = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/query?q=${encoded}`;
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
  const key = auth.instanceUrl || auth.username || '';
  const cacheKey = `debugLevels:${key}`;
  if (enabled && ttl > 0) {
    const cached = CacheManager.get<string[]>('cli', cacheKey);
    if (Array.isArray(cached)) {
      try {
        logTrace('listDebugLevels: cache hit for', key);
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
