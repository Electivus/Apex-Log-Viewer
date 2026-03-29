import assert from 'assert/strict';
import proxyquire from 'proxyquire';

suite('Replay Debugger availability', () => {
  test('treats the Apex Replay Debugger extension as available before activation', async () => {
    const shown: string[] = [];
    let activated = false;
    const vscodeStub = {
      commands: {
        getCommands: async () =>
          activated ? ['sf.launch.replay.debugger.logfile', 'sf.launch.replay.debugger.last.logfile'] : []
      },
      extensions: {
        getExtension: (id: string) =>
          id === 'salesforce.salesforcedx-vscode-apex-replay-debugger'
            ? ({
                id,
                activate: async () => {
                  activated = true;
                }
              } as any)
            : undefined
      },
      window: {
        showErrorMessage: (msg: string) => {
          shown.push(msg);
        }
      }
    };

    const { ensureReplayDebuggerAvailable } = proxyquire('../../../../src/utils/replayDebugger', {
      vscode: vscodeStub,
      './localize': { localize: (_key: string, message: string) => message },
      './logger': { logWarn: () => {} },
      './error': { getErrorMessage: () => 'err' }
    });

    const ok = await ensureReplayDebuggerAvailable();
    assert.equal(ok, true);
    assert.equal(shown.length, 0, 'should not surface a missing-extension toast');
  });

  test('surfaces guidance when the Replay Debugger extension is installed but commands stay unavailable', async () => {
    const shown: string[] = [];
    const vscodeStub = {
      commands: {
        getCommands: async () => []
      },
      extensions: {
        getExtension: (id: string) =>
          id === 'salesforce.salesforcedx-vscode-apex-replay-debugger'
            ? ({
                id,
                activate: async () => {}
              } as any)
            : undefined
      },
      window: {
        showErrorMessage: (msg: string) => {
          shown.push(msg);
        }
      }
    };

    const { ensureReplayDebuggerAvailable } = proxyquire('../../../../src/utils/replayDebugger', {
      vscode: vscodeStub,
      './localize': { localize: (_key: string, message: string) => message },
      './logger': { logWarn: () => {} },
      './error': { getErrorMessage: () => 'err' }
    });

    const ok = await ensureReplayDebuggerAvailable();
    assert.equal(ok, false);
    assert.equal(shown.length, 1);
    assert.match(shown[0]!, /commands are unavailable/i);
  });
});
