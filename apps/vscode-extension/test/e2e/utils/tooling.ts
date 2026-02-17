import { runSfJson } from './sfCli';

export type OrgAuth = {
  accessToken: string;
  instanceUrl: string;
  username?: string;
  apiVersion: string;
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
    throw new Error(`Tooling API request failed (${res.status}) for ${resourcePath}`);
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
  if (!auth.username) {
    throw new Error('Cannot ensure TraceFlag without org username.');
  }

  const apiVersion = auth.apiVersion;
  const usernameEsc = escapeSoqlLiteral(auth.username);
  const userSoql = encodeURIComponent(`SELECT Id FROM User WHERE Username = '${usernameEsc}' LIMIT 1`);
  const userRes = await requestJson(auth, 'GET', `/services/data/v${apiVersion}/query?q=${userSoql}`);
  const userId: string | undefined = Array.isArray(userRes?.records) ? userRes.records[0]?.Id : undefined;
  if (!userId) {
    throw new Error('Failed to resolve current user id for TraceFlag setup.');
  }

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

