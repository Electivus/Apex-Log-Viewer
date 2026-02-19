import * as https from 'https';
import { URL } from 'url';
import { gunzip, inflate } from 'zlib';
import { logTrace, logWarn } from '../utils/logger';
import { getOrgAuth } from './cli';
import type { ApexLogRow, OrgAuth } from './types';

const agent = new https.Agent({ keepAlive: true });

type HttpsRequestFn = typeof https.request;
let httpsRequestImpl: HttpsRequestFn = https.request;

export function __setHttpsRequestImplForTests(fn: HttpsRequestFn): void {
  httpsRequestImpl = fn;
}

export function __resetHttpsRequestImplForTests(): void {
  httpsRequestImpl = https.request;
}

function chooseEncoding(value: string | string[] | undefined): string {
  if (!value) {
    return '';
  }
  const raw = Array.isArray(value) ? value.find(Boolean) ?? '' : value;
  return raw
    .split(',')[0]
    ?.trim()
    .toLowerCase() ?? '';
}

function decompressBody(buffer: Buffer, encodingHeader: string | string[] | undefined): Promise<Buffer> {
  const encoding = chooseEncoding(encodingHeader);
  if (!encoding || encoding === 'identity') {
    return Promise.resolve(buffer);
  }
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return new Promise((resolve, reject) => {
      gunzip(buffer, (err, decoded) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(decoded);
      });
    });
  }
  if (encoding === 'deflate' || encoding === 'x-deflate') {
    return new Promise((resolve, reject) => {
      inflate(buffer, (err, decoded) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(decoded);
      });
    });
  }
  return Promise.resolve(buffer);
}

function httpsRequest(
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlString);
    const req = httpsRequestImpl(
      {
        method,
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        protocol: urlObj.protocol,
        headers,
        agent
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          decompressBody(raw, res.headers?.['content-encoding'])
            .then(decoded => decoded.toString('utf8'))
            .then(data => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data }))
            .catch(reject);
        });
      }
    );
    req.on('error', reject);
    if (signal) {
      const onAbort = () => {
        try {
          req.destroy();
        } catch {}
        reject(new Error('aborted'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
      });
    }
    if (typeof timeoutMs === 'number') {
      req.setTimeout(timeoutMs, () => {
        try {
          req.destroy();
        } catch {}
        reject(new Error('Request timed out'));
      });
    }
    if (body && method !== 'GET' && method !== 'HEAD') {
      try {
        req.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
      } catch {}
      req.write(body, 'utf8');
    }
    req.end();
  });
}

async function refreshAuthInPlace(auth: OrgAuth): Promise<void> {
  try {
    const next = await getOrgAuth(auth.username, true);
    auth.accessToken = next.accessToken;
    auth.instanceUrl = next.instanceUrl;
    auth.username = next.username;
  } catch (err) {
    try {
      logWarn('Auth refresh failed', err);
    } catch {}
    // surface original 401 if refresh fails
  }
}

type HttpResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

type ApiVersionMismatchResolution = {
  retryUrl: string;
};

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

function parseApiVersion(value: string | undefined): number | undefined {
  const s = String(value || '').trim();
  if (!/^\d+\.\d+$/.test(s)) {
    return undefined;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function isVersionNotFound404(statusCode: number, body: string): boolean {
  if (statusCode !== 404) {
    return false;
  }
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object' && String((item as any).errorCode || '').toUpperCase() === 'NOT_FOUND') {
          return true;
        }
      }
    }
  } catch {
    // no-op
  }
  return /not[_\s-]?found|requested resource does not exist/i.test(body);
}

function extractApiVersionFromUrl(urlString: string): string | undefined {
  try {
    const url = new URL(urlString);
    const m = url.pathname.match(/\/services\/data\/v(\d+\.\d+)(?:\/|$)/i);
    return m?.[1];
  } catch {
    return undefined;
  }
}

function replaceApiVersionInUrl(urlString: string, version: string): string {
  const url = new URL(urlString);
  url.pathname = url.pathname.replace(/\/services\/data\/v\d+\.\d+(?=\/|$)/i, `/services/data/v${version}`);
  return url.toString();
}

