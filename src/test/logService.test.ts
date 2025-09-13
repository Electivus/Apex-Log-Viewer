import assert from 'assert/strict';
import proxyquire from 'proxyquire';
import type { OrgAuth } from '../salesforce/types';
import type { ApexLogRow } from '../shared/types';

suite('LogService', () => {
  test('fetchLogs delegates to fetchApexLogs', async () => {
    const calls: any[] = [];
    const { LogService } = proxyquire('../services/logService', {
      '../salesforce/http': {
        fetchApexLogs: (auth: OrgAuth, limit: number, offset: number) => {
          calls.push({ auth, limit, offset });
          return Promise.resolve([{ Id: '1' }] as ApexLogRow[]);
        },
        fetchApexLogHead: async () => [],
        extractCodeUnitStartedFromLines: () => undefined,
        fetchApexLogBody: async () => ''
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: '', filePath: '' }),
        findExistingLogFile: async () => undefined
      }
    });
    const svc = new LogService();
    const auth: OrgAuth = { accessToken: 't', instanceUrl: 'url', username: 'u' };
    const res = await svc.fetchLogs(auth, 2, 0);
    assert.equal(res.length, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { auth, limit: 2, offset: 0 });
  });

  test('loadLogHeads posts code units', async () => {
    const { LogService } = proxyquire('../services/logService', {
      '../salesforce/http': {
        fetchApexLogHead: async () => ['line'],
        extractCodeUnitStartedFromLines: () => 'Unit',
        fetchApexLogs: async () => [],
        fetchApexLogBody: async () => ''
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: '', filePath: '' }),
        findExistingLogFile: async () => undefined
      }
    });
    const svc = new LogService(1);
    const logs: ApexLogRow[] = [{ Id: '1', LogLength: 10 } as any];
    const seen: any[] = [];
    svc.loadLogHeads(logs, {} as OrgAuth, 0, (id: string, code: string) => {
      seen.push({ id, code });
    });
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(seen, [{ id: '1', code: 'Unit' }]);
  });

  test('ensureLogFile delegates to utility', async () => {
    const calls: any[] = [];
    const { LogService } = proxyquire('../services/logService', {
      '../utils/logFile': {
        ensureLogFile: async (...args: any[]) => {
          calls.push(args);
          return '/p';
        }
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', instanceUrl: 'i', accessToken: 't' })
      },
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        fetchApexLogHead: async () => [],
        extractCodeUnitStartedFromLines: () => undefined
      },
      '../utils/workspace': { findExistingLogFile: async () => undefined },
      '../utils/limiter': { createLimiter: () => (fn: any) => fn() }
    });
    const svc = new LogService();
    const path = await (svc as any).ensureLogFile('1', 'org');
    assert.equal(path, '/p');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], '1');
  });
});
