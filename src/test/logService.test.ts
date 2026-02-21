import assert from 'assert/strict';
import proxyquire from 'proxyquire';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { OrgAuth } from '../salesforce/types';
import type { ApexLogRow } from '../shared/types';
import type { EnsureLogsSavedItemResult } from '../services/logService';
import type { ClassifyLogsForErrorsProgress } from '../services/logService';

suite('LogService', () => {
  test('fetchLogs delegates to http fetch', async () => {
    const calls: any[] = [];
    const { LogService } = proxyquire('../services/logService', {
      '../salesforce/http': {
        fetchApexLogs: async (auth: OrgAuth, limit: number, offset: number) => {
          calls.push({ auth, limit, offset });
          return [{ Id: '1' } as ApexLogRow];
        },
        fetchApexLogHead: async () => [],
        fetchApexLogBody: async () => '',
        extractCodeUnitStartedFromLines: () => undefined
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: '', filePath: '' }),
        findExistingLogFile: async () => undefined
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', accessToken: 't', instanceUrl: 'url' })
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

  test('debugLog routes through ensureLogFile before launching debugger', async () => {
    const origWithProgress = vscode.window.withProgress;
    const origExecuteCommand = vscode.commands.executeCommand;
    (vscode.window as any).withProgress = async (_opts: any, task: any) => {
      return task({} as any, {
        onCancellationRequested: () => {},
        isCancellationRequested: false
      });
    };
    const commandCalls: any[] = [];
    (vscode.commands as any).executeCommand = async (command: string, uri: any) => {
      commandCalls.push({ command, uri });
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
        '../utils/warmup': {
          ensureReplayDebuggerAvailable: async () => true
        }
      });
      const svc = new LogService();
      const ensureCalls: string[] = [];
      (svc as any).ensureLogFile = async (logId: string) => {
        ensureCalls.push(logId);
        return '/tmp/test.log';
      };
      await svc.debugLog('abc', 'default');
      assert.deepEqual(ensureCalls, ['abc']);
      assert.equal(commandCalls.length, 1);
      assert.equal(commandCalls[0]?.command, 'sf.launch.replay.debugger.logfile');
    } finally {
      (vscode.window as any).withProgress = origWithProgress;
      (vscode.commands as any).executeCommand = origExecuteCommand;
    }
  });

  test('debugLog benefits from ensureLogFile caching for concurrent requests', async () => {
    const origWithProgress = vscode.window.withProgress;
    const origExecuteCommand = vscode.commands.executeCommand;
    (vscode.window as any).withProgress = async (_opts: any, task: any) => {
      return task({} as any, {
        onCancellationRequested: () => {},
        isCancellationRequested: false
      });
    };
    const commandCalls: any[] = [];
    (vscode.commands as any).executeCommand = async (command: string, uri: any) => {
      commandCalls.push({ command, uri });
    };
    try {
      let storedPath: string | undefined;
      const fetchCalls: string[] = [];
      const filePath = path.join(os.tmpdir(), 'replay-debug.log');
      const { LogService } = proxyquire('../services/logService', {
        '../salesforce/http': {
          fetchApexLogs: async () => [],
          fetchApexLogHead: async () => [],
          extractCodeUnitStartedFromLines: () => undefined,
          fetchApexLogBody: async (_auth: OrgAuth, logId: string) => {
            fetchCalls.push(logId);
            await new Promise(resolve => setTimeout(resolve, 5));
            return 'body';
          }
        },
        '../salesforce/cli': {
          getOrgAuth: async () => ({ username: 'user', accessToken: 'token', instanceUrl: 'url' })
        },
        '../utils/workspace': {
          getLogFilePathWithUsername: async () => ({ dir: path.dirname(filePath), filePath }),
          findExistingLogFile: async () => storedPath
        },
        '../utils/warmup': {
          ensureReplayDebuggerAvailable: async () => true
        },
        fs: {
          promises: {
            writeFile: async (target: string) => {
              await new Promise(resolve => setTimeout(resolve, 1));
              storedPath = target;
            }
          }
        }
      });
      const svc = new LogService();
      await Promise.all([svc.debugLog('abc', 'default'), svc.debugLog('abc', 'default')]);
      assert.equal(fetchCalls.length, 1, 'should only download the log body once');
      assert.equal(commandCalls.length, 2, 'both debugger launches should still occur');
      assert.equal(storedPath, filePath);
    } finally {
      (vscode.window as any).withProgress = origWithProgress;
      (vscode.commands as any).executeCommand = origExecuteCommand;
    }
  });

  test('ensureLogsSaved returns summary and per-item statuses for bulk downloads', async () => {
    const itemStatuses: string[] = [];
    const { LogService } = proxyquire('../services/logService', {
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        fetchApexLogHead: async () => [],
        extractCodeUnitStartedFromLines: () => undefined,
        fetchApexLogBody: async (_auth: OrgAuth, logId: string) => {
          if (logId === '3') {
            throw new Error('failed download');
          }
          return 'body';
        }
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', accessToken: 't', instanceUrl: 'url' })
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async (_username: string | undefined, logId: string) => ({
          dir: '/tmp',
          filePath: `/tmp/${logId}.log`
        }),
        findExistingLogFile: async (logId: string) => (logId === '1' ? '/tmp/1.log' : undefined)
      },
      fs: {
        promises: {
          writeFile: async () => {}
        }
      }
    });

    const svc = new LogService(2);
    const summary = await svc.ensureLogsSaved(
      [{ Id: '1' } as ApexLogRow, { Id: '2' } as ApexLogRow, { Id: '3' } as ApexLogRow],
      'default',
      undefined,
      {
        onItemComplete: (result: EnsureLogsSavedItemResult) => {
          itemStatuses.push(result.status);
        }
      }
    );

    assert.equal(summary.total, 3);
    assert.equal(summary.success, 2);
    assert.equal(summary.existing, 1);
    assert.equal(summary.downloaded, 1);
    assert.equal(summary.failed, 1);
    assert.deepEqual(summary.failedLogIds, ['3']);
    assert.ok(itemStatuses.includes('existing'));
    assert.ok(itemStatuses.includes('downloaded'));
    assert.ok(itemStatuses.includes('failed'));
  });

  test('ensureLogsSaved reports missing logs when downloadMissing is disabled', async () => {
    const missing: string[] = [];
    const statuses: string[] = [];
    const { LogService } = proxyquire('../services/logService', {
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        fetchApexLogHead: async () => [],
        extractCodeUnitStartedFromLines: () => undefined,
        fetchApexLogBody: async () => 'body'
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', accessToken: 't', instanceUrl: 'url' })
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: '/tmp', filePath: '/tmp/x.log' }),
        findExistingLogFile: async (logId: string) => (logId === '2' ? '/tmp/2.log' : undefined)
      }
    });

    const svc = new LogService(1);
    const summary = await svc.ensureLogsSaved(
      [{ Id: '1' } as ApexLogRow, { Id: '2' } as ApexLogRow],
      'default',
      undefined,
      {
        downloadMissing: false,
        onMissing: (logId: string) => missing.push(logId),
        onItemComplete: (result: EnsureLogsSavedItemResult) => statuses.push(result.status)
      }
    );

    assert.equal(summary.total, 2);
    assert.equal(summary.success, 1);
    assert.equal(summary.existing, 1);
    assert.equal(summary.missing, 1);
    assert.equal(summary.failed, 0);
    assert.deepEqual(missing, ['1']);
    assert.ok(statuses.includes('missing'));
    assert.ok(statuses.includes('existing'));
  });

  test('classifyLogsForErrors scans full log body and reports progress', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logservice-errors-'));
    const errPath = path.join(tmpDir, 'default_err.log');
    const okPath = path.join(tmpDir, 'default_ok.log');
    await fs.writeFile(errPath, '12:00:00.000 | EXCEPTION_THROWN | [6] | boom\n', 'utf8');
    await fs.writeFile(okPath, '12:00:00.000 | USER_DEBUG | [6] | all good\n', 'utf8');

    const { LogService } = proxyquire('../services/logService', {
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        fetchApexLogHead: async () => [],
        extractCodeUnitStartedFromLines: () => undefined,
        fetchApexLogBody: async () => ''
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', accessToken: 't', instanceUrl: 'url' })
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: tmpDir, filePath: path.join(tmpDir, 'unused.log') }),
        findExistingLogFile: async (logId: string) => {
          if (logId === 'err') return errPath;
          if (logId === 'ok') return okPath;
          return undefined;
        }
      }
    });

    try {
      const svc = new LogService(2);
      const progress: Array<{ processed: number; total: number; errorsFound: number; logId: string }> = [];
      const result = await svc.classifyLogsForErrors(
        [{ Id: 'err' } as ApexLogRow, { Id: 'ok' } as ApexLogRow],
        'default',
        undefined,
        {
          onProgress: (entry: ClassifyLogsForErrorsProgress) => {
            progress.push({
              processed: entry.processed,
              total: entry.total,
              errorsFound: entry.errorsFound,
              logId: entry.logId
            });
          }
        }
      );

      assert.equal(result.get('err'), true);
      assert.equal(result.get('ok'), false);
      assert.equal(progress.length, 2);
      assert.ok(progress.every(entry => entry.total === 2));
      assert.equal(progress[progress.length - 1]?.processed, 2);
      assert.equal(progress[progress.length - 1]?.errorsFound, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('classifyLogsForErrors treats read failures as potential errors to avoid false negatives', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logservice-errors-fallback-'));
    const okPath = path.join(tmpDir, 'default_ok.log');

    const { LogService } = proxyquire('../services/logService', {
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        fetchApexLogHead: async () => [],
        extractCodeUnitStartedFromLines: () => undefined,
        fetchApexLogBody: async (_auth: OrgAuth, logId: string) => {
          if (logId === 'missing') {
            throw new Error('log disappeared');
          }
          return '12:00:00.000 | USER_DEBUG | [6] | all good\n';
        }
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', accessToken: 't', instanceUrl: 'url' })
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async (_username: string | undefined, logId: string) => ({
          dir: tmpDir,
          filePath: path.join(tmpDir, `default_${logId}.log`)
        }),
        findExistingLogFile: async (logId: string) => (logId === 'ok' ? okPath : undefined)
      }
    });

    try {
      await fs.writeFile(okPath, '12:00:00.000 | USER_DEBUG | [6] | all good\n', 'utf8');
      const svc = new LogService(2);
      const progress: ClassifyLogsForErrorsProgress[] = [];
      const result = await svc.classifyLogsForErrors(
        [{ Id: 'missing' } as ApexLogRow, { Id: 'ok' } as ApexLogRow],
        'default',
        undefined,
        {
          onProgress: (entry: ClassifyLogsForErrorsProgress) => {
            progress.push(entry);
          }
        }
      );

      assert.equal(result.get('missing'), true, 'failed scans should be considered potential errors');
      assert.equal(result.get('ok'), false);
      const missingProgress = progress.find(entry => entry.logId === 'missing');
      assert.equal(missingProgress?.hasErrors, true);
      assert.equal(missingProgress?.inferredFromFailure, true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
