import type { ApexLogRow, OrgItem } from './types';
import type { LogsColumnsConfig, NormalizedLogsColumnsConfig } from './logsColumns';

// Messages sent from Webview -> Extension
export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'downloadAllLogs' }
  | { type: 'selectOrg'; target: string }
  | { type: 'openDebugFlags' }
  | { type: 'openLog'; logId: string }
  | { type: 'replay'; logId: string }
  | { type: 'loadMore' }
  | { type: 'searchQuery'; value: string }
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
  | { type: 'logHead'; logId: string; codeUnitStarted?: string }
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
