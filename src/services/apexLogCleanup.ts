import type { OrgAuth } from '../salesforce/types';
import { deleteApexLogs, fetchAllApexLogIds, type DeleteApexLogsSummary } from '../salesforce/apexLogs';
import { getCurrentUserId } from '../salesforce/traceflags';

export type ClearLogsScope = 'all' | 'mine';

export type ClearApexLogsResult = DeleteApexLogsSummary & {
  scope: ClearLogsScope;
  listed: number;
  userId?: string;
};

export async function clearApexLogs(
  auth: OrgAuth,
  scope: ClearLogsScope,
  options: {
    signal?: AbortSignal;
    limit?: number;
    concurrency?: number;
    onProgress?: (progress: {
      stage: 'listing' | 'deleting';
      processed: number;
      total: number;
      deleted: number;
      failed: number;
      cancelled: number;
    }) => void;
  } = {}
): Promise<ClearApexLogsResult> {
  const signal = options.signal;
  const normalizedScope: ClearLogsScope = scope === 'mine' ? 'mine' : 'all';

  let userId: string | undefined;
  if (normalizedScope === 'mine') {
    userId = await getCurrentUserId(auth);
    if (!userId) {
      throw new Error('Unable to determine the current org user id for log cleanup.');
    }
  }

  try {
    options.onProgress?.({
      stage: 'listing',
      processed: 0,
      total: 0,
      deleted: 0,
      failed: 0,
      cancelled: 0
    });
  } catch {
    // ignore observer errors
  }

  const ids = await fetchAllApexLogIds(auth, { userId, limit: options.limit, signal });
  if (ids.length === 0) {
    return {
      scope: normalizedScope,
      listed: 0,
      userId,
      total: 0,
      deleted: 0,
      failed: 0,
      cancelled: 0,
      failedLogIds: []
    };
  }

  const summary = await deleteApexLogs(auth, ids, {
    signal,
    concurrency: options.concurrency,
    onProgress: progress => {
      try {
        options.onProgress?.({ stage: 'deleting', ...progress });
      } catch {
        // ignore observer errors
      }
    }
  });

  return {
    scope: normalizedScope,
    listed: ids.length,
    userId,
    ...summary
  };
}

