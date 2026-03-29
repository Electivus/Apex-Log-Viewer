import assert from 'assert/strict';
import proxyquire from 'proxyquire';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { OrgAuth } from '../../../../src/salesforce/types';
import type { ApexLogRow } from '../shared/types';
import type { EnsureLogsSavedItemResult } from '../../../../src/services/logService';
import type { ClassifyLogsForErrorsProgress } from '../../../../src/services/logService';
import type { LogTriageSummary } from '../shared/logTriage';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();
const makeUri = (filePath: string) => ({ fsPath: filePath, path: filePath, toString: () => filePath });

function createVscodeLogServiceStub(commandCalls: Array<{ command: string; uri: any }>) {
  return {
    Uri: {
      file: (filePath: string) => makeUri(filePath)
    },
    ProgressLocation: {
      Notification: 15
    },
    window: {
      withProgress: async (_opts: any, task: any) =>
        task({} as any, {
          onCancellationRequested: () => {},
          isCancellationRequested: false
        }),
      showErrorMessage: async () => undefined
    },
    commands: {
      executeCommand: async (command: string, uri: any) => {
        commandCalls.push({ command, uri });
      }
    }
  };
}

function createRuntimeClientStub(auth: Partial<OrgAuth> = {}) {
  return {
    '../../apps/vscode-extension/src/runtime/runtimeClient': {
      runtimeClient: {
        getOrgAuth: async ({ username }: { username?: string } = {}) => ({
          accessToken: 't',
          instanceUrl: 'url',
          username: username ?? auth.username,
          ...auth
        })
      }
    }
  };
}

