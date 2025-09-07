import { logTrace } from '../utils/logger';
import { httpsRequestWith401Retry, getApiVersion } from './http';
import type { OrgAuth } from './types';

const userIdCache = new Map<string, string>();

export async function listDebugLevels(auth: OrgAuth): Promise<string[]> {
  const soql = encodeURIComponent('SELECT DeveloperName FROM DebugLevel ORDER BY DeveloperName');
  const url = `${auth.instanceUrl}/services/data/v${getApiVersion()}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const json = JSON.parse(body);
  return (json.records || []).map((r: any) => r?.DeveloperName).filter((n: any): n is string => typeof n === 'string');
}

export async function getActiveUserDebugLevel(auth: OrgAuth): Promise<string | undefined> {
  const userId = await getCurrentUserId(auth);
  if (!userId) {
    return undefined;
  }
  const tfSoql = encodeURIComponent(
    `SELECT DebugLevel.DeveloperName FROM TraceFlag WHERE TracedEntityId = '${userId}' ORDER BY CreatedDate DESC LIMIT 1`
  );
  const tfUrl = `${auth.instanceUrl}/services/data/v${getApiVersion()}/tooling/query?q=${tfSoql}`;
  const tfBody = await httpsRequestWith401Retry(auth, 'GET', tfUrl, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const tfJson = JSON.parse(tfBody);
  const rec = (tfJson.records || [])[0];
  return rec?.DebugLevel?.DeveloperName as string | undefined;
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
  const esc = username.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const userSoql = encodeURIComponent(`SELECT Id FROM User WHERE Username = '${esc}' LIMIT 1`);
  const userUrl = `${auth.instanceUrl}/services/data/v${getApiVersion()}/query?q=${userSoql}`;
  const userBody = await httpsRequestWith401Retry(auth, 'GET', userUrl, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const userJson = JSON.parse(userBody);
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
  const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const soql = encodeURIComponent(`SELECT Id FROM DebugLevel WHERE DeveloperName = '${esc}' LIMIT 1`);
  const url = `${auth.instanceUrl}/services/data/v${getApiVersion()}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const json = JSON.parse(body);
  const rec = (json.records || [])[0];
  return rec?.Id as string | undefined;
}

async function hasActiveTraceFlag(auth: OrgAuth, userId: string): Promise<boolean> {
  const now = toSfDateTimeUTC(new Date());
  const soql = encodeURIComponent(
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'DEVELOPER_LOG' AND StartDate <= ${now} AND ExpirationDate > ${now} ORDER BY CreatedDate DESC LIMIT 1`
  );
  const url = `${auth.instanceUrl}/services/data/v${getApiVersion()}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const json = JSON.parse(body);
  return Array.isArray(json.records) && json.records.length > 0;
}

export async function ensureUserTraceFlag(
  auth: OrgAuth,
  developerName: string,
  ttlMinutes: number = 30
): Promise<boolean> {
  // Returns true if created a new TraceFlag, false if one already active or not possible
  try {
    const userId = await getCurrentUserId(auth);
    if (!userId) {
      try {
        logTrace('ensureUserTraceFlag: no user id');
      } catch {}
      return false;
    }
    // If already active, do nothing
    if (await hasActiveTraceFlag(auth, userId)) {
      try {
        logTrace('ensureUserTraceFlag: active traceflag exists for user');
      } catch {}
      return false;
    }
    // Resolve DebugLevelId
    const debugLevelId = await getDebugLevelIdByName(auth, developerName);
    if (!debugLevelId) {
      try {
        logTrace('ensureUserTraceFlag: debug level not found for', developerName);
      } catch {}
      return false;
    }
    const now = new Date();
    const start = toSfDateTimeUTC(new Date(now.getTime() - 1000));
    const exp = toSfDateTimeUTC(new Date(now.getTime() + Math.max(1, ttlMinutes) * 60 * 1000));
    const url = `${auth.instanceUrl}/services/data/v${getApiVersion()}/tooling/sobjects/TraceFlag`;
    const payload = {
      TracedEntityId: userId,
      LogType: 'DEVELOPER_LOG',
      DebugLevelId: debugLevelId,
      StartDate: start,
      ExpirationDate: exp
    } as any;
    const resBody = await httpsRequestWith401Retry(
      auth,
      'POST',
      url,
      {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json'
      },
      JSON.stringify(payload)
    );
    const res = JSON.parse(resBody);
    if (res && res.success) {
      try {
        logTrace('ensureUserTraceFlag: created TraceFlag', res.id || '(unknown id)');
      } catch {}
      return true;
    }
    return false;
  } catch (_e) {
    // Swallow errors to avoid breaking tail; caller can log a warning
    return false;
  }
}
