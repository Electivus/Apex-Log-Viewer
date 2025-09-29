import assert from 'assert/strict';
import proxyquire from 'proxyquire';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
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
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', accessToken: 't', instanceUrl: 'url' })
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
    }, undefined);
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(seen, [{ id: '1', code: 'Unit' }]);
  });

  test('loadLogHeads prefers local full bodies when available', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logservice-'));
    const filePath = path.join(tmpDir, 'default_1.log');
    await fs.writeFile(filePath, '\n|CODE_UNIT_STARTED|Foo|Class.method\n', 'utf8');

    const fetchHeadCalls: string[] = [];
    const fetchBodyCalls: string[] = [];
    const { LogService } = proxyquire('../services/logService', {
      '../salesforce/http': {
        fetchApexLogHead: async () => {
          fetchHeadCalls.push('called');
          return [];
        },
        extractCodeUnitStartedFromLines: (lines: string[]) => {
          const target = lines.find(l => l.includes('|CODE_UNIT_STARTED|'));
          return target ? 'Class.method' : undefined;
        },
        fetchApexLogs: async () => [],
        fetchApexLogBody: async () => {
          fetchBodyCalls.push('called');
          return '';
        }
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', accessToken: 't', instanceUrl: 'url' })
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: tmpDir, filePath }),
        findExistingLogFile: async () => filePath
      }
    });

    try {
      const svc = new LogService(1);
      const seen: any[] = [];
      svc.loadLogHeads(
        [{ Id: '1' } as ApexLogRow],
        { accessToken: 't', instanceUrl: 'url', username: 'u' },
        0,
        (id: string, code: string) => {
          seen.push({ id, code });
        },
        undefined,
        { preferLocalBodies: true, selectedOrg: 'default' }
      );
      await new Promise(r => setTimeout(r, 20));
      assert.deepEqual(seen, [{ id: '1', code: 'Class.method' }]);
      assert.equal(fetchHeadCalls.length, 0, 'should not fall back to remote head');
      assert.equal(fetchBodyCalls.length, 0, 'should not re-download body when file exists');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('openLog delegates to LogViewerPanel', async () => {
    const calls: any[] = [];
    const origWithProgress = vscode.window.withProgress;
    (vscode.window as any).withProgress = async (_opts: any, task: any) => {
      return task({} as any, {
        onCancellationRequested: () => {},
        isCancellationRequested: false
      });
    };
    try {
      const { LogService } = proxyquire('../services/logService', {
        '../salesforce/http': {
          fetchApexLogs: async () => [],
          fetchApexLogHead: async () => [],
          extractCodeUnitStartedFromLines: () => undefined,
          fetchApexLogBody: async () => ''
        },
        '../utils/workspace': {
          getLogFilePathWithUsername: async () => ({ dir: '', filePath: '/tmp/test.log' }),
          findExistingLogFile: async () => '/tmp/test.log'
        },
        '../panel/LogViewerPanel': {
          LogViewerPanel: class {
            static async show(opts: any) {
              calls.push(opts);
            }
          }
        }
      });
      const svc = new LogService();
      await svc.openLog('abc');
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.logId, 'abc');
      assert.equal(calls[0]?.filePath, '/tmp/test.log');
    } finally {
      (vscode.window as any).withProgress = origWithProgress;
    }
  });
});
