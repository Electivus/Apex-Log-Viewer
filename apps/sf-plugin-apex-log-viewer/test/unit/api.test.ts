import { strict as assert } from 'assert';
import { queryApexLogs } from '../../src/lib/api.js';

const fakeConn: any = {
  tooling: {
    query: async () => ({
      records: [
        {
          Id: '07L1',
          StartTime: '2024-01-02T03:04:05.000+0000',
          LogLength: 12,
          LogUser: { Username: 'u' },
        },
      ],
    }),
  },
};

describe('queryApexLogs', () => {
  it('returns records from tooling query', async () => {
    const res = await queryApexLogs(fakeConn, 1);
    assert.equal(res.length, 1);
    assert.equal(res[0].id, '07L1');
  });
});