async function sendHttpWith401Retry(
  auth: OrgAuth,
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<HttpResponse> {
  try {
    logTrace('HTTP', method, urlString);
  } catch {}
  const first = await httpsRequest(method, urlString, headers, body, timeoutMs, signal);
  try {
    logTrace('HTTP <-', first.statusCode, urlString);
  } catch {}
  if (first.statusCode === 401) {
    try {
      logTrace('HTTP 401 -> refreshing auth and retrying');
    } catch {}
    await refreshAuthInPlace(auth);
    const second = await httpsRequest(
      method,
      urlString,
      { ...headers, Authorization: `Bearer ${auth.accessToken}` },
      body,
      timeoutMs,
      signal
    );
    try {
      logTrace('HTTP(retry) <-', second.statusCode, urlString);
    } catch {}
    return second;
  }
  return first;
}

async function discoverOrgMaxApiVersion(auth: OrgAuth, timeoutMs?: number, signal?: AbortSignal): Promise<string | undefined> {
  const base = stripTrailingSlash(String(auth.instanceUrl || '').trim());
  if (!base) {
    return undefined;
  }
  const url = `${base}/services/data`;
  const body = await httpsRequestWith401Retry(
    auth,
    'GET',
    url,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    undefined,
    timeoutMs,
    signal
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

export async function httpsRequestWith401Retry(
  auth: OrgAuth,
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<string> {
  const attemptResolveMismatch = async (response: HttpResponse, requestUrl: string): Promise<ApiVersionMismatchResolution | undefined> => {
    if (!isVersionNotFound404(response.statusCode, response.body)) {
      return undefined;
    }
    const requestedVersion = extractApiVersionFromUrl(requestUrl);
    const requestedNumeric = parseApiVersion(requestedVersion);
    if (!requestedVersion || requestedNumeric === undefined) {
      return undefined;
    }
    const orgMaxVersion = await discoverOrgMaxApiVersion(auth, timeoutMs, signal).catch(() => undefined);
    const orgMaxNumeric = parseApiVersion(orgMaxVersion);
    if (!orgMaxVersion || orgMaxNumeric === undefined || requestedNumeric <= orgMaxNumeric) {
      return undefined;
    }
    const orgKey = normalizeOrgKey(auth);
    orgApiVersionOverrideByOrg.set(orgKey, orgMaxVersion);
    const warning = `sourceApiVersion ${API_VERSION} > org max ${orgMaxVersion}; falling back to ${orgMaxVersion}`;
    const prevWarning = orgApiVersionWarningByOrg.get(orgKey);
    orgApiVersionWarningByOrg.set(orgKey, warning);
    if (prevWarning !== warning) {
      logWarn(warning);
    }
    const retryUrl = replaceApiVersionInUrl(requestUrl, orgMaxVersion);
    try {
      logTrace('HTTP version fallback', requestedVersion, '->', orgMaxVersion);
    } catch {}
    return { retryUrl };
  };

  let attemptedVersionFallback = false;
  let activeUrl = urlString;
  let response = await sendHttpWith401Retry(auth, method, activeUrl, headers, body, timeoutMs, signal);
  while (true) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.body;
    }
    if (!attemptedVersionFallback) {
      const resolved = await attemptResolveMismatch(response, activeUrl).catch(() => undefined);
      if (resolved) {
        attemptedVersionFallback = true;
        activeUrl = resolved.retryUrl;
        response = await sendHttpWith401Retry(auth, method, activeUrl, headers, body, timeoutMs, signal);
        continue;
      }
    }
    throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
  }
}

let API_VERSION = '64.0';
const orgApiVersionOverrideByOrg = new Map<string, string>();
const orgApiVersionWarningByOrg = new Map<string, string>();

function clearApiVersionFallbackState(): void {
  orgApiVersionOverrideByOrg.clear();
  orgApiVersionWarningByOrg.clear();
}

export function setApiVersion(v?: string): void {
  const s = (v || '').trim();
  if (/^\d+\.\d+$/.test(s)) {
    const changed = API_VERSION !== s;
    API_VERSION = s;
    if (changed) {
      clearApiVersionFallbackState();
    }
  }
}

export function getApiVersion(): string {
  return API_VERSION;
}

export function getEffectiveApiVersion(auth?: OrgAuth): string {
  if (!auth) {
    return API_VERSION;
  }
  const orgKey = normalizeOrgKey(auth);
  return orgApiVersionOverrideByOrg.get(orgKey) || API_VERSION;
}

export function getApiVersionFallbackWarning(auth?: OrgAuth): string | undefined {
  if (!auth) {
    return undefined;
  }
  return orgApiVersionWarningByOrg.get(normalizeOrgKey(auth));
}

export function __resetApiVersionFallbackStateForTests(): void {
  clearApiVersionFallbackState();
}

// Store the largest prefix of lines fetched per log; smaller requests return a slice
const headCacheByLog = new Map<string, string[]>();
const HEAD_CACHE_LIMIT = 200;
const HEAD_MAX_LINES = 100;

function makeLogKey(auth: OrgAuth, logId: string): string {
  // Include username to avoid cache collisions between orgs on the same instanceUrl
  return `${auth.instanceUrl}|${auth.username ?? ''}|${logId}`;
}

export function clearListCache(): void {
  // Log list caching removed; function kept for backwards compatibility.
}

export type ApexLogCursor = {
  // Fetch logs strictly older than this (StartTime DESC, Id DESC)
  beforeStartTime: string;
  beforeId: string;
};

export async function fetchApexLogs(
  auth: OrgAuth,
  limit: number = 50,
  offset: number = 0,
  debugLevel?: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  cursor?: ApexLogCursor
): Promise<ApexLogRow[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  // Build query using keyset pagination when a cursor is provided. This avoids the 2000 OFFSET limit in SOQL.
  const baseSelect =
    'SELECT Id, StartTime, Operation, Application, DurationMilliseconds, Status, Request, LogLength, LogUser.Name FROM ApexLog';
  let query: string;
  if (cursor && cursor.beforeStartTime && cursor.beforeId) {
    // Use deterministic ordering to ensure stable pagination
    // SOQL datetime literals are unquoted; Id is quoted.
    const dt = cursor.beforeStartTime;
    // Escape backslashes first, then single quotes inside the SOQL string literal
    const id = cursor.beforeId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    query = `${baseSelect} WHERE StartTime < ${dt} OR (StartTime = ${dt} AND Id < '${id}') ORDER BY StartTime DESC, Id DESC LIMIT ${safeLimit}`;
  } else {
    // Default to OFFSET-based paging for the first page(s)
    query = `${baseSelect} ORDER BY StartTime DESC, Id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`;
  }
  const soql = encodeURIComponent(query);
  const url = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(
    auth,
    'GET',
    url,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    undefined,
    timeoutMs,
    signal
  );
  const json = JSON.parse(body);
  const records = (json.records || []) as ApexLogRow[];
  // Do not filter by debug level here. ApexLog does not reliably carry
  // DebugLevel information, and filtering by Application was dropping
  // valid results causing 0 logs to appear even with a 200 response.
  // If needed, filtering should be applied client-side based on content.
  return records;
}

export async function fetchApexLogBody(
  auth: OrgAuth,
  logId: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<string> {
  const url = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/sobjects/ApexLog/${logId}/Body`;
  const text = await httpsRequestWith401Retry(
    auth,
    'GET',
    url,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'text/plain',
      'Accept-Encoding': 'gzip'
    },
    undefined,
    timeoutMs,
    signal
  );
  return text;
}

type RangeResponse = { statusCode: number; headers: Record<string, string | string[] | undefined>; body: string };

async function fetchApexLogBytesRange(
  auth: OrgAuth,
  logId: string,
  start: number,
  endInclusive: number,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<RangeResponse> {
  const urlString = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/sobjects/ApexLog/${logId}/Body`;
  const first = await httpsRequest(
    'GET',
    urlString,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'text/plain',
      'Accept-Encoding': 'identity',
      Range: `bytes=${start}-${endInclusive}`
    },
    undefined,
    timeoutMs,
    signal
  );
  if (first.statusCode === 401) {
    await refreshAuthInPlace(auth);
    const second = await httpsRequest(
      'GET',
      urlString,
      {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'text/plain',
        'Accept-Encoding': 'identity',
        Range: `bytes=${start}-${endInclusive}`
      },
      undefined,
      timeoutMs,
      signal
    );
    return { statusCode: second.statusCode, headers: second.headers, body: second.body };
  }
  return { statusCode: first.statusCode, headers: first.headers, body: first.body };
}

export async function fetchApexLogHead(
  auth: OrgAuth,
  logId: string,
  maxLines: number,
  logLengthBytes?: number,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<string[]> {
  const key = makeLogKey(auth, logId);
  const cached = headCacheByLog.get(key);
  if (cached && cached.length >= maxLines) {
    return cached.slice(0, Math.max(0, maxLines));
  }

  // 1) Attempt Range with Accept-Encoding: identity
  try {
    const stride = typeof logLengthBytes === 'number' ? (logLengthBytes <= 4096 ? logLengthBytes : 8192) : 8192;
    try {
      logTrace('HTTP Range GET ApexLog head', logId, 'bytes=0-', Math.max(0, stride - 1));
    } catch {}
    const range = await fetchApexLogBytesRange(auth, logId, 0, Math.max(0, stride - 1), timeoutMs, signal);
    const contentEncoding = (range.headers['content-encoding'] || '').toString().toLowerCase();
    if (range.statusCode === 206 && (!contentEncoding || contentEncoding === 'identity')) {
      try {
        logTrace('HTTP Range <- 206 identity for', logId);
      } catch {}
      const lines = range.body.split(/\r?\n/);
      const toStore = cached ? (lines.length > cached.length ? lines : cached) : lines;
      headCacheByLog.set(key, toStore.slice(0, HEAD_MAX_LINES));
      if (headCacheByLog.size > HEAD_CACHE_LIMIT) {
        const firstKey = headCacheByLog.keys().next().value as string | undefined;
        if (firstKey) {
          headCacheByLog.delete(firstKey);
        }
      }
      return lines.slice(0, Math.max(0, maxLines));
    }
    // If 200 or an unexpected encoding, fall back
  } catch (_e) {
    // ignore and attempt fallback
  }

  // 2) Fallback: stream and stop early when reaching maxLines
  return new Promise((resolve, reject) => {
    const urlString = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/sobjects/ApexLog/${logId}/Body`;
    const urlObj = new URL(urlString);
    try {
      logTrace('HTTP stream GET ApexLog head', logId, '-> until', maxLines, 'lines');
    } catch {}
    let buffer = '';
    let collected: string[] = [];
    const attempt = (token: string) => {
      const req = httpsRequestImpl(
        {
          method: 'GET',
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          protocol: urlObj.protocol,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
          agent
        },
        res => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            if (res.statusCode === 401) {
              // retry once with refreshed auth
              res.resume();
              refreshAuthInPlace(auth)
                .then(() => {
                  try {
                    logTrace('HTTP stream 401; retrying for', logId);
                  } catch {}
                  const req2 = attempt(auth.accessToken);
                  req2.on('error', reject);
                  req2.end();
                })
                .catch(() => reject(new Error(`HTTP ${res.statusCode}`)));
              return;
            }
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          res.setEncoding('utf8');
          res.on('data', chunk => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf('\n')) !== -1 && collected.length < maxLines) {
              const line = buffer.slice(0, idx).replace(/\r$/, '');
              buffer = buffer.slice(idx + 1);
              collected.push(line);
              if (collected.length >= maxLines) {
                try {
                  req.destroy();
                } catch {}
                try {
                  logTrace('HTTP stream: collected max lines for', logId, '->', collected.length);
                } catch {}
                // Update cache with the largest collected prefix
                const toStore = cached ? (collected.length > cached.length ? collected : cached) : collected;
                headCacheByLog.set(key, toStore.slice(0, HEAD_MAX_LINES));
                if (headCacheByLog.size > HEAD_CACHE_LIMIT) {
                  const firstKey = headCacheByLog.keys().next().value as string | undefined;
                  if (firstKey) {
                    headCacheByLog.delete(firstKey);
                  }
                }
                resolve(collected);
                return;
              }
            }
          });
          res.on('end', () => {
            if (buffer.length && collected.length < maxLines) {
              collected.push(buffer.replace(/\r$/, ''));
            }
            try {
              logTrace('HTTP stream end for', logId, 'collected', collected.length);
            } catch {}
            const sliced = collected.slice(0, maxLines);
            const toStore = cached ? (sliced.length > cached.length ? sliced : cached) : sliced;
            headCacheByLog.set(key, toStore.slice(0, HEAD_MAX_LINES));
            if (headCacheByLog.size > HEAD_CACHE_LIMIT) {
              const firstKey = headCacheByLog.keys().next().value as string | undefined;
              if (firstKey) {
                headCacheByLog.delete(firstKey);
              }
            }
            resolve(sliced);
          });
        }
      );
      if (signal) {
        const onAbort = () => {
          try {
            req.destroy();
          } catch {}
          reject(new Error('aborted'));
        };
        if (signal.aborted) {
          onAbort();
          return req;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {}
        });
      }
      if (typeof timeoutMs === 'number') {
        req.setTimeout(timeoutMs, () => {
          try {
            req.destroy();
          } catch {}
          reject(new Error('Request timed out'));
        });
      }
      return req;
    };
    const req = attempt(auth.accessToken);
    req.on('error', reject);
    req.end();
  });
}

export function extractCodeUnitStartedFromLines(lines: string[]): string | undefined {
  const re = /\|CODE_UNIT_STARTED\|\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m && m[1]) {
      const captured = m[1];
      // Return only the content after the last pipe
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
