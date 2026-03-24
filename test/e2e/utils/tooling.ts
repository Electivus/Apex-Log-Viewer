import { Connection } from '@jsforce/jsforce-node';
import { runSfJson } from './sfCli';
import { timeE2eStep } from './timing';

export type OrgAuth = {
  accessToken: string;
  instanceUrl: string;
  username?: string;
  apiVersion: string;
};

export type DebugFlagsE2eUser = {
  id: string;
  username: string;
};

export type SpecialTraceFlagTargetType = 'automatedProcess' | 'platformIntegration';

export type ResolvedSpecialTraceFlagTarget = {
  ids: string[];
  label: string;
  matchedNames: string[];
};

export type DebugLevelToolingRecord = {
  id: string;
  developerName: string;
  masterLabel?: string;
  language?: string;
  workflow?: string;
  validation?: string;
  callout?: string;
  apexCode?: string;
  apexProfiling?: string;
  visualforce?: string;
  system?: string;
  database?: string;
  wave?: string;
  nba?: string;
  dataAccess?: string;
};

const DEBUG_LEVEL_EXTENDED_FIELDS_MIN_API_VERSION = '63.0';
const TRACE_FLAG_REMOVAL_TIMEOUT_MS = 30_000;
const TRACE_FLAG_REMOVAL_POLL_INTERVAL_MS = 1_000;
const SPECIAL_TRACE_FLAG_TARGET_USER_TYPES: Record<SpecialTraceFlagTargetType, string> = {
  automatedProcess: 'AutomatedProcess',
  platformIntegration: 'CloudIntegrationUser'
};
const SPECIAL_TRACE_FLAG_TARGET_LABELS: Record<SpecialTraceFlagTargetType, string> = {
  automatedProcess: 'Automated Process',
  platformIntegration: 'Platform Integration'
};
const TRACE_FLAG_FAST_PATH_MAX_MS = 5 * 60 * 1000;
const TRACE_FLAG_FAST_PATH_SAFETY_MS = 60_000;

const orgAuthCache = new Map<string, Promise<OrgAuth>>();
const currentUserIdCache = new Map<string, Promise<string>>();
const debugLevelIdCache = new Map<string, Promise<string>>();
const ensuredTraceFlagCache = new Map<string, number>();
const jsforceConnectionCache = new Map<string, Promise<ToolingConnectionLike>>();
const orgAuthTargetOrgByIdentity = new Map<string, string>();

type ToolingConnectionLike = Pick<Connection, 'request' | 'tooling'>;
type ToolingConnectionFactory = (auth: OrgAuth) => Promise<ToolingConnectionLike> | ToolingConnectionLike;
type ToolingQueryResponse<TRecord = any> = {
  records?: TRecord[];
  done?: boolean;
  nextRecordsUrl?: string;
};

let toolingConnectionFactoryForTests: ToolingConnectionFactory | undefined;

function getOrgAuthCacheKey(targetOrg: string): string {
  return String(targetOrg || '').trim() || '__default__';
}

function getAuthIdentityKey(auth: OrgAuth): string {
  return [stripTrailingSlash(auth.instanceUrl), String(auth.username || '').trim(), String(auth.apiVersion || '').trim()].join('|');
}

async function getOrCreateCached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) {
    return await cached;
  }

  const promise = load();
  cache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

async function createToolingConnection(auth: OrgAuth): Promise<ToolingConnectionLike> {
  if (toolingConnectionFactoryForTests) {
    return await toolingConnectionFactoryForTests(auth);
  }
  return new Connection({
    version: auth.apiVersion,
    instanceUrl: auth.instanceUrl,
    accessToken: auth.accessToken
  }) as ToolingConnectionLike;
}

async function getToolingConnection(auth: OrgAuth): Promise<ToolingConnectionLike> {
  return await getOrCreateCached(jsforceConnectionCache, getAuthIdentityKey(auth), async () => {
    return await createToolingConnection(auth);
  });
}

function getTraceFlagFastPathUntil(ttlMinutes: number, nowMs: number): number {
  const ttlMs = ttlMinutes * 60 * 1000;
  const fastPathWindowMs = Math.max(0, Math.min(ttlMs - TRACE_FLAG_FAST_PATH_SAFETY_MS, TRACE_FLAG_FAST_PATH_MAX_MS));
  return nowMs + fastPathWindowMs;
}

function rememberOrgAuthTarget(targetOrg: string, auth: OrgAuth): void {
  orgAuthTargetOrgByIdentity.set(getAuthIdentityKey(auth), getOrgAuthCacheKey(targetOrg));
}

function replaceOrgAuth(target: OrgAuth, next: OrgAuth): void {
  target.accessToken = next.accessToken;
  target.instanceUrl = next.instanceUrl;
  target.username = next.username;
  target.apiVersion = next.apiVersion;
}

