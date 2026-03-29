import type { HttpRequest } from '@jsforce/jsforce-node';
import { __resetHttpsRequestImplForTests, __setHttpsRequestImplForTests, requestText } from './jsforce';
import {
  __resetApiVersionFallbackStateForTests as resetApiVersionFallbackStateForTests,
  extractApiVersionFromUrl,
  getApiVersion as getConfiguredApiVersion,
  getApiVersionFallbackWarning as getApiVersionFallbackWarningFromState,
  getEffectiveApiVersion as getEffectiveApiVersionFromState,
  parseApiVersion,
  recordApiVersionFallback,
  replaceApiVersionInUrl,
  setApiVersion as setConfiguredApiVersion
} from './apiVersion';
import { logTrace, logWarn } from '../utils/logger';
import { stringifyUnknown } from '../utils/error';
import type { ApexLogRow, OrgAuth } from './types';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeOrgKey(auth: OrgAuth): string {
  const instance = stripTrailingSlash(String(auth.instanceUrl || '').trim()).toLowerCase();
  if (instance) {
    return instance;
  }
  return String(auth.username || '').trim().toLowerCase();
}

function errorText(error: unknown): string {
  return stringifyUnknown((error as { message?: unknown } | undefined)?.message ?? error);
}

function isVersionNotFound404(error: unknown): boolean {
  const code = String((error as { errorCode?: string } | undefined)?.errorCode || '').toUpperCase();
  if (code === 'NOT_FOUND' || code === 'ERROR_HTTP_404') {
    return true;
  }
  const data = (error as { data?: unknown } | undefined)?.data;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (String((item as { errorCode?: string } | undefined)?.errorCode || '').toUpperCase() === 'NOT_FOUND') {
        return true;
      }
    }
  }
  return /not[_\s-]?found|requested resource does not exist/i.test(errorText(error));
}

async function discoverOrgMaxApiVersion(auth: OrgAuth, timeoutMs?: number, signal?: AbortSignal): Promise<string | undefined> {
  const base = stripTrailingSlash(String(auth.instanceUrl || '').trim());
  if (!base) {
    return undefined;
  }
  const body = await requestText(
    auth,
    {
      method: 'GET',
      url: `${base}/services/data`,
      headers: {
        'Content-Type': 'application/json'
      }
    },
    { timeoutMs, signal }
  );
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  let maxVersion: string | undefined;
  let maxNumeric = -1;
  for (const item of parsed) {
    const version = item?.version;
    const numeric = parseApiVersion(version);
    if (numeric !== undefined && numeric > maxNumeric) {
      maxNumeric = numeric;
      maxVersion = version;
    }
  }
  return maxVersion;
}

async function requestTextWithVersionFallback(
  auth: OrgAuth,
  request: HttpRequest,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<string> {
  let activeRequest = request;
  let attemptedVersionFallback = false;
  for (;;) {
    try {
      try {
        logTrace('HTTP', activeRequest.method, activeRequest.url);
      } catch {}
      return await requestText(auth, activeRequest, { timeoutMs, signal });
    } catch (error) {
      if (!attemptedVersionFallback && isVersionNotFound404(error)) {
        const requestedVersion = extractApiVersionFromUrl(String(activeRequest.url || ''));
        const requestedNumeric = parseApiVersion(requestedVersion);
        const orgMaxVersion = await discoverOrgMaxApiVersion(auth, timeoutMs, signal).catch(() => undefined);
        const orgMaxNumeric = parseApiVersion(orgMaxVersion);
        if (
          requestedVersion &&
          requestedNumeric !== undefined &&
          orgMaxVersion &&
          orgMaxNumeric !== undefined &&
          requestedNumeric > orgMaxNumeric
        ) {
          attemptedVersionFallback = true;
          const { warning, changed } = recordApiVersionFallback(auth, requestedVersion, orgMaxVersion);
          if (changed) {
            logWarn(warning);
          }
          activeRequest = {
            ...activeRequest,
            url: replaceApiVersionInUrl(String(activeRequest.url || ''), orgMaxVersion)
          };
          try {
            logTrace('HTTP version fallback', requestedVersion, '->', orgMaxVersion);
          } catch {}
          continue;
        }
      }
      throw error;
    }
  }
}

export function setApiVersion(v?: string): void {
  setConfiguredApiVersion(v);
}

export function getApiVersion(): string {
  return getConfiguredApiVersion();
}

export function getEffectiveApiVersion(auth?: OrgAuth): string {
  return getEffectiveApiVersionFromState(auth);
}

export function getApiVersionFallbackWarning(auth?: OrgAuth): string | undefined {
  return getApiVersionFallbackWarningFromState(auth);
}

export function __resetApiVersionFallbackStateForTests(): void {
  resetApiVersionFallbackStateForTests();
}

export async function httpsRequestWith401Retry(
  auth: OrgAuth,
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<string> {
  return requestTextWithVersionFallback(
    auth,
    {
      method: method as HttpRequest['method'],
      url: urlString,
      headers,
      body
    },
    timeoutMs,
    signal
  );
}

export function clearListCache(): void {
  // Log list caching removed; function kept for backwards compatibility.
}

export type ApexLogCursor = {
  beforeStartTime: string;
  beforeId: string;
};

export async function fetchApexLogs(
  auth: OrgAuth,
  limit: number = 50,
  offset: number = 0,
  _debugLevel?: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  cursor?: ApexLogCursor
): Promise<ApexLogRow[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const baseSelect =
    'SELECT Id, StartTime, Operation, Application, DurationMilliseconds, Status, Request, LogLength, LogUser.Name FROM ApexLog';
  let query: string;
  if (cursor && cursor.beforeStartTime && cursor.beforeId) {
    const dt = cursor.beforeStartTime;
    const id = cursor.beforeId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    query = `${baseSelect} WHERE StartTime < ${dt} OR (StartTime = ${dt} AND Id < '${id}') ORDER BY StartTime DESC, Id DESC LIMIT ${safeLimit}`;
  } else {
    query = `${baseSelect} ORDER BY StartTime DESC, Id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`;
  }

  const soql = encodeURIComponent(query);
  const url = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(
    auth,
    'GET',
    url,
    {
      'Content-Type': 'application/json'
    },
    undefined,
    timeoutMs,
    signal
  );
  const json = JSON.parse(body);
  return (json.records || []) as ApexLogRow[];
}

export async function fetchApexLogBody(
  auth: OrgAuth,
  logId: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<string> {
  const url = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/sobjects/ApexLog/${logId}/Body`;
  return httpsRequestWith401Retry(
    auth,
    'GET',
    url,
    {
      'Content-Type': 'text/plain'
    },
    undefined,
    timeoutMs,
    signal
  );
}

export function extractCodeUnitStartedFromLines(lines: string[]): string | undefined {
  const re = /\|CODE_UNIT_STARTED\|\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m && m[1]) {
      const captured = m[1];
      const parts = captured
        .split('|')
        .map(s => s.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return parts[parts.length - 1];
      }
      return captured.trim();
    }
  }
  return undefined;
}

export { __resetHttpsRequestImplForTests, __setHttpsRequestImplForTests };
