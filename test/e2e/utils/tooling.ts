import { runSfJson } from './sfCli';

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

function getApiVersion(): string {
  const v = String(process.env.SF_TEST_API_VERSION || process.env.SF_API_VERSION || '60.0').trim();
  return /^\d+\.\d+$/.test(v) ? v : '60.0';
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

async function requestJson(
  auth: OrgAuth,
  method: string,
  resourcePath: string,
  body?: unknown
): Promise<any> {
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
}

function isSfId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(value);
}

export async function getCurrentUserId(auth: OrgAuth): Promise<string> {
  if (!auth.username) {
    throw new Error('Cannot resolve current user id without username.');
  }
  const usernameEsc = escapeSoqlLiteral(auth.username);
  const userSoql = encodeURIComponent(`SELECT Id FROM User WHERE Username = '${usernameEsc}' LIMIT 1`);
  const userRes = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/query?q=${userSoql}`);
  const userId: string | undefined = Array.isArray(userRes?.records) ? userRes.records[0]?.Id : undefined;
  if (!isSfId(userId)) {
    throw new Error('Failed to resolve current user id for tooling operations.');
  }
  return userId;
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
  const suffix = (typeof orgId === 'string' ? orgId : 'unknownorg').replace(/[^a-zA-Z0-9]/g, '').slice(0, 15).toLowerCase();
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

export async function ensureDebugFlagsTestUser(auth: OrgAuth): Promise<DebugFlagsE2eUser> {
  const configuredUsername = String(process.env.SF_E2E_DEBUG_FLAGS_USERNAME || '').trim();
  const targetUsername = configuredUsername || (await resolveDefaultDebugFlagsUsername(auth));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(targetUsername)) {
    throw new Error(`Invalid SF_E2E_DEBUG_FLAGS_USERNAME value: '${targetUsername}'.`);
  }

  const existing = await findUserByUsername(auth, targetUsername);
  if (existing) {
    if (!existing.active) {
      await requestJson(auth, 'PATCH', `/services/data/v${auth.apiVersion}/sobjects/User/${existing.id}`, {
        IsActive: true
      });
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
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('LICENSE_LIMIT_EXCEEDED')) {
      throw error;
    }

    // Some scratch/org setups have no spare Salesforce licenses. In this case,
    // fallback to the authenticated user so E2E can still validate debug-flag flows.
    const fallbackUserId = await getCurrentUserId(auth);
    const fallbackUsername = String(auth.username || '').trim();
    if (!fallbackUsername) {
      throw new Error(
        `Failed to create E2E debug flags test user due to license limits and could not resolve fallback username.`
      );
    }
    return {
      id: fallbackUserId,
      username: fallbackUsername
    };
  }
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
  const userEsc = escapeSoqlLiteral(userId);
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
  const userEsc = escapeSoqlLiteral(userId);
  const tfSoql = encodeURIComponent(
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userEsc}' AND LogType = 'USER_DEBUG' ORDER BY CreatedDate DESC LIMIT 200`
  );
  const tfRes = await requestJson(auth, 'GET', `/services/data/v${auth.apiVersion}/tooling/query?q=${tfSoql}`);
  const ids = (Array.isArray(tfRes?.records) ? tfRes.records : [])
    .map((record: any) => record?.Id)
    .filter((id: unknown): id is string => isSfId(id));

  for (const id of ids) {
    await requestJson(auth, 'DELETE', `/services/data/v${auth.apiVersion}/tooling/sobjects/TraceFlag/${id}`);
  }

  return ids.length;
}

export async function getOrgAuth(targetOrg: string): Promise<OrgAuth> {
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
}

export async function ensureE2eTraceFlag(auth: OrgAuth, options?: { debugLevelName?: string; ttlMinutes?: number }) {
  const debugLevelName = String(options?.debugLevelName || process.env.SF_E2E_DEBUG_LEVEL || 'ALV_E2E').trim();
  const ttlMinutes = Math.max(5, Number(options?.ttlMinutes || process.env.SF_E2E_TRACE_TTL_MINUTES || 60) || 60);
  const apiVersion = auth.apiVersion;
  const userId = await getCurrentUserId(auth);

  const dlEsc = escapeSoqlLiteral(debugLevelName);
  const dlSoql = encodeURIComponent(`SELECT Id FROM DebugLevel WHERE DeveloperName = '${dlEsc}' LIMIT 1`);
  const dlQuery = await requestJson(auth, 'GET', `/services/data/v${apiVersion}/tooling/query?q=${dlSoql}`);
  let debugLevelId: string | undefined = Array.isArray(dlQuery?.records) ? dlQuery.records[0]?.Id : undefined;

  if (!debugLevelId) {
    const createRes = await requestJson(auth, 'POST', `/services/data/v${apiVersion}/tooling/sobjects/DebugLevel`, {
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
    if (!createRes?.success || !createRes?.id) {
      throw new Error('Failed to create DebugLevel for E2E TraceFlag.');
    }
    debugLevelId = String(createRes.id);
  }

  const tfSoql = encodeURIComponent(
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'USER_DEBUG' AND DebugLevelId = '${debugLevelId}' ORDER BY CreatedDate DESC LIMIT 1`
  );
  const tfQuery = await requestJson(auth, 'GET', `/services/data/v${apiVersion}/tooling/query?q=${tfSoql}`);
  const existingTfId: string | undefined = Array.isArray(tfQuery?.records) ? tfQuery.records[0]?.Id : undefined;

  const now = new Date();
  const start = toSfDateTimeUTC(new Date(now.getTime() - 1000));
  const exp = toSfDateTimeUTC(new Date(now.getTime() + ttlMinutes * 60 * 1000));

  if (existingTfId) {
    await requestJson(auth, 'PATCH', `/services/data/v${apiVersion}/tooling/sobjects/TraceFlag/${existingTfId}`, {
      StartDate: start,
      ExpirationDate: exp
    });
    return;
  }

  const createTf = await requestJson(auth, 'POST', `/services/data/v${apiVersion}/tooling/sobjects/TraceFlag`, {
    TracedEntityId: userId,
    LogType: 'USER_DEBUG',
    DebugLevelId: debugLevelId,
    StartDate: start,
    ExpirationDate: exp
  });
  if (!createTf?.success) {
    throw new Error('Failed to create TraceFlag for E2E.');
  }
}