function isAuthFailure(status: number | undefined, detail: string): boolean {
  const normalized = String(detail || '').toLowerCase();
  return (
    status === 401 ||
    normalized.includes('invalid_session_id') ||
    normalized.includes('session expired or invalid') ||
    normalized.includes('expired access/refresh token')
  );
}

function isToolingAuthError(error: unknown): boolean {
  const statusCode = typeof (error as any)?.statusCode === 'number' ? Number((error as any).statusCode) : undefined;
  const errorCode = String((error as any)?.errorCode || '');
  const message = String(error instanceof Error ? error.message : error || '');
  return isAuthFailure(statusCode, `${errorCode} ${message}`.trim());
}

async function refreshOrgAuth(auth: OrgAuth): Promise<boolean> {
  const targetOrg = orgAuthTargetOrgByIdentity.get(getAuthIdentityKey(auth));
  if (!targetOrg) {
    return false;
  }
  const staleIdentityKey = getAuthIdentityKey(auth);
  orgAuthCache.delete(targetOrg);
  jsforceConnectionCache.delete(staleIdentityKey);
  const refreshed = await getOrgAuth(targetOrg, { forceRefresh: true });
  replaceOrgAuth(auth, refreshed);
  rememberOrgAuthTarget(targetOrg, auth);
  jsforceConnectionCache.delete(getAuthIdentityKey(auth));
  return true;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function invalidateEnsuredTraceFlagCache(auth: OrgAuth): void {
  const authIdentityKey = getAuthIdentityKey(auth);
  for (const key of Array.from(ensuredTraceFlagCache.keys())) {
    if (key.startsWith(`${authIdentityKey}|`)) {
      ensuredTraceFlagCache.delete(key);
    }
  }
}

async function ensureDebugLevelId(auth: OrgAuth, debugLevelName: string): Promise<string> {
  const cacheKey = `${getAuthIdentityKey(auth)}|${debugLevelName}`;
  return await getOrCreateCached(debugLevelIdCache, cacheKey, async () => {
    const apiVersion = auth.apiVersion;
    const dlEsc = escapeSoqlLiteral(debugLevelName);
    const dlSoql = encodeURIComponent(`SELECT Id FROM DebugLevel WHERE DeveloperName = '${dlEsc}' LIMIT 1`);
    const dlQuery = await timeE2eStep(`tooling.ensureTraceFlag:${debugLevelName}:queryDebugLevel`, async () => {
      return await requestJson(auth, 'GET', `/services/data/v${apiVersion}/tooling/query?q=${dlSoql}`);
    });
    const existingDebugLevelId: string | undefined = Array.isArray(dlQuery?.records) ? dlQuery.records[0]?.Id : undefined;
    if (existingDebugLevelId) {
      return existingDebugLevelId;
    }

    const createRes = await timeE2eStep(`tooling.ensureTraceFlag:${debugLevelName}:createDebugLevel`, async () => {
      return await requestJson(auth, 'POST', `/services/data/v${apiVersion}/tooling/sobjects/DebugLevel`, {
        DeveloperName: debugLevelName,
        MasterLabel: debugLevelName,
        ApexCode: 'DEBUG',
        ApexProfiling: 'ERROR',
        Callout: 'ERROR',
        Database: 'ERROR',
        System: 'DEBUG',
        Validation: 'ERROR',
        Visualforce: 'ERROR',
        Workflow: 'ERROR'
      });
    });
    if (!createRes?.success || !createRes?.id) {
      throw new Error('Failed to create DebugLevel for E2E TraceFlag.');
    }
    return String(createRes.id);
  });
}

async function queryExistingTraceFlagId(
  auth: OrgAuth,
  userId: string,
  debugLevelId: string,
  debugLevelName: string
): Promise<string | undefined> {
  const tfSoql = encodeURIComponent(
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'USER_DEBUG' AND DebugLevelId = '${debugLevelId}' ORDER BY CreatedDate DESC LIMIT 1`
  );
  const tfQuery = await timeE2eStep(`tooling.ensureTraceFlag:${debugLevelName}:queryTraceFlag`, async () => {
    return await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/tooling/query?q=${tfSoql}`);
  });
  return Array.isArray(tfQuery?.records) ? tfQuery.records[0]?.Id : undefined;
}

export function __resetToolingCachesForTests(): void {
  orgAuthCache.clear();
  currentUserIdCache.clear();
  debugLevelIdCache.clear();
  ensuredTraceFlagCache.clear();
  jsforceConnectionCache.clear();
  orgAuthTargetOrgByIdentity.clear();
  toolingConnectionFactoryForTests = undefined;
}

export function primeOrgAuthCache(targetOrg: string, auth: OrgAuth): void {
  const cacheKey = getOrgAuthCacheKey(targetOrg);
  orgAuthCache.set(cacheKey, Promise.resolve(auth));
  rememberOrgAuthTarget(targetOrg, auth);
}

export function __setToolingConnectionFactoryForTests(factory: ToolingConnectionFactory | undefined): void {
  toolingConnectionFactoryForTests = factory;
  jsforceConnectionCache.clear();
}

