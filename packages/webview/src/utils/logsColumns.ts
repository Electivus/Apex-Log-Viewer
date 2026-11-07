import type { LogsColumnKey, NormalizedLogsColumnsConfig } from '@alv/protocol/logsColumns';

/** Every row is one line, so the list can size and scroll its rows without measuring them. */
export const LOG_ROW_HEIGHT_PX = 28;

export const LOGS_ACTIONS_TRACK_PX = 72;

export const LOGS_COLUMN_MIN_WIDTH_PX: Record<LogsColumnKey, number> = {
  user: 140,
  application: 110,
  operation: 240,
  time: 170,
  duration: 90,
  status: 180,
  size: 70,
  match: 320
};

export const LOGS_COLUMN_DEFAULT_TRACK: Record<LogsColumnKey, string> = {
  user: 'minmax(140px,1fr)',
  application: 'minmax(110px,1fr)',
  operation: 'minmax(240px,1.2fr)',
  time: 'minmax(170px,1fr)',
  duration: 'minmax(90px,0.6fr)',
  status: 'minmax(180px,1fr)',
  size: 'minmax(70px,0.6fr)',
  match: 'minmax(320px,1.6fr)'
};

/** The first visible column in this order takes the spare width, so the saved widths of the others stay exact. */
const FLEX_COLUMN_PREFERENCE: LogsColumnKey[] = [
  'operation',
  'match',
  'application',
  'user',
  'time',
  'status',
  'duration',
  'size'
];

/**
 * The columns the list draws. `Match` only says something while a search has text, so it leaves the table
 * otherwise. The saved order and visibility are untouched, and the next search brings the column back.
 */
export function getVisibleLogsColumns(
  config: Pick<NormalizedLogsColumnsConfig, 'order' | 'visibility'>,
  state: { fullLogSearchEnabled: boolean; hasSearchText: boolean }
): LogsColumnKey[] {
  return config.order.filter(key => {
    if (!config.visibility[key]) return false;
    return key !== 'match' || (state.fullLogSearchEnabled && state.hasSearchText);
  });
}

/** The CSS grid of the header and every row, and the narrowest width it takes before the list scrolls sideways. */
export function buildLogsGrid(
  columns: LogsColumnKey[],
  widths: NormalizedLogsColumnsConfig['widths']
): { gridTemplate: string; minWidthPx: number } {
  const flexColumn = FLEX_COLUMN_PREFERENCE.find(key => columns.includes(key));
  let minWidthPx = LOGS_ACTIONS_TRACK_PX;
  const tracks = columns.map(key => {
    const minWidth = LOGS_COLUMN_MIN_WIDTH_PX[key];
    const saved = widths[key];
    const width =
      typeof saved === 'number' && Number.isFinite(saved) ? Math.max(minWidth, Math.floor(saved)) : undefined;
    minWidthPx += width ?? minWidth;
    if (key === flexColumn) {
      return width === undefined ? LOGS_COLUMN_DEFAULT_TRACK[key] : `minmax(${width}px, 1fr)`;
    }
    return width === undefined ? LOGS_COLUMN_DEFAULT_TRACK[key] : `${width}px`;
  });
  return { gridTemplate: [...tracks, `${LOGS_ACTIONS_TRACK_PX}px`].join(' '), minWidthPx };
}

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
    case 'size':
      return t?.columns?.size ?? 'Size';
    case 'match':
      return t?.columns?.match ?? 'Match';
  }
}
