import { Connection, type HttpRequest, type SaveResult } from '@jsforce/jsforce-node';
import * as https from 'https';
import { gunzip, inflate } from 'zlib';
import { URL } from 'url';
import { getOrgAuth } from './cli';
import { parseApiVersion, recordApiVersionFallback } from './apiVersion';
import type { OrgAuth } from './types';
import { logWarn } from '../utils/logger';

type HttpsRequestFn = typeof https.request;

type LegacyHttpResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type QueryResponse<TRecord = any> = {
  records?: TRecord[];
  done?: boolean;
  nextRecordsUrl?: string;
};

export type JsforceConnectionLike = Pick<Connection, 'request' | 'query' | 'queryMore'> & {
  version: string;
  instanceUrl: string;
  accessToken?: string;
  tooling: Pick<Connection['tooling'], 'query' | 'create' | 'update' | 'destroy'>;
  streaming: Connection['streaming'];
};

type ConnectionFactory = (
  auth: OrgAuth,
  apiVersion: string
) => Promise<JsforceConnectionLike> | JsforceConnectionLike;

let httpsRequestImplForTests: HttpsRequestFn | undefined;
let connectionFactoryForTests: ConnectionFactory | undefined;

export function __setHttpsRequestImplForTests(fn: HttpsRequestFn): void {
  httpsRequestImplForTests = fn;
}

export function __resetHttpsRequestImplForTests(): void {
  httpsRequestImplForTests = undefined;
}

export function __setConnectionFactoryForTests(fn: ConnectionFactory | undefined): void {
  connectionFactoryForTests = fn;
}

export function __resetConnectionFactoryForTests(): void {
  connectionFactoryForTests = undefined;
}

