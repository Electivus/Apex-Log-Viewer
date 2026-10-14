import { summarizeQueueWaits } from '../queueWaits';

describe('summarizeQueueWaits', () => {
  it('groups queue-wait lines by surface and message type', () => {
    const log = [
      '2026-10-14 10:00:00.000 [info] Logs: refresh waited 4302 ms in the extension host queue',
      '2026-10-14 10:00:08.000 [trace] Logs: refresh waited 12 ms in the extension host queue',
      '2026-10-14 10:00:16.000 [trace] Logs: refresh waited 30 ms in the extension host queue',
      '2026-10-14 10:00:20.000 [trace] Logs: searchQuery waited 7 ms in the extension host queue',
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
