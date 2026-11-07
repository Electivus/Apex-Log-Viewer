import { DEFAULT_LOGS_COLUMNS_CONFIG, type LogsColumnKey } from '@alv/protocol/logsColumns';
import {
  LOGS_ACTIONS_TRACK_PX,
  LOGS_COLUMN_DEFAULT_TRACK,
  LOGS_COLUMN_MIN_WIDTH_PX,
  buildLogsGrid,
  getVisibleLogsColumns
} from '../utils/logsColumns';

const ALL_COLUMNS = Object.keys(LOGS_COLUMN_MIN_WIDTH_PX) as LogsColumnKey[];

describe('logsColumns', () => {
  it('gives the status column room for its badges without the old 220 px floor', () => {
    expect(LOGS_COLUMN_MIN_WIDTH_PX.status).toBe(210);
    expect(LOGS_COLUMN_DEFAULT_TRACK.status).toBe('minmax(210px,1.5fr)');
  });

  it.each(ALL_COLUMNS)('the default track of %s starts at its minimum width', key => {
    expect(LOGS_COLUMN_DEFAULT_TRACK[key]).toMatch(new RegExp(`^minmax\\(${LOGS_COLUMN_MIN_WIDTH_PX[key]}px,`));
  });

  describe('getVisibleLogsColumns', () => {
    const config = DEFAULT_LOGS_COLUMNS_CONFIG;

    it('leaves Match out until the search has text', () => {
      const columns = getVisibleLogsColumns(config, { fullLogSearchEnabled: true, hasSearchText: false });
      expect(columns).toEqual(['user', 'application', 'operation', 'time', 'duration', 'status', 'size']);
    });

    it('brings Match back, in its saved position, while the search has text', () => {
      const reordered = { ...config, order: ['match' as const, ...config.order.filter(key => key !== 'match')] };
      expect(getVisibleLogsColumns(reordered, { fullLogSearchEnabled: true, hasSearchText: true })[0]).toBe('match');
    });

    it('never shows Match without full log search', () => {
      const columns = getVisibleLogsColumns(config, { fullLogSearchEnabled: false, hasSearchText: true });
      expect(columns).not.toContain('match');
    });

    it('honors the saved visibility and order', () => {
      const custom = {
        order: ['status' as const, 'user' as const, 'time' as const],
        visibility: { ...config.visibility, user: false }
      };
      expect(getVisibleLogsColumns(custom, { fullLogSearchEnabled: true, hasSearchText: true })).toEqual([
        'status',
        'time'
      ]);
    });
  });

  describe('buildLogsGrid', () => {
    it('totals the minimum widths of the columns and the pinned actions', () => {
      const columns = getVisibleLogsColumns(DEFAULT_LOGS_COLUMNS_CONFIG, {
        fullLogSearchEnabled: true,
        hasSearchText: false
      });
      const { gridTemplate, minWidthPx } = buildLogsGrid(columns, {});
      expect(minWidthPx).toBe(130 + 90 + 240 + 170 + 90 + 210 + 70 + LOGS_ACTIONS_TRACK_PX);
      expect(gridTemplate.endsWith(` ${LOGS_ACTIONS_TRACK_PX}px`)).toBe(true);
      expect(gridTemplate.split(' ')).toHaveLength(columns.length + 1);
    });

    it('keeps a saved width exact, and the flexible column grows from its saved width', () => {
      const { gridTemplate, minWidthPx } = buildLogsGrid(['user', 'operation'], { user: 300, operation: 400 });
      expect(gridTemplate).toBe(`300px minmax(400px, 1fr) ${LOGS_ACTIONS_TRACK_PX}px`);
      expect(minWidthPx).toBe(700 + LOGS_ACTIONS_TRACK_PX);
    });

    it('clamps a saved width to the new minimum', () => {
      const { gridTemplate } = buildLogsGrid(['user', 'operation'], { user: 90 });
      expect(gridTemplate.startsWith(`${LOGS_COLUMN_MIN_WIDTH_PX.user}px `)).toBe(true);
    });

    it('lets the operation column take the spare width, and Match when operation is hidden', () => {
      expect(buildLogsGrid(['user', 'operation', 'match'], {}).gridTemplate).toContain(
        LOGS_COLUMN_DEFAULT_TRACK.operation
      );
      expect(buildLogsGrid(['user', 'match'], { match: 500 }).gridTemplate).toContain('minmax(500px, 1fr)');
    });
  });
});
