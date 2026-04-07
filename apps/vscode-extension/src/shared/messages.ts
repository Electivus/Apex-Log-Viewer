import type { ApexLogRow, OrgItem } from './types';
import type { LogsColumnsConfig, NormalizedLogsColumnsConfig } from './logsColumns';
import type { LogDiagnostic } from './logTriage';
import { normalizeLogsColumnsConfig } from './logsColumns';

// Messages sent from Webview -> Extension
export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'downloadAllLogs' }
  | { type: 'clearLogs'; scope: 'all' | 'mine' }
  | { type: 'selectOrg'; target: string }
  | { type: 'openDebugFlags' }
  | { type: 'openLog'; logId: string }
  | { type: 'replay'; logId: string }
  | { type: 'loadMore' }
  | { type: 'searchQuery'; value: string }
  | { type: 'trackLogsSearch'; outcome: 'searched' | 'cleared'; queryLength?: '1-3' | '4-10' | '11-30' | '31+' }
  | {
      type: 'trackLogsFilter';
      outcome: 'changed' | 'cleared';
      hasUser: boolean;
      hasOperation: boolean;
      hasStatus: boolean;
      hasCodeUnit: boolean;
      errorsOnly: boolean;
      activeCount: number;
    }
  | { type: 'setLogsColumns'; value: LogsColumnsConfig }
  // Tail view messages
  | { type: 'tailStart'; debugLevel?: string }
  | { type: 'tailStop' }
  | { type: 'tailClear' };

// Messages sent from Extension -> Webview
export type ExtensionToWebviewMessage =
  | { type: 'loading'; value: boolean }
  | { type: 'error'; message: string }
  | { type: 'warning'; message?: string }
  | { type: 'init'; locale: string; fullLogSearchEnabled?: boolean; logsColumns?: NormalizedLogsColumnsConfig }
  | { type: 'logsColumns'; value: NormalizedLogsColumnsConfig }
  | { type: 'logs'; data: ApexLogRow[]; hasMore: boolean }
  | { type: 'appendLogs'; data: ApexLogRow[]; hasMore: boolean }
  | {
      type: 'logHead';
      logId: string;
      codeUnitStarted?: string;
      hasErrors?: boolean;
      primaryReason?: string;
      reasons?: LogDiagnostic[];
    }
  | { type: 'errorScanStatus'; state: 'idle' | 'running'; processed: number; total: number; errorsFound: number }
  | {
      type: 'searchMatches';
      query: string;
      logIds: string[];
      snippets?: Record<string, { text: string; ranges: [number, number][] }>;
      pendingLogIds?: string[];
    }
  | { type: 'searchStatus'; state: 'idle' | 'loading' }
  | { type: 'orgs'; data: OrgItem[]; selected: string | undefined }
  | { type: 'debugLevels'; data: string[]; active?: string }
  // Tail view messages
  | { type: 'tailStatus'; running: boolean }
  | { type: 'tailData'; lines: string[] }
  | { type: 'tailReset' }
  | { type: 'tailConfig'; tailBufferSize: number }
  | {
      type: 'tailNewLog';
      logId: string;
      startTime?: string;
      operation?: string;
      status?: string;
      logLength?: number;
      savedPath?: string;
    };

const MAX_ORG_IDENTIFIER_LENGTH = 320;
const MAX_LOG_ID_LENGTH = 128;
const MAX_SEARCH_QUERY_LENGTH = 2048;
const MAX_DEBUG_LEVEL_NAME_LENGTH = 255;
const LOG_ID_PATTERN = /^[A-Za-z0-9]{1,128}$/;
const SEARCH_QUERY_LENGTH_BUCKETS = new Set(['1-3', '4-10', '11-30', '31+']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function parseTrimmedString(value: unknown, maxLength: number): string | undefined {
  const parsed = parseString(value, maxLength);
  return parsed === undefined ? undefined : parsed.trim();
}

function parseLogId(value: unknown): string | undefined {
  const parsed = parseTrimmedString(value, MAX_LOG_ID_LENGTH);
  return parsed && LOG_ID_PATTERN.test(parsed) ? parsed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

export function parseWebviewToExtensionMessage(raw: unknown): WebviewToExtensionMessage | undefined {
  const message = asRecord(raw);
  if (!message) {
    return undefined;
  }

  switch (message.type) {
    case 'ready':
    case 'refresh':
    case 'downloadAllLogs':
    case 'openDebugFlags':
    case 'loadMore':
    case 'tailStop':
    case 'tailClear':
      return { type: message.type };
    case 'clearLogs':
      if (message.scope === 'all' || message.scope === 'mine') {
        return { type: 'clearLogs', scope: message.scope };
      }
      return undefined;
    case 'selectOrg': {
      const target = parseTrimmedString(message.target, MAX_ORG_IDENTIFIER_LENGTH);
      return target !== undefined ? { type: 'selectOrg', target } : undefined;
    }
    case 'openLog': {
      const logId = parseLogId(message.logId);
      return logId ? { type: 'openLog', logId } : undefined;
    }
    case 'replay': {
      const logId = parseLogId(message.logId);
      return logId ? { type: 'replay', logId } : undefined;
    }
    case 'searchQuery': {
      const value = parseString(message.value, MAX_SEARCH_QUERY_LENGTH);
      return value !== undefined ? { type: 'searchQuery', value } : undefined;
    }
    case 'trackLogsSearch':
      if (message.outcome === 'searched') {
        const queryLength =
          typeof message.queryLength === 'string' && SEARCH_QUERY_LENGTH_BUCKETS.has(message.queryLength)
            ? (message.queryLength as '1-3' | '4-10' | '11-30' | '31+')
            : undefined;
        return { type: 'trackLogsSearch', outcome: 'searched', ...(queryLength ? { queryLength } : {}) };
      }
      if (message.outcome === 'cleared') {
        return { type: 'trackLogsSearch', outcome: 'cleared' };
      }
      return undefined;
    case 'trackLogsFilter': {
      if (message.outcome !== 'changed' && message.outcome !== 'cleared') {
        return undefined;
      }
      const hasUser = parseBoolean(message.hasUser);
      const hasOperation = parseBoolean(message.hasOperation);
      const hasStatus = parseBoolean(message.hasStatus);
      const hasCodeUnit = parseBoolean(message.hasCodeUnit);
      const errorsOnly = parseBoolean(message.errorsOnly);
      const activeCount = parseNonNegativeInteger(message.activeCount);
      if (
        hasUser === undefined ||
        hasOperation === undefined ||
        hasStatus === undefined ||
        hasCodeUnit === undefined ||
        errorsOnly === undefined ||
        activeCount === undefined
      ) {
        return undefined;
      }
      return {
        type: 'trackLogsFilter',
        outcome: message.outcome,
        hasUser,
        hasOperation,
        hasStatus,
        hasCodeUnit,
        errorsOnly,
        activeCount
      };
    }
    case 'setLogsColumns':
      return {
        type: 'setLogsColumns',
        value: normalizeLogsColumnsConfig(message.value) as LogsColumnsConfig
      };
    case 'tailStart': {
      const debugLevel =
        typeof message.debugLevel === 'undefined'
          ? undefined
          : parseTrimmedString(message.debugLevel, MAX_DEBUG_LEVEL_NAME_LENGTH);
      if (typeof message.debugLevel !== 'undefined' && debugLevel === undefined) {
        return undefined;
      }
      return debugLevel ? { type: 'tailStart', debugLevel } : { type: 'tailStart' };
    }
    default:
      return undefined;
  }
}