async function withToolingConnection<T>(
  auth: OrgAuth,
  run: (connection: ToolingConnectionLike) => Promise<T>
): Promise<T> {
  const runOnce = async () => await run(await getToolingConnection(auth));

  try {
    return await runOnce();
  } catch (error) {
    if (!isToolingAuthError(error) || !(await refreshOrgAuth(auth))) {
      throw error;
    }
    return await runOnce();
  }
}

export async function assertToolingReady(auth: OrgAuth, options?: { timeoutMs?: number }): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  await withTimeout(
    withToolingConnection(auth, async connection => {
      await connection.tooling.query<{ Id?: string }>('SELECT Id FROM DebugLevel LIMIT 1');
    }),
    timeoutMs,
    'Tooling readiness probe'
  );
}

function getApiVersion(): string {
  const v = String(process.env.SF_TEST_API_VERSION || process.env.SF_API_VERSION || '60.0').trim();
  return /^\d+\.\d+$/.test(v) ? v : '60.0';
}

function parseApiVersionNumber(value: string | undefined): number | undefined {
  const raw = String(value || '').trim();
  if (!/^\d+\.\d+$/.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getDebugLevelToolingApiVersion(auth: OrgAuth): string {
  const current = String(auth.apiVersion || '').trim() || getApiVersion();
  const currentNumeric = parseApiVersionNumber(current);
  const requiredNumeric = parseApiVersionNumber(DEBUG_LEVEL_EXTENDED_FIELDS_MIN_API_VERSION);
  if (currentNumeric === undefined || requiredNumeric === undefined || currentNumeric >= requiredNumeric) {
    return current;
  }
  return DEBUG_LEVEL_EXTENDED_FIELDS_MIN_API_VERSION;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeSoqlLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestJson(auth: OrgAuth, method: string, resourcePath: string, body?: unknown): Promise<any> {
  const send = async (allowRefresh: boolean): Promise<any> => {
    const base = stripTrailingSlash(auth.instanceUrl);
    const url = `${base}${resourcePath}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      if (allowRefresh && isAuthFailure(res.status, text) && (await refreshOrgAuth(auth))) {
        return await send(false);
      }
      const detail = text ? ` -> ${text}` : '';
      throw new Error(`Tooling API request failed (${res.status}) for ${resourcePath}${detail}`);
    }
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  return await send(true);
}

function isSfId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(value);
}

export async function getCurrentUserId(auth: OrgAuth): Promise<string> {
  if (!auth.username) {
    throw new Error('Cannot resolve current user id without username.');
  }
  const cacheKey = getAuthIdentityKey(auth);
  return await getOrCreateCached(currentUserIdCache, cacheKey, async () => {
    return await timeE2eStep('tooling.getCurrentUserId', async () => {
      const usernameEsc = escapeSoqlLiteral(auth.username!);
      const userSoql = encodeURIComponent(`SELECT Id FROM User WHERE Username = '${usernameEsc}' LIMIT 1`);
      const userRes = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/query?q=${userSoql}`);
      const userId: string | undefined = Array.isArray(userRes?.records) ? userRes.records[0]?.Id : undefined;
      if (!isSfId(userId)) {
        throw new Error('Failed to resolve current user id for tooling operations.');
      }
      return userId;
    });
  });
}

async function findUserByUsername(
  auth: OrgAuth,
  username: string
): Promise<{ id: string; username: string; active: boolean } | undefined> {
  const usernameEsc = escapeSoqlLiteral(username);
  const soql = encodeURIComponent(`SELECT Id, Username, IsActive FROM User WHERE Username = '${usernameEsc}' LIMIT 1`);
  const response = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/query?q=${soql}`);
  const record = Array.isArray(response?.records) ? response.records[0] : undefined;
  if (!isSfId(record?.Id)) {
    return undefined;
  }
  return {
    id: record.Id,
    username: typeof record?.Username === 'string' ? record.Username : username,
    active: Boolean(record?.IsActive)
  };
}

async function findActiveUsersBySearchToken(
  auth: OrgAuth,
  searchToken: string,
  limit = 200
): Promise<Array<{ id: string; username: string; name: string }>> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 200)));
  const trimmed = String(searchToken || '').trim();
  const clauses = ['IsActive = true'];
  if (trimmed) {
    const escaped = escapeSoqlLiteral(trimmed).replace(/%/g, '\\%').replace(/_/g, '\\_');
    clauses.push(`(Name LIKE '%${escaped}%' OR Username LIKE '%${escaped}%')`);
  }
  const soql = encodeURIComponent(
    `SELECT Id, Name, Username FROM User WHERE ${clauses.join(' AND ')} ORDER BY Name NULLS LAST LIMIT ${safeLimit}`
  );
  const response = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/query?q=${soql}`);
  const records = Array.isArray(response?.records) ? response.records : [];
  const needle = trimmed.toLowerCase();

  return records
    .filter((record: any) => isSfId(record?.Id))
    .map((record: any) => ({
      id: record.Id,
      username: typeof record?.Username === 'string' ? record.Username : '',
      name: typeof record?.Name === 'string' ? record.Name : ''
    }))
    .filter(record => {
      if (!needle) {
        return true;
      }
      return record.name.toLowerCase().includes(needle) || record.username.toLowerCase().includes(needle);
    });
}

