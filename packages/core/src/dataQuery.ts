import type { Connection } from '@salesforce/core';

import { awaitWithAbort, throwIfAborted } from './errors.js';

export type DataQueryOptions = {
  /** Stop following `nextRecordsUrl` once this many records are collected. Required: no unbounded reads. */
  maxRecords: number;
  signal?: AbortSignal;
};

export type DataQueryResult<TRecord> = {
  records: TRecord[];
  totalSize: number;
  /** False when `maxRecords` stopped the read before Salesforce did. */
  done: boolean;
};

/** One batch of a query response, as Salesforce sends it. */
export type QueryBatch<TRecord> = {
  records?: TRecord[];
  totalSize?: number;
  done?: boolean;
  nextRecordsUrl?: string;
};

/**
 * Runs `soql` on the data API and follows `nextRecordsUrl` until Salesforce is done or `maxRecords`
 * arrived. jsforce returns only the first batch by default, and Salesforce shrinks batches for rows
 * with long text, so a `LIMIT n` can arrive in several. Salesforce errors propagate unchanged.
 */
export async function queryData<TRecord = Record<string, unknown>>(
  connection: Connection,
  soql: string,
  options: DataQueryOptions
): Promise<DataQueryResult<TRecord>> {
  const { maxRecords, signal } = options;
  throwIfAborted(signal);
  let batch = (await awaitWithAbort(connection.query(soql), signal)) as QueryBatch<TRecord>;
  const records = [...(batch.records ?? [])];
  while (records.length < maxRecords && !batch.done && batch.nextRecordsUrl) {
    throwIfAborted(signal);
    batch = (await awaitWithAbort(connection.queryMore(batch.nextRecordsUrl), signal)) as QueryBatch<TRecord>;
    records.push(...(batch.records ?? []));
  }
  return {
    records: records.slice(0, maxRecords),
    totalSize: batch.totalSize ?? records.length,
    done: records.length <= maxRecords && (batch.done ?? true)
  };
}

/** Tooling API query, following every `nextRecordsUrl`. The metadata and ApexLog reads are small, so it takes no cap. */
export async function toolingQuery<TRecord = Record<string, unknown>>(
  connection: Connection,
  soql: string,
  signal?: AbortSignal
): Promise<QueryBatch<TRecord> & { records: TRecord[] }> {
  throwIfAborted(signal);
  const firstPage = (await awaitWithAbort(connection.tooling.query(soql), signal)) as QueryBatch<TRecord>;
  const records = [...(firstPage.records || [])];
  let page = firstPage;
  while (!page.done && page.nextRecordsUrl) {
    throwIfAborted(signal);
    page = (await awaitWithAbort(connection.tooling.queryMore(page.nextRecordsUrl), signal)) as QueryBatch<TRecord>;
    records.push(...(page.records || []));
  }
  return {
    ...firstPage,
    records,
    done: page.done,
    nextRecordsUrl: page.nextRecordsUrl
  };
}
