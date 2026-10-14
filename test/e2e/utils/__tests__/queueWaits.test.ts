import { summarizeQueueWaits, summarizeRefreshCycles } from '../queueWaits';

describe('summarizeQueueWaits', () => {
  it('groups queue-wait lines by surface and message type', () => {
    const log = [
      '2026-10-14 10:00:00.000 [info] Logs: refresh waited 4302 ms in the extension host queue',
      '2026-10-14 10:00:08.000 [info] [trace] Logs: refresh waited 12 ms in the extension host queue',
      '2026-10-14 10:00:16.000 [info] [trace] Logs: refresh waited 30 ms in the extension host queue',
      '2026-10-14 10:00:20.000 [info] [trace] Logs: searchQuery waited 7 ms in the extension host queue',
      '2026-10-14 10:00:21.000 [info] Logs: message refresh'
    ].join('\n');

    expect(summarizeQueueWaits(log)).toEqual({
      total: 4,
      byType: [
        { message: 'Logs: refresh', count: 3, p50Ms: 30, p90Ms: 4302, maxMs: 4302 },
        { message: 'Logs: searchQuery', count: 1, p50Ms: 7, p90Ms: 7, maxMs: 7 }
      ]
    });
  });

  it('returns an empty summary when the log has no queue-wait lines', () => {
    expect(summarizeQueueWaits('2026-10-14 10:00:21.000 [info] Logs: message refresh')).toEqual({
      total: 0,
      byType: []
    });
  });
});

describe('summarizeRefreshCycles', () => {
  it('measures each webview refresh from its queue-wait line to the next fetched-rows line', () => {
    const log = [
      '2026-10-14 10:00:00.000 [info] Logs: refresh waited 300 ms in the extension host queue',
      '2026-10-14 10:00:00.010 [info] Logs: message refresh',
      '2026-10-14 10:00:01.200 [info] Logs: fetched 21 rows (pageSize = 100 )',
      '2026-10-14 10:00:08.000 [info] [trace] Logs: refresh waited 2 ms in the extension host queue',
      '2026-10-14 10:00:08.500 [info] Logs: fetched 21 rows (pageSize = 100 )',
      '2026-10-14 10:00:09.000 [info] Logs: fetched 21 rows (pageSize = 100 )'
    ].join('\n');

    expect(summarizeRefreshCycles(log)).toEqual({
      count: 2,
      foregroundP50Ms: 1200,
      foregroundMaxMs: 1200,
      clickToRowsP50Ms: 1500,
      clickToRowsMaxMs: 1500
    });
  });
});