async function findActiveUsersByType(auth: OrgAuth, userType: string): Promise<Array<{ id: string; name: string }>> {
  const userTypeEsc = escapeSoqlLiteral(userType);
  const soql = encodeURIComponent(`SELECT Id, Name FROM User WHERE UserType = '${userTypeEsc}' AND IsActive = true ORDER BY Id LIMIT 200`);
  const response = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/query?q=${soql}`);
  const records = Array.isArray(response?.records) ? response.records : [];
  const seen = new Set<string>();
  return records
    .filter((record: any) => isSfId(record?.Id))
    .map((record: any) => ({
      id: record.Id,
      name: typeof record?.Name === 'string' ? record.Name : ''
    }))
    .filter(record => {
      if (seen.has(record.id)) {
        return false;
      }
      seen.add(record.id);
      return true;
    });
}

function toUserAlias(username: string): string {
  const compact = username.split('@')[0]?.replace(/[^a-zA-Z0-9]/g, '') || 'alve2e';
  const alias = compact.slice(0, 8);
  if (alias.length >= 2) {
    return alias;
  }
  return `${alias}e2`.slice(0, 8);
}

async function resolveDefaultDebugFlagsUsername(auth: OrgAuth): Promise<string> {
  const soql = encodeURIComponent('SELECT Id FROM Organization LIMIT 1');
  const response = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/query?q=${soql}`);
  const orgId: string | undefined = Array.isArray(response?.records) ? response.records[0]?.Id : undefined;
  const suffix = (typeof orgId === 'string' ? orgId : 'unknownorg')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 15)
    .toLowerCase();
  return `alv.debugflags.${suffix}@example.com`;
}

