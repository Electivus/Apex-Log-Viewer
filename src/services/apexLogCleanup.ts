import type { OrgAuth } from '../salesforce/types';
import { deleteApexLogs, fetchAllApexLogIds, type DeleteApexLogsSummary } from '../salesforce/apexLogs';
import { getCurrentUserId } from '../salesforce/traceflags';
import { getErrorMessage } from '../utils/error';
import { logWarn } from '../utils/logger';
import { runtimeClient } from '../../apps/vscode-extension/src/runtime/runtimeClient';

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
    targetOrg?: string;
    preferRuntime?: boolean;
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

  if (options.preferRuntime) {
    try {
      return await clearApexLogsWithRuntime(auth, normalizedScope, options);
    } catch (error) {
      if (signal?.aborted || !isRuntimeCleanupCapabilityUnavailable(error)) {
        throw error;
      }
      logWarn('ApexLog cleanup runtime capability unavailable; falling back to TypeScript path ->', getErrorMessage(error));
    }
  }

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

async function clearApexLogsWithRuntime(
  auth: OrgAuth,
  scope: ClearLogsScope,
  options: {
    signal?: AbortSignal;
    targetOrg?: string;
    limit?: number;
    onProgress?: (progress: {
      stage: 'listing' | 'deleting';
      processed: number;
      total: number;
      deleted: number;
      failed: number;
      cancelled: number;
    }) => void;
  }
): Promise<ClearApexLogsResult> {
  const result = await runtimeClient.logsDelete(
    {
      targetOrg: options.targetOrg || auth.username,
      scope,
      limit: options.limit,
      dryRun: false,
      confirmed: true
    },
    options.signal
  );

  try {
    options.onProgress?.({
      stage: 'deleting',
      processed: result.total,
      total: result.total,
      deleted: result.deleted,
      failed: result.failed,
      cancelled: result.cancelled
    });
  } catch {
    // ignore observer errors
  }

  return {
    scope,
    listed: result.listed,
    total: result.total,
    deleted: result.deleted,
    failed: result.failed,
    cancelled: result.cancelled,
    failedLogIds: result.failedLogIds ?? []
  };
}

function isRuntimeCleanupCapabilityUnavailable(error: unknown): boolean {
  const maybeCode = (error as { code?: unknown } | undefined)?.code;
  if (maybeCode === -32601) {
    return true;
  }
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('method not found');
}
