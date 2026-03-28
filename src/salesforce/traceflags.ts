import type {
  ApplyTraceFlagTargetInput,
  ApplyTraceFlagTargetResult,
  DebugFlagUser,
  DebugLevelRecord,
  RemoveTraceFlagsResult,
  TraceFlagTarget,
  TraceFlagTargetStatus
} from '../../apps/vscode-extension/src/shared/debugFlagsTypes';
import { DEBUG_LEVEL_PRESETS } from '../../apps/vscode-extension/src/shared/debugLevelPresets';
import { CacheManager } from '../utils/cacheManager';
import { getBooleanConfig, getNumberConfig } from '../utils/config';
import { logTrace } from '../utils/logger';
import { getEffectiveApiVersion, httpsRequestWith401Retry } from './http';
import {
  createToolingRecord,
  deleteToolingRecord,
  queryStandard as queryStandardViaJsforce,
  queryTooling as queryToolingViaJsforce,
  updateToolingRecord
} from './jsforce';
import type { OrgAuth } from './types';

const userIdCache = new Map<string, string>();
const specialTargetIdsCache = new Map<string, string[]>();
const SALESFORCE_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;
const AUTOMATED_PROCESS_TARGET_NAME = 'Automated Process';
const AUTOMATED_PROCESS_USER_TYPE = 'AutomatedProcess';
const PLATFORM_INTEGRATION_USER_TYPE = 'CloudIntegrationUser';

type QueryResponse<TRecord = any> = {
  records?: TRecord[];
};

type SpecialTargetUserQueryRecord = {
  Id?: string;
};

type TraceFlagQueryRecord = {
  Id?: string;
  StartDate?: string;
  ExpirationDate?: string;
  DebugLevel?: {
    DeveloperName?: string;
  };
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
const DEFAULT_TAIL_DEBUG_LEVEL = { ...DEBUG_LEVEL_PRESETS[0]!.record };
const debugLevelApiVersionByOrg = new Map<string, string>();
const activeUserDebugLevelCache = new Map<string, { value: string | undefined; expiresAt: number }>();

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
  return escapeSoqlLiteral(value).replace(/%/g, '\\%').replace(/_/g, '\\_');
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
  return `${String(auth.instanceUrl || '')
    .trim()
    .toLowerCase()}|${String(auth.username || '')
    .trim()
    .toLowerCase()}`;
}

function getActiveUserDebugLevelCacheKey(auth: OrgAuth): string {
  return getDebugLevelApiVersionCacheKey(auth);
}

function getSpecialTargetCacheKey(auth: OrgAuth, targetType: Exclude<TraceFlagTarget['type'], 'user'>): string {
  const orgKey = `${String(auth.instanceUrl || '')
    .trim()
    .toLowerCase()}|${String(auth.username || '')
    .trim()
    .toLowerCase()}`;
  return `${targetType}:${orgKey}`;
}

function getTraceFlagTargetLabel(target: TraceFlagTarget): string {
  switch (target.type) {
    case 'user':
      return 'User';
    case 'automatedProcess':
      return AUTOMATED_PROCESS_TARGET_NAME;
    case 'platformIntegration':
      return 'Platform Integration';
  }
}

function isSpecialTraceFlagTarget(
  target: TraceFlagTarget
): target is Extract<TraceFlagTarget, { type: 'automatedProcess' | 'platformIntegration' }> {
  return target.type === 'automatedProcess' || target.type === 'platformIntegration';
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
    const body = await httpsRequestWith401Retry(auth, 'GET', url, {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    });
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
      logTrace(
        'getDebugLevelApiVersion: failed to discover org max API version ->',
        String((e as Error)?.message || e)
      );
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
  activeUserDebugLevelCache.clear();
}

