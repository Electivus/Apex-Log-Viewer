const clearApexLogsForE2EMock = jest.fn();
const getOrgAuthMock = jest.fn();

jest.mock('../timing', () => ({
  timeE2eStep: async (_label: string, action: () => Promise<unknown>) => await action()
}));

jest.mock('../tooling', () => ({
  clearApexLogsForE2E: (...args: unknown[]) => clearApexLogsForE2EMock(...args),
  ensureE2eTraceFlag: jest.fn(),
  executeAnonymousApex: jest.fn(),
  findRecentApexLogId: jest.fn(),
  getOrgAuth: (...args: unknown[]) => getOrgAuthMock(...args)
}));

import { clearOrgApexLogs } from '../seedLog';

describe('clearOrgApexLogs', () => {
  beforeEach(() => {
    clearApexLogsForE2EMock.mockReset();
    getOrgAuthMock.mockReset();
  });

  test('throws when ApexLog cleanup reports failed deletions', async () => {
    getOrgAuthMock.mockResolvedValue({
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'alv@example.com',
      apiVersion: '64.0'
    });
    clearApexLogsForE2EMock.mockResolvedValue({
      listed: 3,
      deleted: 2,
      failed: 1,
      failedLogIds: ['07L000000000001AAA']
    });

    await expect(clearOrgApexLogs('ALV_E2E_Scratch', 'all')).rejects.toThrow(
      'Failed to clear 1 ApexLog(s) for scope "all". Failed IDs: 07L000000000001AAA'
    );
  });
});
