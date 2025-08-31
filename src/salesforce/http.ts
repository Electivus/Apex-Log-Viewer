import * as https from 'https';
import { URL } from 'url';
import { logTrace } from '../utils/logger';
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

function httpsRequest(
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs?: number
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
          const data = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data });
        });
      }
    );
    req.on('error', reject);
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
    const next = await getOrgAuth(auth.username);
    auth.accessToken = next.accessToken;
    auth.instanceUrl = next.instanceUrl;
    auth.username = next.username;
  } catch {
    // surface original 401 if refresh fails
  }
}

export async function httpsRequestWith401Retry(
  auth: OrgAuth,
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs?: number
): Promise<string> {
  try {
    logTrace('HTTP', method, urlString);
  } catch {}
  const first = await httpsRequest(method, urlString, headers, body, timeoutMs);
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
      timeoutMs
    );
    try {
      logTrace('HTTP(retry) <-', second.statusCode, urlString);
    } catch {}
    if (second.statusCode >= 200 && second.statusCode < 300) {
      return second.body;
    }
    throw new Error(`HTTP ${second.statusCode}: ${second.body}`);
  }
  if (first.statusCode >= 200 && first.statusCode < 300) {
    return first.body;
  }
  throw new Error(`HTTP ${first.statusCode}: ${first.body}`);
}

let API_VERSION = '64.0';

export function setApiVersion(v?: string): void {
  const s = (v || '').trim();
  if (/^\d+\.\d+$/.test(s)) {
    API_VERSION = s;
  }
}

export function getApiVersion(): string {
  return API_VERSION;
}

// In-memory cache
// - Log list: short TTL (avoid immediate refetch)
// - Each log's head: no TTL (logs are immutable after creation)
type ListCacheEntry = { expiresAt: number; data: ApexLogRow[] };
const listCache = new Map<string, ListCacheEntry>();
// Store the largest prefix of lines fetched per log; smaller requests return a slice
const headCacheByLog = new Map<string, string[]>();
const HEAD_CACHE_LIMIT = 200;
const HEAD_MAX_LINES = 100;

function makeListKey(auth: OrgAuth, limit: number, offset: number): string {
  return `${auth.instanceUrl}|${auth.username ?? ''}|${limit}|${offset}`;
}

function makeLogKey(auth: OrgAuth, logId: string): string {
  // Include username to avoid cache collisions between orgs on the same instanceUrl
  return `${auth.instanceUrl}|${auth.username ?? ''}|${logId}`;
}

export function clearListCache(): void {
  listCache.clear();
}

export async function fetchApexLogs(
  auth: OrgAuth,
  limit: number = 50,
  offset: number = 0,
  debugLevel?: string,
  timeoutMs?: number
): Promise<ApexLogRow[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  // Attempt cache with short TTL when no debug level filter
  const cacheKey = debugLevel ? undefined : makeListKey(auth, safeLimit, safeOffset);
  const now = Date.now();
  if (cacheKey) {
    const cached = listCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
  }
  const soql = encodeURIComponent(
    `SELECT Id, StartTime, Operation, Application, DurationMilliseconds, Status, Request, LogLength, LogUser.Name FROM ApexLog ORDER BY StartTime DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`
  );
  const url = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(
    auth,
    'GET',
    url,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    undefined,
    timeoutMs
  );
  const json = JSON.parse(body);
  const records = (json.records || []) as ApexLogRow[];
  // Do not filter by debug level here. ApexLog does not reliably carry
  // DebugLevel information, and filtering by Application was dropping
  // valid results causing 0 logs to appear even with a 200 response.
  // If needed, filtering should be applied client-side based on content.
  // Set a 3-second TTL for the specific page
  if (cacheKey) {
    listCache.set(cacheKey, { data: records, expiresAt: now + 3000 });
  }
  return records;
}

export async function fetchApexLogBody(auth: OrgAuth, logId: string, timeoutMs?: number): Promise<string> {
  const url = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/sobjects/ApexLog/${logId}/Body`;
  const text = await httpsRequestWith401Retry(
    auth,
    'GET',
    url,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'text/plain'
    },
    undefined,
    timeoutMs
  );
  return text;
}

type RangeResponse = { statusCode: number; headers: Record<string, string | string[] | undefined>; body: string };

async function fetchApexLogBytesRange(
  auth: OrgAuth,
  logId: string,
  start: number,
  endInclusive: number,
  timeoutMs?: number
): Promise<RangeResponse> {
  const urlString = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/sobjects/ApexLog/${logId}/Body`;
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
    timeoutMs
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
      timeoutMs
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
  timeoutMs?: number
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
    const range = await fetchApexLogBytesRange(auth, logId, 0, Math.max(0, stride - 1), timeoutMs);
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
    const urlString = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/sobjects/ApexLog/${logId}/Body`;
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