async function getCurrentUserCreateDefaults(auth: OrgAuth): Promise<{
  profileId: string;
  timeZoneSidKey: string;
  localeSidKey: string;
  emailEncodingKey: string;
  languageLocaleKey: string;
}> {
  const currentUserId = await getCurrentUserId(auth);
  const soql = encodeURIComponent(
    `SELECT ProfileId, TimeZoneSidKey, LocaleSidKey, EmailEncodingKey, LanguageLocaleKey FROM User WHERE Id = '${currentUserId}' LIMIT 1`
  );
  const response = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/query?q=${soql}`);
  const record = Array.isArray(response?.records) ? response.records[0] : undefined;
  const profileId = typeof record?.ProfileId === 'string' ? record.ProfileId : '';
  if (!isSfId(profileId)) {
    throw new Error('Failed to resolve current user profile for E2E debug flags test user creation.');
  }
  return {
    profileId,
    timeZoneSidKey: typeof record?.TimeZoneSidKey === 'string' ? record.TimeZoneSidKey : 'America/Los_Angeles',
    localeSidKey: typeof record?.LocaleSidKey === 'string' ? record.LocaleSidKey : 'en_US',
    emailEncodingKey: typeof record?.EmailEncodingKey === 'string' ? record.EmailEncodingKey : 'UTF-8',
    languageLocaleKey: typeof record?.LanguageLocaleKey === 'string' ? record.LanguageLocaleKey : 'en_US'
  };
}

function isLicenseLimitExceeded(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('LICENSE_LIMIT_EXCEEDED');
}

async function resolveLicenseLimitFallbackUser(auth: OrgAuth, operationLabel: string): Promise<DebugFlagsE2eUser> {
  // Some scratch/org setups have no spare Salesforce licenses. In this case,
  // fallback to the authenticated user so E2E can still validate debug-flag flows.
  const fallbackUserId = await getCurrentUserId(auth);
  const fallbackUsername = String(auth.username || '').trim();
  if (!fallbackUsername) {
    throw new Error(`${operationLabel} due to license limits and could not resolve fallback username.`);
  }
  return {
    id: fallbackUserId,
    username: fallbackUsername
  };
}

export async function ensureDebugFlagsTestUser(auth: OrgAuth): Promise<DebugFlagsE2eUser> {
  const configuredUsername = String(process.env.SF_E2E_DEBUG_FLAGS_USERNAME || '').trim();
  const targetUsername = configuredUsername || (await resolveDefaultDebugFlagsUsername(auth));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(targetUsername)) {
    throw new Error(`Invalid SF_E2E_DEBUG_FLAGS_USERNAME value: '${targetUsername}'.`);
  }

  const existing = await findUserByUsername(auth, targetUsername);
  if (existing) {
    if (!existing.active) {
      try {
        await requestJson(auth, 'PATCH', `/services/data/v${auth.apiVersion}/sobjects/User/${existing.id}`, {
          IsActive: true
        });
      } catch (error) {
        if (!isLicenseLimitExceeded(error)) {
          throw error;
        }
        return resolveLicenseLimitFallbackUser(auth, 'Failed to reactivate existing E2E debug flags test user');
      }
    }
    return {
      id: existing.id,
      username: existing.username
    };
  }

  try {
    const defaults = await getCurrentUserCreateDefaults(auth);
    const alias = toUserAlias(targetUsername);
    const createResponse = await requestJson(auth, 'POST', `/services/data/v${auth.apiVersion}/sobjects/User`, {
      Username: targetUsername,
      FirstName: 'ALV',
      LastName: 'Debug Flags E2E',
      Alias: alias,
      Email: targetUsername,
      ProfileId: defaults.profileId,
      TimeZoneSidKey: defaults.timeZoneSidKey,
      LocaleSidKey: defaults.localeSidKey,
      EmailEncodingKey: defaults.emailEncodingKey,
      LanguageLocaleKey: defaults.languageLocaleKey
    });

    const createdId: unknown = createResponse?.id;
    if (!isSfId(createdId)) {
      throw new Error('Failed to create E2E debug flags test user.');
    }

    return {
      id: createdId,
      username: targetUsername
    };
  } catch (error) {
    if (!isLicenseLimitExceeded(error)) {
      throw error;
    }
    return resolveLicenseLimitFallbackUser(auth, 'Failed to create E2E debug flags test user');
  }
}

export async function waitForDebugFlagsUserSearchAvailability(
  auth: OrgAuth,
  userId: string,
  searchToken: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<void> {
  const trimmedSearchToken = String(searchToken || '').trim();
  if (!isSfId(userId)) {
    throw new Error(`Invalid debug flags test user id '${userId}'.`);
  }
  if (!trimmedSearchToken) {
    throw new Error('waitForDebugFlagsUserSearchAvailability requires a non-empty search token.');
  }

  const timeoutMs = Math.max(5_000, Number(options?.timeoutMs || 60_000) || 60_000);
  const pollIntervalMs = Math.max(250, Number(options?.pollIntervalMs || 1_000) || 1_000);
  const deadline = Date.now() + timeoutMs;
  let lastSeenCount = 0;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const users = await findActiveUsersBySearchToken(auth, trimmedSearchToken);
      lastSeenCount = users.length;
      if (users.some(user => user.id === userId)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }

  const detail = lastError instanceof Error ? lastError.message : '';
  throw new Error(
    `Debug flags user search did not return user '${userId}' for token '${trimmedSearchToken}' after ${timeoutMs}ms.` +
      `${detail ? ` Last error: ${detail}` : ` Last seen result count: ${lastSeenCount}.`}`
  );
}

export async function getUserDebugTraceFlag(
  auth: OrgAuth,
  userId: string
): Promise<
  | {
      id: string;
      debugLevelName?: string;
      startDate?: string;
      expirationDate?: string;
    }
  | undefined
> {
  return getDebugTraceFlagByTracedEntityId(auth, userId);
}

export async function getDebugTraceFlagByTracedEntityId(
  auth: OrgAuth,
  tracedEntityId: string
): Promise<
  | {
      id: string;
      debugLevelName?: string;
      startDate?: string;
      expirationDate?: string;
    }
  | undefined
> {
  const userEsc = escapeSoqlLiteral(tracedEntityId);
  const tfSoql = encodeURIComponent(
    `SELECT Id, StartDate, ExpirationDate, DebugLevel.DeveloperName FROM TraceFlag WHERE TracedEntityId = '${userEsc}' AND LogType = 'USER_DEBUG' ORDER BY CreatedDate DESC LIMIT 1`
  );
  const tfRes = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/tooling/query?q=${tfSoql}`);
  const rec = Array.isArray(tfRes?.records) ? tfRes.records[0] : undefined;
  if (!isSfId(rec?.Id)) {
    return undefined;
  }
  return {
    id: rec.Id,
    debugLevelName: typeof rec?.DebugLevel?.DeveloperName === 'string' ? rec.DebugLevel.DeveloperName : undefined,
    startDate: typeof rec?.StartDate === 'string' ? rec.StartDate : undefined,
    expirationDate: typeof rec?.ExpirationDate === 'string' ? rec.ExpirationDate : undefined
  };
}

export async function removeUserDebugTraceFlags(auth: OrgAuth, userId: string): Promise<number> {
  return removeDebugTraceFlagsByTracedEntityId(auth, userId);
}