function invalidateActiveUserDebugLevelCache(auth: OrgAuth): void {
  activeUserDebugLevelCache.delete(getActiveUserDebugLevelCacheKey(auth));
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

function queryTooling<TRecord extends Record<string, unknown>>(auth: OrgAuth, soql: string): Promise<QueryResponse<TRecord>> {
  return queryToolingWithVersion(auth, soql, getEffectiveApiVersion(auth));
}

function queryToolingWithVersion<TRecord extends Record<string, unknown>>(
  auth: OrgAuth,
  soql: string,
  apiVersion: string
): Promise<QueryResponse<TRecord>> {
  return queryToolingViaJsforce<TRecord>(auth, soql, apiVersion);
}

function queryStandard<TRecord extends Record<string, unknown>>(auth: OrgAuth, soql: string): Promise<QueryResponse<TRecord>> {
  return queryStandardViaJsforce<TRecord>(auth, soql, getEffectiveApiVersion(auth));
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
  const names = (json.records || []).map(r => r?.DeveloperName).filter((n): n is string => typeof n === 'string');

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
  const { enabled, ttl } = getDebugLevelsCacheConfig();
  const cacheKey = getActiveUserDebugLevelCacheKey(auth);
  if (enabled && ttl > 0) {
    const cached = activeUserDebugLevelCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.value;
      }
      activeUserDebugLevelCache.delete(cacheKey);
    }
  }
  const userId = await getCurrentUserId(auth);
  if (!userId) {
    return undefined;
  }
  const status = await getTraceFlagTargetStatus(auth, { type: 'user', userId });
  const activeDebugLevel = status.traceFlagId ? status.debugLevelName : undefined;
  if (enabled && ttl > 0) {
    activeUserDebugLevelCache.set(cacheKey, {
      value: activeDebugLevel,
      expiresAt: Date.now() + ttl
    });
  }
  return activeDebugLevel;
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

