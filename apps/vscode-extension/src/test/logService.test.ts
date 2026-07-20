import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import type { ApexLogRow } from '../shared/types';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

function vscodeStub(commandCalls: Array<{ command: string; path: string }> = []) {
  return {
    Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
    ProgressLocation: { Notification: 15 },
    window: {
      withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
        task({}, { onCancellationRequested: () => undefined, isCancellationRequested: false }),
      showErrorMessage: async () => undefined
    },
    commands: {
      executeCommand: async (command: string, uri: { fsPath: string }) => {
        commandCalls.push({ command, path: uri.fsPath });
      }
    }
  };
}

suite('LogService', () => {
  test('openLog asks the Apex Log Lifecycle for a dependable path', async () => {
    const lifecycleCalls: Array<{ logId: string; targetOrg?: string; startTime?: string }> = [];
    const panelCalls: Array<{ logId: string; filePath: string }> = [];
    const { LogService } = proxyquireStrict('../host/services/logService', {
      vscode: vscodeStub(),
      '../../runtime/runtimeClient': {
        runtimeClient: {
          requireLocalLogPath: async (params: { logId: string; targetOrg?: string; startTime?: string }) => {
            lifecycleCalls.push(params);
            return {
              logId: params.logId,
              resolvedUsername: 'open@example.com',
              source: 'local',
              persistence: 'existing',
              localPath: '/tmp/open.log'
            };
          }
        }
      },
      '../../panel/LogViewerPanel': {
        LogViewerPanel: class {
          static async show(params: { logId: string; filePath: string }) {
            panelCalls.push(params);
          }
        }
      }
    });

    await new LogService().openLog('07L000000000002AAA', 'open@example.com');

    assert.deepEqual(lifecycleCalls, [
      { logId: '07L000000000002AAA', targetOrg: 'open@example.com', startTime: undefined }
    ]);
    assert.equal(panelCalls[0]?.filePath, '/tmp/open.log');
  });

  test('debugLog launches Replay with the dependable lifecycle path', async () => {
    const commandCalls: Array<{ command: string; path: string }> = [];
    const { LogService } = proxyquireStrict('../host/services/logService', {
      vscode: vscodeStub(commandCalls),
      '../../runtime/runtimeClient': {
        runtimeClient: {
          requireLocalLogPath: async () => ({
            logId: '07L000000000003AAA',
            resolvedUsername: 'replay@example.com',
            source: 'remote',
            persistence: 'written',
            localPath: '/tmp/replay.log'
          })
        }
      },
      '../utils/replayDebugger': { ensureReplayDebuggerAvailable: async () => true }
    });

    await new LogService().debugLog('07L000000000003AAA', 'replay@example.com');

    assert.deepEqual(commandCalls, [{ command: 'sf.launch.replay.debugger.logfile', path: '/tmp/replay.log' }]);
  });

  test('ensureLogsSaved maps lifecycle acquisition outcomes for requested logs', async () => {
    const existingId = '07L000000000004AAA';
    const downloadedId = '07L000000000005AAA';
    const failedId = '07L000000000006AAA';
    const { LogService } = proxyquireStrict('../host/services/logService', {
      '../../runtime/runtimeClient': {
        runtimeClient: {
          requireLocalLogPath: async ({ logId }: { logId: string }) => {
            if (logId === failedId) throw new Error('unavailable');
            return {
              logId,
              resolvedUsername: 'bulk@example.com',
              source: logId === downloadedId ? 'remote' : 'local',
              persistence: logId === downloadedId ? 'written' : 'existing',
              localPath: `/tmp/${logId}.log`
            };
          }
        }
      }
    });

    const summary = await new LogService(2).ensureLogsSaved(
      [{ Id: existingId }, { Id: downloadedId }, { Id: failedId }] as ApexLogRow[],
      'bulk@example.com'
    );

    assert.equal(summary.success, 2);
    assert.equal(summary.existing, 1);
    assert.equal(summary.downloaded, 1);
    assert.equal(summary.failed, 1);
    assert.deepEqual(summary.failedLogIds, [failedId]);
  });

  test('ensureLogsSaved uses the local-only lifecycle query for search preparation', async () => {
    const availableId = '07L000000000007AAA';
    const missingId = '07L000000000008AAA';
    const missing: string[] = [];
    const { LogService } = proxyquireStrict('../host/services/logService', {
      '../../runtime/runtimeClient': {
        runtimeClient: {
          availableLocalLogPaths: async () => ({
            available: [
              {
                logId: availableId,
                resolvedUsername: 'search@example.com',
                source: 'local',
                persistence: 'existing',
                localPath: `/tmp/${availableId}.log`
              }
            ],
            missing: [{ logId: missingId }],
            failures: []
          })
        }
      }
    });

    const summary = await new LogService().ensureLogsSaved(
      [{ Id: availableId }, { Id: missingId }] as ApexLogRow[],
      'search@example.com',
      undefined,
      { downloadMissing: false, onMissing: (logId: string) => missing.push(logId) }
    );

    assert.equal(summary.success, 1);
    assert.equal(summary.existing, 1);
    assert.equal(summary.missing, 1);
    assert.deepEqual(missing, [missingId]);
    assert.equal(summary.localLogPaths?.[availableId], `/tmp/${availableId}.log`);
  });
});