async function listDebugTraceFlagIdsByTracedEntityId(auth: OrgAuth, tracedEntityId: string): Promise<string[]> {
  const userEsc = escapeSoqlLiteral(tracedEntityId);
  const tfSoql = encodeURIComponent(
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userEsc}' AND LogType = 'USER_DEBUG' ORDER BY CreatedDate DESC LIMIT 200`
  );
  const tfRes = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/tooling/query?q=${tfSoql}`);
  return (Array.isArray(tfRes?.records) ? tfRes.records : [])
    .map((record: any) => record?.Id)
    .filter((id: unknown): id is string => isSfId(id));
}

export async function removeDebugTraceFlagsByTracedEntityId(auth: OrgAuth, tracedEntityId: string): Promise<number> {
  invalidateEnsuredTraceFlagCache(auth);
  let removedCount = 0;
  const deadline = Date.now() + TRACE_FLAG_REMOVAL_TIMEOUT_MS;
  const attemptedDeletes = new Set<string>();

  while (Date.now() < deadline) {
    const listedIds = await listDebugTraceFlagIdsByTracedEntityId(auth, tracedEntityId);
    if (listedIds.length === 0) {
      return removedCount;
    }

    const idsToDelete = listedIds.filter(id => !attemptedDeletes.has(id));
    for (const id of idsToDelete) {
      await requestJson(auth, 'DELETE', `/services/data/v${auth.apiVersion}/tooling/sobjects/TraceFlag/${id}`);
      attemptedDeletes.add(id);
      removedCount += 1;
    }

    await sleep(TRACE_FLAG_REMOVAL_POLL_INTERVAL_MS);
  }

  const remainingIds = await listDebugTraceFlagIdsByTracedEntityId(auth, tracedEntityId);
  if (remainingIds.length > 0) {
    throw new Error(
      `Timed out waiting for TraceFlags to be removed for traced entity ${tracedEntityId}. Remaining TraceFlag ids: ${remainingIds.join(', ')}`
    );
  }

  return removedCount;
}

export async function resolveSpecialTraceFlagTarget(
  auth: OrgAuth,
  targetType: SpecialTraceFlagTargetType
): Promise<ResolvedSpecialTraceFlagTarget | undefined> {
  const label = SPECIAL_TRACE_FLAG_TARGET_LABELS[targetType];
  const userType = SPECIAL_TRACE_FLAG_TARGET_USER_TYPES[targetType];
  const users = await findActiveUsersByType(auth, userType);
  if (users.length > 0) {
    return {
      ids: users.map(user => user.id),
      label,
      matchedNames: users.map(user => user.name || label)
    };
  }
  return undefined;
}

function mapDebugLevelRecord(record: any): DebugLevelToolingRecord | undefined {
  if (!isSfId(record?.Id)) {
    return undefined;
  }
  return {
    id: record.Id,
    developerName: typeof record?.DeveloperName === 'string' ? record.DeveloperName : '',
    masterLabel: typeof record?.MasterLabel === 'string' ? record.MasterLabel : undefined,
    language: typeof record?.Language === 'string' ? record.Language : undefined,
    workflow: typeof record?.Workflow === 'string' ? record.Workflow : undefined,
    validation: typeof record?.Validation === 'string' ? record.Validation : undefined,
    callout: typeof record?.Callout === 'string' ? record.Callout : undefined,
    apexCode: typeof record?.ApexCode === 'string' ? record.ApexCode : undefined,
    apexProfiling: typeof record?.ApexProfiling === 'string' ? record.ApexProfiling : undefined,
    visualforce: typeof record?.Visualforce === 'string' ? record.Visualforce : undefined,
    system: typeof record?.System === 'string' ? record.System : undefined,
    database: typeof record?.Database === 'string' ? record.Database : undefined,
    wave: typeof record?.Wave === 'string' ? record.Wave : undefined,
    nba: typeof record?.Nba === 'string' ? record.Nba : undefined,
    dataAccess: typeof record?.DataAccess === 'string' ? record.DataAccess : undefined
  };
}

export async function getDebugLevelByDeveloperName(
  auth: OrgAuth,
  developerName: string
): Promise<DebugLevelToolingRecord | undefined> {
  const apiVersion = getDebugLevelToolingApiVersion(auth);
  const esc = escapeSoqlLiteral(developerName);
  const soql = encodeURIComponent(
    `SELECT Id, DeveloperName, Language, MasterLabel, Workflow, Validation, Callout, ApexCode, ApexProfiling, Visualforce, System, Database, Wave, Nba, DataAccess FROM DebugLevel WHERE DeveloperName = '${esc}' LIMIT 1`
  );
  const response = await requestJson(auth, 'GET', `/services/data/v${apiVersion}/tooling/query?q=${soql}`);
  return mapDebugLevelRecord(Array.isArray(response?.records) ? response.records[0] : undefined);
}

export async function getDebugLevelById(
  auth: OrgAuth,
  debugLevelId: string
): Promise<DebugLevelToolingRecord | undefined> {
  const apiVersion = getDebugLevelToolingApiVersion(auth);
  const esc = escapeSoqlLiteral(debugLevelId);
  const soql = encodeURIComponent(
    `SELECT Id, DeveloperName, Language, MasterLabel, Workflow, Validation, Callout, ApexCode, ApexProfiling, Visualforce, System, Database, Wave, Nba, DataAccess FROM DebugLevel WHERE Id = '${esc}' LIMIT 1`
  );
  const response = await requestJson(auth, 'GET', `/services/data/v${apiVersion}/tooling/query?q=${soql}`);
  return mapDebugLevelRecord(Array.isArray(response?.records) ? response.records[0] : undefined);
}

export async function deleteDebugLevelById(auth: OrgAuth, debugLevelId: string): Promise<void> {
  if (!isSfId(debugLevelId)) {
    return;
  }
  await requestJson(auth, 'DELETE', `/services/data/v${auth.apiVersion}/tooling/sobjects/DebugLevel/${debugLevelId}`);
}

export async function deleteDebugLevelByDeveloperName(auth: OrgAuth, developerName: string): Promise<void> {
  const record = await getDebugLevelByDeveloperName(auth, developerName);
  if (!record?.id) {
    return;
  }
  await deleteDebugLevelById(auth, record.id);
}

export async function getOrgAuth(targetOrg: string, options?: { forceRefresh?: boolean }): Promise<OrgAuth> {
  const cacheKey = getOrgAuthCacheKey(targetOrg);
  if (options?.forceRefresh) {
    orgAuthCache.delete(cacheKey);
  }
  return await getOrCreateCached(orgAuthCache, cacheKey, async () => {
    const resolved = await timeE2eStep(`tooling.getOrgAuth:${targetOrg}`, async () => {
      const envAlias = String(process.env.SF_E2E_TARGET_ORG_ALIAS || process.env.SF_SCRATCH_ALIAS || '').trim();
      const envAccessToken = String(process.env.SF_E2E_ACCESS_TOKEN || '').trim();
      const envInstanceUrl = String(process.env.SF_E2E_INSTANCE_URL || '').trim();
      if (envAccessToken && envInstanceUrl && (!envAlias || envAlias === targetOrg)) {
        return {
          accessToken: envAccessToken,
          instanceUrl: envInstanceUrl,
          username: String(process.env.SF_E2E_USERNAME || '').trim() || undefined,
          apiVersion: String(process.env.SF_E2E_API_VERSION || getApiVersion()).trim() || getApiVersion()
        };
      }

      const apiVersion = getApiVersion();
      const display = await runSfJson(['org', 'display', '-o', targetOrg]);
      const result = display?.result || display;
      const accessToken: string | undefined = result?.accessToken || result?.access_token;
      const instanceUrl: string | undefined = result?.instanceUrl || result?.instance_url || result?.loginUrl;
      const username: string | undefined = result?.username;
      if (!accessToken || !instanceUrl) {
        throw new Error(`Failed to resolve org auth for '${targetOrg}' (missing accessToken/instanceUrl).`);
      }
      return {
        accessToken,
        instanceUrl,
        username,
        apiVersion
      };
    });
    rememberOrgAuthTarget(targetOrg, resolved);
    return resolved;
  });
}

export async function executeAnonymousApex(
  auth: OrgAuth,
  anonymousApex: string,
  options?: { allowFailure?: boolean }
): Promise<void> {
  const result = await withToolingConnection(auth, async connection => {
    const encodedBody = encodeURIComponent(anonymousApex);
    return await connection.request<{
      compiled?: boolean;
      success?: boolean;
      compileProblem?: string | null;
      exceptionMessage?: string | null;
      exceptionStackTrace?: string | null;
    }>({
      method: 'GET',
      url: `${auth.instanceUrl}/services/data/v${auth.apiVersion}/tooling/executeAnonymous?anonymousBody=${encodedBody}`,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  if (result?.compiled === false) {
    throw new Error(`Anonymous Apex compile failed: ${String(result?.compileProblem || 'unknown problem')}`.trim());
  }
  if (result?.success === false && !options?.allowFailure) {
    const message = String(result?.exceptionMessage || result?.exceptionStackTrace || 'unknown failure');
    throw new Error(`Anonymous Apex execution failed: ${message}`.trim());
  }
}

export async function findRecentApexLogId(auth: OrgAuth, _startedAtMs: number, marker: string): Promise<string | undefined> {
  const userId = await getCurrentUserId(auth);
  return await withToolingConnection(auth, async connection => {
    const soql = `SELECT Id, StartTime FROM ApexLog WHERE LogUserId = '${userId}' ORDER BY StartTime DESC LIMIT 10`;
    const response = await connection.tooling.query<{ Id?: string; StartTime?: string }>(soql);
    const rows = Array.isArray(response?.records) ? response.records : [];

    for (const row of rows) {
      if (!isSfId(row?.Id) || typeof row?.StartTime !== 'string') {
        continue;
      }

      const body = await connection.request<string>(
        {
          method: 'GET',
          url: `${auth.instanceUrl}/services/data/v${auth.apiVersion}/tooling/sobjects/ApexLog/${row.Id}/Body`
        },
        { responseType: 'text/plain', encoding: 'utf8' } as any
      );
      if (String(body || '').includes(marker)) {
        return row.Id;
      }
    }

    return undefined;
  });
}

async function listApexLogIds(auth: OrgAuth, scope: 'all' | 'mine'): Promise<string[]> {
  const userId = scope === 'mine' ? await getCurrentUserId(auth) : undefined;
  const whereClause = userId ? ` WHERE LogUserId = '${escapeSoqlLiteral(userId)}'` : '';
  const soql = `SELECT Id FROM ApexLog${whereClause} ORDER BY StartTime DESC, Id DESC`;
  let nextPath = `/services/data/v${auth.apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`;
  const ids: string[] = [];
  const seen = new Set<string>();

  while (nextPath) {
    const response = (await requestJson(auth, 'GET', nextPath)) as ToolingQueryResponse<{ Id?: string }>;
    const records = Array.isArray(response?.records) ? response.records : [];
    for (const record of records) {
      if (isSfId(record?.Id) && !seen.has(record.Id)) {
        seen.add(record.Id);
        ids.push(record.Id);
      }
    }
    const maybeNext = typeof response?.nextRecordsUrl === 'string' ? response.nextRecordsUrl.trim() : '';
    nextPath = response?.done || !maybeNext ? '' : maybeNext;
  }

  return ids;
}

export async function clearApexLogsForE2E(
  auth: OrgAuth,
  scope: 'all' | 'mine' = 'all'
): Promise<{ listed: number; deleted: number; failed: number; failedLogIds: string[] }> {
  const ids = await listApexLogIds(auth, scope);
  const result = {
    listed: ids.length,
    deleted: 0,
    failed: 0,
    failedLogIds: [] as string[]
  };

  for (let index = 0; index < ids.length; index += 200) {
    const chunk = ids.slice(index, index + 200);
    if (!chunk.length) {
      continue;
    }

    const response = await requestJson(
      auth,
      'DELETE',
      `/services/data/v${auth.apiVersion}/composite/sobjects?ids=${chunk.join(',')}&allOrNone=false`
    );
    const entries = Array.isArray(response) ? response : [];
    const byId = new Map<string, boolean>();
    for (const entry of entries) {
      if (isSfId(entry?.id)) {
        byId.set(entry.id, Boolean(entry?.success));
      }
    }

    for (const id of chunk) {
      if (byId.get(id) === true) {
        result.deleted += 1;
      } else {
        result.failed += 1;
        result.failedLogIds.push(id);
      }
    }
  }

  return result;
}

export async function ensureE2eTraceFlag(auth: OrgAuth, options?: { debugLevelName?: string; ttlMinutes?: number }) {
  const debugLevelName = String(options?.debugLevelName || process.env.SF_E2E_DEBUG_LEVEL || 'ALV_E2E').trim();
  const ttlMinutes = Math.max(5, Number(options?.ttlMinutes || process.env.SF_E2E_TRACE_TTL_MINUTES || 60) || 60);
  const traceFlagCacheKey = `${getAuthIdentityKey(auth)}|${debugLevelName}|${ttlMinutes}`;
  const extendedTraceFlagExpiry = await timeE2eStep(`tooling.ensureTraceFlag:${debugLevelName}`, async () => {
    const apiVersion = auth.apiVersion;
    const userId = await getCurrentUserId(auth);
    const debugLevelId = await ensureDebugLevelId(auth, debugLevelName);
    const existingTfId = await queryExistingTraceFlagId(auth, userId, debugLevelId, debugLevelName);
    const cachedFastPathUntil = ensuredTraceFlagCache.get(traceFlagCacheKey);
    if (cachedFastPathUntil && cachedFastPathUntil > Date.now() && existingTfId) {
      return false;
    }

    const now = new Date();
    const start = toSfDateTimeUTC(new Date(now.getTime() - 1000));
    const exp = toSfDateTimeUTC(new Date(now.getTime() + ttlMinutes * 60 * 1000));

    if (existingTfId) {
      await timeE2eStep(`tooling.ensureTraceFlag:${debugLevelName}:patchTraceFlag`, async () => {
        await requestJson(auth, 'PATCH', `/services/data/v${apiVersion}/tooling/sobjects/TraceFlag/${existingTfId}`, {
          StartDate: start,
          ExpirationDate: exp
        });
      });
      return true;
    }

    const createTf = await timeE2eStep(`tooling.ensureTraceFlag:${debugLevelName}:createTraceFlag`, async () => {
      return await requestJson(auth, 'POST', `/services/data/v${apiVersion}/tooling/sobjects/TraceFlag`, {
        TracedEntityId: userId,
        LogType: 'USER_DEBUG',
        DebugLevelId: debugLevelId,
        StartDate: start,
        ExpirationDate: exp
      });
    });
    if (!createTf?.success) {
      throw new Error('Failed to create TraceFlag for E2E.');
    }
    return true;
  });

  if (extendedTraceFlagExpiry) {
    ensuredTraceFlagCache.set(traceFlagCacheKey, getTraceFlagFastPathUntil(ttlMinutes, Date.now()));
  }
}