async function queryActiveUsersByType(auth: OrgAuth, userType: string): Promise<string[]> {
  const normalizedUserType = String(userType || '').trim();
  if (!normalizedUserType) {
    return [];
  }

  const escapedUserType = escapeSoqlLiteral(normalizedUserType);
  const soql = `SELECT Id FROM User WHERE UserType = '${escapedUserType}' AND IsActive = true ORDER BY Id LIMIT 200`;
  const json = await queryStandard<SpecialTargetUserQueryRecord>(auth, soql);
  const seen = new Set<string>();
  return (Array.isArray(json.records) ? json.records : [])
    .map(record => record?.Id)
    .filter((id): id is string => isSalesforceId(id))
    .filter(id => {
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
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

async function getSpecialTraceFlagTargetIds(
  auth: OrgAuth,
  targetType: Exclude<TraceFlagTarget['type'], 'user'>
): Promise<string[]> {
  const cacheKey = getSpecialTargetCacheKey(auth, targetType);
  if (specialTargetIdsCache.has(cacheKey)) {
    return [...(specialTargetIdsCache.get(cacheKey) || [])];
  }

  const expectedUserType =
    targetType === 'automatedProcess' ? AUTOMATED_PROCESS_USER_TYPE : PLATFORM_INTEGRATION_USER_TYPE;
  const userIds = await queryActiveUsersByType(auth, expectedUserType);
  specialTargetIdsCache.set(cacheKey, userIds);
  return [...userIds];
}

async function resolveTraceFlagTarget(
  auth: OrgAuth,
  target: TraceFlagTarget
): Promise<{ targetLabel: string; tracedEntityIds: string[]; targetAvailable: boolean }> {
  if (target.type === 'user') {
    const tracedEntityId = isSalesforceId(target.userId) ? target.userId : undefined;
    return {
      targetLabel: getTraceFlagTargetLabel(target),
      tracedEntityIds: tracedEntityId ? [tracedEntityId] : [],
      targetAvailable: Boolean(tracedEntityId)
    };
  }

  const tracedEntityIds = await getSpecialTraceFlagTargetIds(auth, target.type);
  return {
    targetLabel: getTraceFlagTargetLabel(target),
    tracedEntityIds,
    targetAvailable: tracedEntityIds.length > 0
  };
}

export function __resetUserIdCacheForTests(): void {
  userIdCache.clear();
  specialTargetIdsCache.clear();
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

export async function createDebugLevel(auth: OrgAuth, input: DebugLevelRecord): Promise<{ id: string }> {
  const payload = buildDebugLevelPayload(input);
  const apiVersion = await getDebugLevelApiVersion(auth);
  const res = await createToolingRecord(auth, apiVersion, 'DebugLevel', payload);
  if (!res?.success || !res?.id) {
    throw new Error('Failed to create DebugLevel.');
  }
  await invalidateDebugLevelsCache(auth);
  invalidateActiveUserDebugLevelCache(auth);
  return { id: String(res.id) };
}

export async function ensureDefaultTailDebugLevel(auth: OrgAuth): Promise<string> {
  const developerName = String(DEFAULT_TAIL_DEBUG_LEVEL.developerName || '').trim();
  if (!developerName) {
    throw new Error('Default tail debug level is not configured.');
  }

  const existingId = await getDebugLevelIdByName(auth, developerName);
  if (existingId) {
    return developerName;
  }

  await createDebugLevel(auth, { ...DEFAULT_TAIL_DEBUG_LEVEL });
  return developerName;
}

export async function updateDebugLevel(auth: OrgAuth, debugLevelId: string, input: DebugLevelRecord): Promise<void> {
  if (!isSalesforceId(debugLevelId)) {
    throw new Error('Invalid DebugLevel id.');
  }
  const payload = buildDebugLevelPayload(input);
  const apiVersion = await getDebugLevelApiVersion(auth);
  const result = await updateToolingRecord(auth, apiVersion, 'DebugLevel', debugLevelId, payload);
  if (result?.success === false) {
    throw new Error('Failed to update DebugLevel.');
  }
  await invalidateDebugLevelsCache(auth);
  invalidateActiveUserDebugLevelCache(auth);
}

export async function deleteDebugLevel(auth: OrgAuth, debugLevelId: string): Promise<void> {
  if (!isSalesforceId(debugLevelId)) {
    throw new Error('Invalid DebugLevel id.');
  }
  const apiVersion = await getDebugLevelApiVersion(auth);
  const result = await deleteToolingRecord(auth, apiVersion, 'DebugLevel', debugLevelId);
  if (result?.success === false) {
    throw new Error('Failed to delete DebugLevel.');
  }
  await invalidateDebugLevelsCache(auth);
  invalidateActiveUserDebugLevelCache(auth);
}

async function getLatestTraceFlagRecord(
  auth: OrgAuth,
  tracedEntityId: string
): Promise<TraceFlagQueryRecord | undefined> {
  if (!isSalesforceId(tracedEntityId)) {
    return undefined;
  }
  const soql =
    `SELECT Id, DebugLevel.DeveloperName, StartDate, ExpirationDate ` +
    `FROM TraceFlag WHERE TracedEntityId = '${tracedEntityId}' AND LogType = 'USER_DEBUG' ` +
    `ORDER BY CreatedDate DESC LIMIT 1`;
  const json = await queryTooling<TraceFlagQueryRecord>(auth, soql);
  return (json.records || [])[0];
}

async function getLatestTraceFlagId(auth: OrgAuth, tracedEntityId: string): Promise<string | undefined> {
  if (!isSalesforceId(tracedEntityId)) {
    return undefined;
  }
  const soql =
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${tracedEntityId}' AND LogType = 'USER_DEBUG' ` +
    `ORDER BY CreatedDate DESC LIMIT 1`;
  const json = await queryTooling<{ Id?: string }>(auth, soql);
  return (json.records || [])[0]?.Id;
}

async function listTraceFlagIds(auth: OrgAuth, tracedEntityId: string): Promise<string[]> {
  if (!isSalesforceId(tracedEntityId)) {
    return [];
  }
  const soql =
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${tracedEntityId}' AND LogType = 'USER_DEBUG' ` +
    `ORDER BY CreatedDate DESC LIMIT 200`;
  const json = await queryTooling<{ Id?: string }>(auth, soql);
  return (json.records || [])
    .map(record => record?.Id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function getLatestTraceFlagRecordsByEntityId(
  auth: OrgAuth,
  tracedEntityIds: readonly string[]
): Promise<Map<string, TraceFlagQueryRecord | undefined>> {
  const entries = await Promise.all(
    tracedEntityIds.map(
      async tracedEntityId => [tracedEntityId, await getLatestTraceFlagRecord(auth, tracedEntityId)] as const
    )
  );
  return new Map(entries);
}

function getTraceFlagDebugLevelName(record: TraceFlagQueryRecord | undefined): string | undefined {
  return typeof record?.DebugLevel?.DeveloperName === 'string' ? record.DebugLevel.DeveloperName : undefined;
}

export async function getTraceFlagTargetStatus(auth: OrgAuth, target: TraceFlagTarget): Promise<TraceFlagTargetStatus> {
  const resolved = await resolveTraceFlagTarget(auth, target);
  if (!resolved.targetAvailable || resolved.tracedEntityIds.length === 0) {
    return {
      target,
      targetLabel: resolved.targetLabel,
      targetAvailable: false,
      resolvedTargetCount: 0,
      activeTargetCount: 0,
      isActive: false
    };
  }

  if (!isSpecialTraceFlagTarget(target)) {
    const tracedEntityId = resolved.tracedEntityIds[0];
    const record = tracedEntityId ? await getLatestTraceFlagRecord(auth, tracedEntityId) : undefined;
    if (!record?.Id) {
      return {
        target,
        targetLabel: resolved.targetLabel,
        targetAvailable: true,
        resolvedTargetCount: tracedEntityId ? 1 : 0,
        activeTargetCount: 0,
        isActive: false
      };
    }

    const startDate = typeof record.StartDate === 'string' ? record.StartDate : undefined;
    const expirationDate = typeof record.ExpirationDate === 'string' ? record.ExpirationDate : undefined;
    const isActive = isTraceFlagActive(startDate, expirationDate);
    return {
      target,
      targetLabel: resolved.targetLabel,
      targetAvailable: true,
      traceFlagId: String(record.Id),
      debugLevelName: getTraceFlagDebugLevelName(record) || '(unknown)',
      startDate,
      expirationDate,
      resolvedTargetCount: 1,
      activeTargetCount: isActive ? 1 : 0,
      isActive
    };
  }

  const recordsByEntityId = await getLatestTraceFlagRecordsByEntityId(auth, resolved.tracedEntityIds);
  const resolvedStatuses = resolved.tracedEntityIds.map(tracedEntityId => {
    const record = recordsByEntityId.get(tracedEntityId);
    const startDate = typeof record?.StartDate === 'string' ? record.StartDate : undefined;
    const expirationDate = typeof record?.ExpirationDate === 'string' ? record.ExpirationDate : undefined;
    const isActive = Boolean(record?.Id) && isTraceFlagActive(startDate, expirationDate);
    return {
      tracedEntityId,
      record,
      startDate,
      expirationDate,
      debugLevelName: getTraceFlagDebugLevelName(record),
      isActive
    };
  });
  const activeStatuses = resolvedStatuses.filter(status => status.isActive);
  if (activeStatuses.length === 0) {
    return {
      target,
      targetLabel: resolved.targetLabel,
      targetAvailable: true,
      resolvedTargetCount: resolved.tracedEntityIds.length,
      activeTargetCount: 0,
      isActive: false
    };
  }

  const uniqueDebugLevels = new Set(activeStatuses.map(status => status.debugLevelName || '(unknown)'));
  const debugLevelMixed = activeStatuses.length !== resolved.tracedEntityIds.length || uniqueDebugLevels.size > 1;
  const firstActiveStatus = activeStatuses[0];
  const allStartDatesMatch =
    !debugLevelMixed &&
    activeStatuses.every(status => String(status.startDate || '') === String(firstActiveStatus?.startDate || ''));
  const allExpirationDatesMatch =
    !debugLevelMixed &&
    activeStatuses.every(
      status => String(status.expirationDate || '') === String(firstActiveStatus?.expirationDate || '')
    );
  return {
    target,
    targetLabel: resolved.targetLabel,
    targetAvailable: true,
    debugLevelName: debugLevelMixed ? undefined : [...uniqueDebugLevels][0],
    startDate: allStartDatesMatch ? firstActiveStatus?.startDate : undefined,
    expirationDate: allExpirationDatesMatch ? firstActiveStatus?.expirationDate : undefined,
    resolvedTargetCount: resolved.tracedEntityIds.length,
    activeTargetCount: activeStatuses.length,
    debugLevelMixed,
    isActive: true
  };
}

export async function upsertTraceFlag(
  auth: OrgAuth,
  input: ApplyTraceFlagTargetInput
): Promise<ApplyTraceFlagTargetResult> {
  const resolved = await resolveTraceFlagTarget(auth, input.target);
  if (!resolved.targetAvailable || resolved.tracedEntityIds.length === 0) {
    throw new Error(`Trace flag target '${resolved.targetLabel}' was not found.`);
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

  let createdCount = 0;
  let updatedCount = 0;
  const traceFlagIds: string[] = [];
  const apiVersion = getEffectiveApiVersion(auth);

  try {
    for (const tracedEntityId of resolved.tracedEntityIds) {
      const existingId = await getLatestTraceFlagId(auth, tracedEntityId);
      if (existingId) {
        const updateResult = await updateToolingRecord(auth, apiVersion, 'TraceFlag', existingId, {
          DebugLevelId: debugLevelId,
          StartDate: start,
          ExpirationDate: exp
        });
        if (updateResult?.success === false) {
          throw new Error('Failed to update USER_DEBUG TraceFlag.');
        }
        updatedCount += 1;
        traceFlagIds.push(existingId);
        continue;
      }

      const payload = {
        TracedEntityId: tracedEntityId,
        LogType: 'USER_DEBUG',
        DebugLevelId: debugLevelId,
        StartDate: start,
        ExpirationDate: exp
      };
      const res = await createToolingRecord(auth, apiVersion, 'TraceFlag', payload);
      if (!res || !res.success || !res.id) {
        throw new Error('Failed to create USER_DEBUG TraceFlag.');
      }
      createdCount += 1;
      traceFlagIds.push(String(res.id));
    }

    const traceFlagId = traceFlagIds.length === 1 ? traceFlagIds[0] : undefined;
    return {
      created: resolved.tracedEntityIds.length === 1 ? createdCount === 1 : createdCount > 0 && updatedCount === 0,
      traceFlagId,
      traceFlagIds,
      createdCount,
      updatedCount,
      resolvedTargetCount: resolved.tracedEntityIds.length
    };
  } finally {
    if (createdCount > 0 || updatedCount > 0) {
      invalidateActiveUserDebugLevelCache(auth);
    }
  }
}

export async function removeTraceFlags(auth: OrgAuth, target: TraceFlagTarget): Promise<RemoveTraceFlagsResult> {
  const resolved = await resolveTraceFlagTarget(auth, target);
  if (!resolved.targetAvailable || resolved.tracedEntityIds.length === 0) {
    throw new Error(`Trace flag target '${resolved.targetLabel}' was not found.`);
  }

  let removedCount = 0;
  const apiVersion = getEffectiveApiVersion(auth);
  try {
    for (const tracedEntityId of resolved.tracedEntityIds) {
      const ids = await listTraceFlagIds(auth, tracedEntityId);
      for (const id of ids) {
        const result = await deleteToolingRecord(auth, apiVersion, 'TraceFlag', id);
        if (result?.success === false) {
          throw new Error(`Failed to delete USER_DEBUG TraceFlag '${id}'.`);
        }
        removedCount += 1;
      }
    }

    return {
      removedCount,
      resolvedTargetCount: resolved.tracedEntityIds.length
    };
  } finally {
    if (removedCount > 0) {
      invalidateActiveUserDebugLevelCache(auth);
    }
  }
}

export async function getUserTraceFlagStatus(auth: OrgAuth, userId: string): Promise<TraceFlagTargetStatus> {
  return getTraceFlagTargetStatus(auth, { type: 'user', userId });
}

export async function upsertUserTraceFlag(
  auth: OrgAuth,
  input: { userId: string; debugLevelName: string; ttlMinutes: number }
): Promise<ApplyTraceFlagTargetResult> {
  return upsertTraceFlag(auth, {
    target: { type: 'user', userId: input.userId },
    debugLevelName: input.debugLevelName,
    ttlMinutes: input.ttlMinutes
  });
}

export async function removeUserTraceFlags(auth: OrgAuth, userId: string): Promise<number> {
  const result = await removeTraceFlags(auth, { type: 'user', userId });
  return result.removedCount;
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
    const result = await upsertTraceFlag(auth, {
      target: { type: 'user', userId },
      debugLevelName: developerName,
      ttlMinutes
    });
    return result.created;
  } catch (_e) {
    // Swallow errors to avoid breaking tail; caller can log a warning.
    return false;
  }
}
