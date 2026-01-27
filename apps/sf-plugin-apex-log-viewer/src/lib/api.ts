import type { Connection } from '@salesforce/core';
import type { ApexLogRecord } from './types.js';

export const queryApexLogs = async (conn: Connection, limit: number): Promise<ApexLogRecord[]> => {
  const soql = `SELECT Id, StartTime, LogLength, LogUser.Username FROM ApexLog ORDER BY StartTime DESC LIMIT ${limit}`;
  const res = await conn.tooling.query(soql);
  return res.records.map((record: any) => ({
    id: record.Id,
    startTime: record.StartTime,
    logLength: record.LogLength,
    username: record.LogUser?.Username ?? 'default',
  }));
};

export const fetchApexLogBody = async (conn: Connection, logId: string): Promise<string> => {
  const url = `/services/data/v${conn.getApiVersion()}/tooling/sobjects/ApexLog/${logId}/Body`;
  return conn.request<string>(url);
};