export function hasLegacyHttpsRequestOverrideForTests(): boolean {
  return Boolean(httpsRequestImplForTests);
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

function toAbsoluteUrl(auth: OrgAuth, maybeRelative: string): string {
  const value = String(maybeRelative || '').trim();
  if (!value) {
    return '';
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const base = String(auth.instanceUrl || '').replace(/\/+$/, '');
  if (!base) {
    return value;
  }
  return value.startsWith('/') ? `${base}${value}` : `${base}/${value}`;
}

function extractApiVersionFromUrl(urlString: string | undefined): string | undefined {
  const raw = String(urlString || '').trim();
  if (!raw) {
    return undefined;
  }
  const match = raw.match(/\/services\/data\/v(\d+\.\d+)(?:\/|$)/i);
  return match?.[1];
}

function normalizeSaveResult(result: unknown, idFallback?: string): SaveResult {
  const normalized = Array.isArray(result) ? result[0] : result;
  if (normalized && typeof normalized === 'object' && (normalized as any).success === false) {
    return normalized as SaveResult;
  }
  const id =
    typeof (normalized as any)?.id === 'string'
      ? String((normalized as any).id)
      : typeof idFallback === 'string'
        ? idFallback
        : '';
  return {
    success: true,
    ...(id ? { id } : {}),
    errors: []
  } as SaveResult;
}

function errorText(error: unknown): string {
  return String((error as { message?: string } | undefined)?.message || error || '');
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

export async function createConnectionFromAuth(
  auth: OrgAuth,
  apiVersion: string
): Promise<JsforceConnectionLike> {
  if (connectionFactoryForTests) {
    return await connectionFactoryForTests(auth, apiVersion);
  }

  const connection = new Connection({
    version: apiVersion,
    instanceUrl: auth.instanceUrl,
    accessToken: auth.accessToken,
    refreshFn: async (conn, callback) => {
      try {
        const next = await getOrgAuth(auth.username, true);
        auth.accessToken = next.accessToken;
        auth.instanceUrl = next.instanceUrl;
        auth.username = next.username;
        conn.instanceUrl = next.instanceUrl;
        callback(null, next.accessToken, {
          access_token: next.accessToken,
          instance_url: next.instanceUrl
        } as any);
      } catch (error) {
        callback(error as Error);
      }
    }
  });

  return connection as JsforceConnectionLike;
}

async function discoverOrgMaxApiVersion(auth: OrgAuth, timeoutMs?: number, signal?: AbortSignal): Promise<string | undefined> {
  const base = String(auth.instanceUrl || '').replace(/\/+$/, '');
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

async function withQueryVersionFallback<T>(
  auth: OrgAuth,
  apiVersion: string,
  execute: (version: string) => Promise<T>
): Promise<T> {
  let activeVersion = apiVersion;
  let attemptedVersionFallback = false;
  for (;;) {
    try {
      return await execute(activeVersion);
    } catch (error) {
      if (!attemptedVersionFallback && isVersionNotFound404(error)) {
        const requestedNumeric = parseApiVersion(activeVersion);
        const orgMaxVersion = await discoverOrgMaxApiVersion(auth).catch(() => undefined);
        const orgMaxNumeric = parseApiVersion(orgMaxVersion);
        if (
          requestedNumeric !== undefined &&
          orgMaxVersion &&
          orgMaxNumeric !== undefined &&
          requestedNumeric > orgMaxNumeric
        ) {
          attemptedVersionFallback = true;
          const { warning, changed } = recordApiVersionFallback(auth, activeVersion, orgMaxVersion);
          if (changed) {
            logWarn(warning);
          }
          activeVersion = orgMaxVersion;
          continue;
        }
      }
      throw error;
    }
  }
}

async function legacyRequest(
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<LegacyHttpResponse> {
  const requestImpl = httpsRequestImplForTests;
  if (!requestImpl) {
    throw new Error('No legacy HTTPS override is configured.');
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlString);
    const req = requestImpl(
      {
        method,
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        protocol: urlObj.protocol,
        headers
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          decompressBody(raw, res.headers?.['content-encoding'])
            .then(decoded => decoded.toString('utf8'))
            .then(data =>
              resolve({
                statusCode: res.statusCode || 0,
                headers: res.headers,
                body: data
              })
            )
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

type LegacyRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

async function requestLegacyJson<T>(
  auth: OrgAuth,
  request: HttpRequest,
  options: LegacyRequestOptions = {}
): Promise<T> {
  const urlString = toAbsoluteUrl(auth, request.url);
  const body =
    typeof request.body === 'string'
      ? request.body
      : Buffer.isBuffer(request.body)
        ? request.body.toString('utf8')
        : undefined;
  const response = await legacyRequest(
    request.method,
    urlString,
    request.headers || {},
    body,
    options.timeoutMs,
    options.signal
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
  }
  if (!response.body) {
    return {} as T;
  }
  return JSON.parse(response.body) as T;
}

export async function requestText(
  auth: OrgAuth,
  request: HttpRequest,
  options: LegacyRequestOptions = {}
): Promise<string> {
  if (hasLegacyHttpsRequestOverrideForTests()) {
    const urlString = toAbsoluteUrl(auth, request.url);
    const body =
      typeof request.body === 'string'
        ? request.body
        : Buffer.isBuffer(request.body)
          ? request.body.toString('utf8')
          : undefined;
    const response = await legacyRequest(
      request.method,
      urlString,
      request.headers || {},
      body,
      options.timeoutMs,
      options.signal
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
    }
    return response.body;
  }

  const version = extractApiVersionFromUrl(request.url);
  const connection = await createConnectionFromAuth(auth, version || '64.0');
  const response = await connection.request<string>(request, {
    responseType: 'text/plain',
    encoding: 'utf8',
    timeout: options.timeoutMs
  });
  return typeof response === 'string' ? response : response === undefined ? '' : String(response);
}

export async function requestJson<T>(
  auth: OrgAuth,
  request: HttpRequest,
  options: LegacyRequestOptions = {}
): Promise<T> {
  if (hasLegacyHttpsRequestOverrideForTests()) {
    return requestLegacyJson<T>(auth, request, options);
  }

  const version = extractApiVersionFromUrl(request.url);
  const connection = await createConnectionFromAuth(auth, version || '64.0');
  return connection.request<T>(request, { timeout: options.timeoutMs }) as Promise<T>;
}

export async function queryStandard<TRecord extends Record<string, unknown>>(
  auth: OrgAuth,
  soql: string,
  apiVersion: string
): Promise<QueryResponse<TRecord>> {
  return withQueryVersionFallback(auth, apiVersion, async activeVersion => {
    if (hasLegacyHttpsRequestOverrideForTests()) {
      const encoded = encodeURIComponent(soql);
      return requestLegacyJson<QueryResponse<TRecord>>(auth, {
        method: 'GET',
        url: `${auth.instanceUrl}/services/data/v${activeVersion}/query?q=${encoded}`,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const connection = await createConnectionFromAuth(auth, activeVersion);
    const result = await connection.query<TRecord>(soql);
    return {
      records: Array.isArray((result as any)?.records) ? ((result as any).records as TRecord[]) : [],
      done: (result as any)?.done,
      nextRecordsUrl: typeof (result as any)?.nextRecordsUrl === 'string' ? (result as any).nextRecordsUrl : undefined
    };
  });
}

export async function queryTooling<TRecord extends Record<string, unknown>>(
  auth: OrgAuth,
  soql: string,
  apiVersion: string
): Promise<QueryResponse<TRecord>> {
  return withQueryVersionFallback(auth, apiVersion, async activeVersion => {
    if (hasLegacyHttpsRequestOverrideForTests()) {
      const encoded = encodeURIComponent(soql);
      return requestLegacyJson<QueryResponse<TRecord>>(auth, {
        method: 'GET',
        url: `${auth.instanceUrl}/services/data/v${activeVersion}/tooling/query?q=${encoded}`,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const connection = await createConnectionFromAuth(auth, activeVersion);
    const result = await connection.tooling.query<TRecord>(soql);
    return {
      records: Array.isArray((result as any)?.records) ? ((result as any).records as TRecord[]) : [],
      done: (result as any)?.done,
      nextRecordsUrl: typeof (result as any)?.nextRecordsUrl === 'string' ? (result as any).nextRecordsUrl : undefined
    };
  });
}

export async function queryToolingMore<TRecord>(
  auth: OrgAuth,
  nextRecordsUrl: string,
  apiVersion: string
): Promise<QueryResponse<TRecord>> {
  const url = toAbsoluteUrl(auth, nextRecordsUrl);
  if (hasLegacyHttpsRequestOverrideForTests()) {
    return requestLegacyJson<QueryResponse<TRecord>>(auth, {
      method: 'GET',
      url,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const connection = await createConnectionFromAuth(auth, extractApiVersionFromUrl(url) || apiVersion);
  return connection.request<QueryResponse<TRecord>>(url) as Promise<QueryResponse<TRecord>>;
}

export async function createToolingRecord(
  auth: OrgAuth,
  apiVersion: string,
  type: string,
  record: Record<string, unknown>
): Promise<SaveResult> {
  if (hasLegacyHttpsRequestOverrideForTests()) {
    const result = await requestLegacyJson<any>(auth, {
      method: 'POST',
      url: `${auth.instanceUrl}/services/data/v${apiVersion}/tooling/sobjects/${type}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    });
    return normalizeSaveResult(result);
  }

  const connection = await createConnectionFromAuth(auth, apiVersion);
  const result = await connection.tooling.create(type as any, record as any);
  return normalizeSaveResult(result);
}

export async function updateToolingRecord(
  auth: OrgAuth,
  apiVersion: string,
  type: string,
  id: string,
  record: Record<string, unknown>
): Promise<SaveResult> {
  if (hasLegacyHttpsRequestOverrideForTests()) {
    const result = await requestLegacyJson<any>(auth, {
      method: 'PATCH',
      url: `${auth.instanceUrl}/services/data/v${apiVersion}/tooling/sobjects/${type}/${id}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    });
    return normalizeSaveResult(result, id);
  }

  const connection = await createConnectionFromAuth(auth, apiVersion);
  const result = await connection.tooling.update(type as any, { Id: id, ...(record as any) });
  return normalizeSaveResult(result, id);
}

export async function deleteToolingRecord(
  auth: OrgAuth,
  apiVersion: string,
  type: string,
  id: string
): Promise<SaveResult> {
  if (hasLegacyHttpsRequestOverrideForTests()) {
    const response = await legacyRequest(
      'DELETE',
      `${auth.instanceUrl}/services/data/v${apiVersion}/tooling/sobjects/${type}/${id}`,
      { 'Content-Type': 'application/json' }
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
    }
    return normalizeSaveResult(undefined, id);
  }

  const connection = await createConnectionFromAuth(auth, apiVersion);
  const result = await connection.tooling.destroy(type as any, id);
  return normalizeSaveResult(result, id);
}