suite('LogService', () => {
  async function waitForCondition(
    predicate: () => boolean,
    options: { timeoutMs?: number; intervalMs?: number } = {}
  ): Promise<void> {
    const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 250));
    const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 10));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  test('fetchLogs delegates to http fetch', async () => {
    const calls: any[] = [];
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      '../salesforce/http': {
        fetchApexLogs: async (auth: OrgAuth, limit: number, offset: number) => {
          calls.push({ auth, limit, offset });
          return [{ Id: '1' } as ApexLogRow];
        },
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

  test('openLog resolves auth through runtime client instead of salesforce cli', async () => {
    const calls: any[] = [];
    const authCalls: Array<{ username?: string }> = [];
    const vscodeMock = createVscodeLogServiceStub([]);
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      vscode: vscodeMock,
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        fetchApexLogHead: async () => [],
        extractCodeUnitStartedFromLines: () => undefined,
        fetchApexLogBody: async () => ''
      },
      '../salesforce/cli': {
        getOrgAuth: async () => {
          throw new Error('should not call cli getOrgAuth');
        }
      },
      '../../apps/vscode-extension/src/runtime/runtimeClient': {
        runtimeClient: {
          getOrgAuth: async ({ username }: { username?: string } = {}) => {
            authCalls.push({ username });
            return {
              username,
              accessToken: 't',
              instanceUrl: 'url'
            };
          }
        }
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: '', filePath: '/tmp/should-not-write.log' }),
        findExistingLogFile: async (_logId: string, username?: string) =>
          username === 'runtime@example.com' ? '/tmp/runtime.log' : undefined
      },
      '../../apps/vscode-extension/src/panel/LogViewerPanel': {
        LogViewerPanel: class {
          static async show(opts: any) {
            calls.push(opts);
          }
        }
      }
    });

    const svc = new LogService();
    await svc.openLog('abc', 'runtime@example.com');

    assert.equal(calls.length, 1);
    assert.deepEqual(authCalls, [{ username: 'runtime@example.com' }]);
    assert.equal(calls[0]?.logId, 'abc');
    assert.equal(calls[0]?.filePath, '/tmp/runtime.log');
  });

  test('loadLogHeads skips uncached logs instead of downloading full bodies', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logservice-heads-'));
    const fetchBodyCalls: string[] = [];
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        fetchApexLogBody: async () => {
          fetchBodyCalls.push('called');
          return '\n|CODE_UNIT_STARTED|Foo|Unit\n';
        },
        extractCodeUnitStartedFromLines: () => 'Unit'
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', accessToken: 't', instanceUrl: 'url' })
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: tmpDir, filePath: path.join(tmpDir, 'default_1.log') }),
        findExistingLogFile: async () => undefined
      }
    });
    try {
      const svc = new LogService(1);
      const logs: ApexLogRow[] = [{ Id: '1', LogLength: 10 } as any];
      const seen: any[] = [];
      svc.loadLogHeads(logs, {} as OrgAuth, 0, (id: string, code: string) => {
        seen.push({ id, code });
      }, undefined, { selectedOrg: 'default' });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(seen, [], 'should wait for the async full-body preload to populate code units');
      assert.equal(fetchBodyCalls.length, 0, 'should not trigger a full-body download from loadLogHeads');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadLogHeads reads code units from existing log files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logservice-'));
    const filePath = path.join(tmpDir, 'default_1.log');
    await fs.writeFile(filePath, '\n|CODE_UNIT_STARTED|Foo|Class.method\n', 'utf8');

    const fetchBodyCalls: string[] = [];
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      '../salesforce/http': {
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
      await waitForCondition(() => seen.length === 1, { timeoutMs: 500, intervalMs: 10 });
      assert.deepEqual(seen, [{ id: '1', code: 'Class.method' }]);
      assert.equal(fetchBodyCalls.length, 0, 'should not re-download body when file exists');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadLogHeads scopes saved-log lookup by auth username', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logservice-user-'));
    const matchingPath = path.join(tmpDir, 'user@example.com_1.log');
    await fs.writeFile(matchingPath, '\n|CODE_UNIT_STARTED|Foo|Scoped.method\n', 'utf8');

    const lookupCalls: Array<{ logId: string; username?: string }> = [];
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      '../salesforce/http': {
        extractCodeUnitStartedFromLines: (lines: string[]) => {
          const target = lines.find(line => line.includes('|CODE_UNIT_STARTED|'));
          return target ? 'Scoped.method' : undefined;
        },
        fetchApexLogs: async () => [],
        fetchApexLogBody: async () => ''
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'user@example.com', accessToken: 't', instanceUrl: 'url' })
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: tmpDir, filePath: matchingPath }),
        findExistingLogFile: async (logId: string, username?: string) => {
          lookupCalls.push({ logId, username });
          return username === 'user@example.com' ? matchingPath : undefined;
        }
      }
    });

    try {
      const svc = new LogService(1);
      const seen: Array<{ id: string; code: string }> = [];
      svc.loadLogHeads(
        [{ Id: '1' } as ApexLogRow],
        { accessToken: 't', instanceUrl: 'url', username: 'user@example.com' },
        0,
        (id: string, code: string) => {
          seen.push({ id, code });
        }
      );
      await waitForCondition(() => seen.length === 1, { timeoutMs: 500, intervalMs: 10 });
      assert.deepEqual(lookupCalls, [{ logId: '1', username: 'user@example.com' }]);
      assert.deepEqual(seen, [{ id: '1', code: 'Scoped.method' }]);
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
      const { LogService } = proxyquireStrict('../../../../src/services/logService', {
        '../salesforce/http': {
          fetchApexLogs: async () => [],
          fetchApexLogHead: async () => [],
          extractCodeUnitStartedFromLines: () => undefined,
          fetchApexLogBody: async () => ''
        },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'user@example.com', accessToken: 't', instanceUrl: 'url' })
      },
      ...createRuntimeClientStub({ username: 'user@example.com', accessToken: 't', instanceUrl: 'url' }),
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: '', filePath: '/tmp/test.log' }),
        findExistingLogFile: async (_logId: string, username?: string) =>
            username === 'user@example.com' ? '/tmp/test.log' : undefined
        },
        '../../apps/vscode-extension/src/panel/LogViewerPanel': {
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
    const commandCalls: any[] = [];
    const vscodeMock = createVscodeLogServiceStub(commandCalls);
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      vscode: vscodeMock,
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
        '../utils/replayDebugger': {
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
  });

  test('debugLog benefits from ensureLogFile caching for concurrent requests', async () => {
    const commandCalls: any[] = [];
    const vscodeMock = createVscodeLogServiceStub(commandCalls);
    let storedPath: string | undefined;
    const fetchCalls: string[] = [];
    const filePath = path.join(os.tmpdir(), 'replay-debug.log');
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      vscode: vscodeMock,
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
        ...createRuntimeClientStub({ username: 'user', accessToken: 'token', instanceUrl: 'url' }),
        '../utils/workspace': {
          getLogFilePathWithUsername: async () => ({ dir: path.dirname(filePath), filePath }),
          findExistingLogFile: async () => storedPath
        },
        '../utils/replayDebugger': {
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
  });

  test('ensureLogsSaved returns summary and per-item statuses for bulk downloads', async () => {
    const itemStatuses: string[] = [];
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
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
      ...createRuntimeClientStub({ username: 'u', accessToken: 't', instanceUrl: 'url' }),
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
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
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

  test('ensureLogsSaved reuses authHint without calling CLI auth again', async () => {
    let authCalls = 0;
    const writeTargets: string[] = [];
    const lookupCalls: Array<{ logId: string; username?: string }> = [];
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        extractCodeUnitStartedFromLines: () => undefined,
        fetchApexLogBody: async () => 'body'
      },
      '../salesforce/cli': {
        getOrgAuth: async () => {
          authCalls++;
          return { username: 'u', accessToken: 't', instanceUrl: 'url' };
        }
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async (username: string | undefined, logId: string) => ({
          dir: '/tmp',
          filePath: `/tmp/${username ?? 'none'}_${logId}.log`
        }),
        findExistingLogFile: async (logId: string, username?: string) => {
          lookupCalls.push({ logId, username });
          return undefined;
        }
      },
      fs: {
        promises: {
          writeFile: async (target: string) => {
            writeTargets.push(target);
          }
        }
      }
    });

    const svc = new LogService(1);
    const summary = await svc.ensureLogsSaved(
      [{ Id: '1' } as ApexLogRow],
      'default',
      undefined,
      {
        authHint: { username: 'u', accessToken: 't', instanceUrl: 'url' }
      } as any
    );

    assert.equal(authCalls, 0, 'should avoid a duplicate CLI auth lookup when authHint is provided');
    assert.ok(lookupCalls.length >= 1, 'should check for existing files before writing');
    assert.equal(lookupCalls.every(call => call.logId === '1' && call.username === 'u'), true);
    assert.deepEqual(writeTargets, ['/tmp/u_1.log']);
    assert.equal(summary.downloaded, 1);
  });

  test('summarizeLogTextWithHeuristics returns a summary for error event lines', async () => {
    const { summarizeLogTextWithHeuristics } = proxyquireStrict('../../../../src/services/logTriage', {});

    const summary = summarizeLogTextWithHeuristics('12:00:00.000 | EXCEPTION_THROWN | [6] | boom\n');

    assert.equal(summary.hasErrors, true);
    assert.equal(summary.primaryReason, 'Potential error event (EXCEPTION_THROWN)');
    assert.equal(summary.reasons[0]?.code, 'suspicious_error_payload');
    assert.equal(summary.reasons[0]?.eventType, 'EXCEPTION_THROWN');
  });

  test('classifyLogsForErrors uses file triage summaries and reports progress', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logservice-errors-'));
    const errPath = path.join(tmpDir, 'default_err.log');
    const okPath = path.join(tmpDir, 'default_ok.log');
    await fs.writeFile(errPath, '12:00:00.000 | EXCEPTION_THROWN | [6] | boom\n', 'utf8');
    await fs.writeFile(okPath, '12:00:00.000 | USER_DEBUG | [6] | all good\n', 'utf8');

    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        fetchApexLogHead: async () => [],
        extractCodeUnitStartedFromLines: () => undefined,
        fetchApexLogBody: async () => ''
      },
      './logTriage': {
        summarizeLogFile: async (filePath: string): Promise<LogTriageSummary> =>
          filePath === errPath
            ? {
                hasErrors: true,
                primaryReason: 'Fatal exception',
                reasons: [
                  {
                    code: 'fatal_exception',
                    severity: 'error',
                    summary: 'Fatal exception',
                    line: 1,
                    eventType: 'EXCEPTION_THROWN'
                  }
                ]
              }
            : {
                hasErrors: false,
                reasons: []
              },
        createUnreadableLogSummary: (message?: string): LogTriageSummary => ({
          hasErrors: true,
          primaryReason: message,
          reasons: []
        })
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
            assert.ok(entry.summary, 'should include summary object in progress');
            progress.push({
              processed: entry.processed,
              total: entry.total,
              errorsFound: entry.errorsFound,
              logId: entry.logId
            });
          }
        }
      );

      assert.equal(result.get('err')?.hasErrors, true);
      assert.equal(result.get('ok')?.hasErrors, false);
      assert.equal(progress.length, 2);
      assert.ok(progress.every(entry => entry.total === 2));
      assert.equal(progress[progress.length - 1]?.processed, 2);
      assert.equal(progress[progress.length - 1]?.errorsFound, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('classifyLogsForErrors delegates file reads to log triage helpers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logservice-errors-file-triage-'));
    const errPath = path.join(tmpDir, 'default_err.log');
    await fs.writeFile(errPath, '12:00:00.000 | EXCEPTION_THROWN | [6] | boom\n', 'utf8');

    const summarizeLogFileCalls: string[] = [];
    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
      fs: {
        promises: {
          readFile: async () => {
            throw new Error('readFile should not be used directly by classifyLogsForErrors');
          }
        }
      },
      '../salesforce/http': {
        fetchApexLogs: async () => [],
        fetchApexLogHead: async () => [],
        extractCodeUnitStartedFromLines: () => undefined,
        fetchApexLogBody: async () => ''
      },
      './logTriage': {
        summarizeLogFile: async (filePath: string): Promise<LogTriageSummary> => {
          summarizeLogFileCalls.push(filePath);
          return {
            hasErrors: true,
            primaryReason: 'Fatal exception',
            reasons: [
              {
                code: 'fatal_exception',
                severity: 'error',
                summary: 'Fatal exception',
                line: 1,
                eventType: 'EXCEPTION_THROWN'
              }
            ]
          };
        },
        createUnreadableLogSummary: (message?: string): LogTriageSummary => ({
          hasErrors: true,
          primaryReason: message,
          reasons: []
        })
      },
      '../salesforce/cli': {
        getOrgAuth: async () => ({ username: 'u', accessToken: 't', instanceUrl: 'url' })
      },
      '../utils/workspace': {
        getLogFilePathWithUsername: async () => ({ dir: tmpDir, filePath: path.join(tmpDir, 'unused.log') }),
        findExistingLogFile: async (logId: string) => (logId === 'err' ? errPath : undefined)
      }
    });

    try {
      const svc = new LogService(1);
      const result = await svc.classifyLogsForErrors([{ Id: 'err' } as ApexLogRow], 'default');
      assert.equal(result.get('err')?.hasErrors, true);
      assert.equal(result.get('err')?.primaryReason, 'Fatal exception');
      assert.deepEqual(summarizeLogFileCalls, [errPath]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('classifyLogsForErrors treats read failures as potential errors to avoid false negatives', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logservice-errors-fallback-'));
    const okPath = path.join(tmpDir, 'default_ok.log');

    const { LogService } = proxyquireStrict('../../../../src/services/logService', {
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
      './logTriage': {
        summarizeLogFile: async (): Promise<LogTriageSummary> => ({
          hasErrors: false,
          reasons: []
        }),
        createUnreadableLogSummary: (message?: string): LogTriageSummary => ({
          hasErrors: true,
          primaryReason: message,
          reasons: []
        })
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

      assert.equal(result.get('missing')?.hasErrors, true, 'failed scans should be considered potential errors');
      assert.equal(result.get('ok')?.hasErrors, false);
      const missingProgress = progress.find(entry => entry.logId === 'missing');
      assert.equal(missingProgress?.hasErrors, true);
      assert.equal(missingProgress?.inferredFromFailure, true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
