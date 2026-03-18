import { LOGS_COLUMN_DEFAULT_TRACK, LOGS_COLUMN_MIN_WIDTH_PX } from '../utils/logsColumns';

describe('logsColumns', () => {
  it('gives the status column enough default width for status badges and reason text', () => {
    expect(LOGS_COLUMN_MIN_WIDTH_PX.status).toBeGreaterThanOrEqual(220);
    expect(LOGS_COLUMN_DEFAULT_TRACK.status).toBe('minmax(220px,1fr)');
  });
});
