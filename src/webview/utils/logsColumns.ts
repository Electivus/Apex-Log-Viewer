import type { LogsColumnKey } from '../../shared/logsColumns';

export const LOGS_COLUMN_MIN_WIDTH_PX: Record<LogsColumnKey, number> = {
  user: 160,
  application: 140,
  operation: 200,
  time: 200,
  duration: 110,
  status: 120,
  codeUnit: 260,
  size: 90,
  match: 320
};

export const LOGS_COLUMN_DEFAULT_TRACK: Record<LogsColumnKey, string> = {
  user: 'minmax(160px,1fr)',
  application: 'minmax(140px,1fr)',
  operation: 'minmax(200px,1.2fr)',
  time: 'minmax(200px,1fr)',
  duration: 'minmax(110px,0.6fr)',
  status: 'minmax(120px,0.8fr)',
  codeUnit: 'minmax(260px,1.4fr)',
  size: 'minmax(90px,0.6fr)',
  match: 'minmax(320px,1.6fr)'
};

export function getLogsColumnLabel(key: LogsColumnKey, t: any): string {
  switch (key) {
    case 'user':
      return t?.columns?.user ?? 'User';
    case 'application':
      return t?.columns?.application ?? 'Application';
    case 'operation':
      return t?.columns?.operation ?? 'Operation';
    case 'time':
      return t?.columns?.time ?? 'Time';
    case 'duration':
      return t?.columns?.duration ?? 'Duration';
    case 'status':
      return t?.columns?.status ?? 'Status';
    case 'codeUnit':
      return t?.columns?.codeUnitStarted ?? 'Code Unit';
    case 'size':
      return t?.columns?.size ?? 'Size';
    case 'match':
      return t?.columns?.match ?? 'Match';
  }
}

