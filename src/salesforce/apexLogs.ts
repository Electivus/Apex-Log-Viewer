import { getEffectiveApiVersion, httpsRequestWith401Retry } from './http';
import type { OrgAuth } from './types';

type QueryResponse<TRecord = any> = {
  records?: TRecord[];
  done?: boolean;
  nextRecordsUrl?: string;
};

function escapeSoqlLiteral(value: string): string {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function stripTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function toAbsoluteUrl(auth: OrgAuth, maybeRelative: string): string {
  const value = String(maybeRelative || '').trim();
  if (!value) {
    return '';
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const base = stripTrailingSlash(String(auth.instanceUrl || '').trim());
  if (!base) {
    return value;
  }
  return value.startsWith('/') ? `${base}${value}` : `${base}/${value}`;
}

function queryTooling<TRecord>(
  auth: OrgAuth,
  soql: string,
  signal?: AbortSignal
): Promise<QueryResponse<TRecord>> {
  const encoded = encodeURIComponent(soql);
  const url = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/tooling/query?q=${encoded}`;
  return httpsRequestWith401Retry(
    auth,
    'GET',
    url,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    undefined,
    undefined,
    signal
  ).then(body => JSON.parse(body) as QueryResponse<TRecord>);
}

function queryToolingMore<TRecord>(
  auth: OrgAuth,
  nextRecordsUrl: string,
  signal?: AbortSignal
): Promise<QueryResponse<TRecord>> {
  const url = toAbsoluteUrl(auth, nextRecordsUrl);
  if (!url) {
    return Promise.resolve({ done: true, records: [] } as QueryResponse<TRecord>);
  }
  return httpsRequestWith401Retry(
    auth,
    'GET',
    url,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    undefined,
    undefined,
    signal
  ).then(body => JSON.parse(body) as QueryResponse<TRecord>);
}

type ApexLogIdRecord = {
  Id?: string;
};

export type FetchAllApexLogIdsOptions = {
  limit?: number;
  userId?: string;
  signal?: AbortSignal;
};

export async function fetchAllApexLogIds(auth: OrgAuth, options: FetchAllApexLogIdsOptions = {}): Promise<string[]> {
  const signal = options.signal;
  const userId = typeof options.userId === 'string' ? options.userId.trim() : '';
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.max(1, Math.floor(options.limit))
      : undefined;

  const ids: string[] = [];
  const seen = new Set<string>();
  const seenNextUrls = new Set<string>();

  const baseSelect = 'SELECT Id FROM ApexLog';
  const clauses: string[] = [];
  if (userId) {
    clauses.push(`LogUserId = '${escapeSoqlLiteral(userId)}'`);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const limitClause = typeof limit === 'number' ? ` LIMIT ${limit}` : '';
  const soql = `${baseSelect}${where} ORDER BY StartTime DESC, Id DESC${limitClause}`;

  let json = await queryTooling<ApexLogIdRecord>(auth, soql, signal);
  while (!signal?.aborted) {
    const records = Array.isArray(json.records) ? json.records : [];
    for (const r of records) {
      const id = typeof r?.Id === 'string' ? r.Id : '';
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }

    if (json.done || !json.nextRecordsUrl) {
      break;
    }
    const next = String(json.nextRecordsUrl || '').trim();
    if (!next || seenNextUrls.has(next)) {
      break;
    }
    seenNextUrls.add(next);
    json = await queryToolingMore<ApexLogIdRecord>(auth, next, signal);
  }

  return ids;
}

export type DeleteApexLogsSummary = {
  total: number;
  deleted: number;
  failed: number;
  cancelled: number;
  failedLogIds: string[];
};

export async function deleteApexLogs(
  auth: OrgAuth,
  logIds: string[],
  options: {
    signal?: AbortSignal;
    concurrency?: number;
    onProgress?: (progress: {
      processed: number;
      total: number;
      deleted: number;
      failed: number;
      cancelled: number;
    }) => void;
  } = {}
): Promise<DeleteApexLogsSummary> {
  const signal = options.signal;
  const ids = Array.isArray(logIds) ? logIds.map(v => String(v || '').trim()).filter(Boolean) : [];
  const concurrency = Math.max(1, Math.min(5, Math.floor(Number(options.concurrency) || 2)));
  const chunkSize = 200;

  const summary: DeleteApexLogsSummary = {
    total: ids.length,
    deleted: 0,
    failed: 0,
    cancelled: 0,
    failedLogIds: []
  };
  let processed = 0;

  const report = () => {
    try {
      options.onProgress?.({
        processed,
        total: ids.length,
        deleted: summary.deleted,
        failed: summary.failed,
        cancelled: summary.cancelled
      });
    } catch {
      // ignore observer errors
    }
  };

  const isAbortLikeError = (err: unknown): boolean => {
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      return true;
    }
    const msg = String((err as Error | undefined)?.message || err || '').toLowerCase();
    return msg.includes('abort') || msg.includes('canceled') || msg.includes('cancelled');
  };

  const deleteChunk = async (chunk: string[]): Promise<void> => {
    if (signal?.aborted) {
      summary.cancelled += chunk.length;
      processed += chunk.length;
      report();
      return;
    }
    const idsString = chunk.join(',');
    const url = `${auth.instanceUrl}/services/data/v${getEffectiveApiVersion(auth)}/composite/sobjects?ids=${idsString}&allOrNone=false`;
    let body: string;
    try {
      body = await httpsRequestWith401Retry(
        auth,
        'DELETE',
        url,
        {
          Authorization: `Bearer ${auth.accessToken}`,
          'Content-Type': 'application/json'
        },
        undefined,
        undefined,
        signal
      );
    } catch (e) {
      if (signal?.aborted || isAbortLikeError(e)) {
        summary.cancelled += chunk.length;
      } else {
        summary.failed += chunk.length;
        summary.failedLogIds.push(...chunk);
      }
      processed += chunk.length;
      report();
      return;
    }

    let parsed: any;
    try {
      parsed = body ? JSON.parse(body) : [];
    } catch {
      summary.failed += chunk.length;
      summary.failedLogIds.push(...chunk);
      processed += chunk.length;
      report();
      return;
    }

    const results = Array.isArray(parsed) ? parsed : [];
    const byId = new Map<string, { success: boolean }>();
    for (const r of results) {
      const id = typeof r?.id === 'string' ? r.id : '';
      if (!id) {
        continue;
      }
      byId.set(id, { success: Boolean(r?.success) });
    }

    for (const id of chunk) {
      const entry = byId.get(id);
      if (entry?.success) {
        summary.deleted++;
      } else {
        summary.failed++;
        summary.failedLogIds.push(id);
      }
      processed++;
    }
    report();
  };

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }

  const inFlight = new Set<Promise<void>>();
  const enqueue = (task: Promise<void>) => {
    inFlight.add(task);
    task.finally(() => inFlight.delete(task)).catch(() => {});
  };

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) {
      // Mark remaining, not-yet-enqueued chunks as cancelled
      const remaining = chunks.slice(i).reduce((acc, group) => acc + group.length, 0);
      summary.cancelled += remaining;
      processed += remaining;
      report();
      break;
    }
    enqueue(deleteChunk(chunks[i]!));
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
  }

  await Promise.all(inFlight);
  return summary;
}
