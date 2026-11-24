import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import proxyquire from 'proxyquire';

import { WEBVIEW_SESSION_MOUNT_DELAY_MS } from '../../provider/webviewSession';
import { FakeHost, formatLocalized, vscodeStub } from '../customLogsTestSupport';
import { FakeClock, createWebviewSessionForTest, settle } from '../webviewSessionTestSupport';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const GLOBAL_ORG = 'global@example.com';
const WORKSPACE_ORG = 'workspace@example.com';
const WORKSPACE_ALIAS = 'workspace-scratch';

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for Tail to load');
    await settle();
  }
}

/**
 * The `sf` CLI as a workspace sees it: run inside the project folder, `sf org list auth` marks the
 * project's target-org as the default; run anywhere else, the global one.
 */
function sfCli(workspace: string) {
  const runs: Array<{ command: string; cwd?: string }> = [];
  const execCommand = async (
    _program: string,
    args: string[],
    _env?: NodeJS.ProcessEnv,
    _timeoutMs?: number,
    _signal?: AbortSignal,
    cwd?: string
  ) => {
    const firstFlag = args.findIndex(arg => arg.startsWith('-'));
    const command = args.slice(0, firstFlag).join(' ');
    runs.push({ command, cwd });
    const reply = (result: unknown) => ({ stdout: JSON.stringify({ status: 0, result }), stderr: '' });
    if (command === 'org list auth') {
      const defaultOrg = cwd === workspace ? WORKSPACE_ORG : GLOBAL_ORG;
      return reply(
        [GLOBAL_ORG, WORKSPACE_ORG].map(username => ({
          username,
          alias: username === WORKSPACE_ORG ? WORKSPACE_ALIAS : '',
          instanceUrl: 'https://example.test',
          configs: username === defaultOrg ? ['target-org'] : []
        }))
      );
    }
    if (command === 'org auth show-access-token') return reply({ accessToken: 'token-tail' });
    throw new Error(`unexpected sf ${args.join(' ')}`);
  };
  const sfCliAuth = proxyquireStrict('../../host/salesforce/sfCliAuth', {
    './exec': { CLI_TIMEOUT_MS: 120_000, execCommand },
    './path': { getLoginShellEnv: async () => ({ ...process.env }) },
    './proxy': { readProxySettings: () => ({}) },
    '../utils/localize': {
      localize: (_key: string, message: string, ...args: unknown[]) =>
        message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
    }
  });
  return { runs, sfCliAuth };
}

suite('Tail opened before Logs', () => {
  let home: string;
  let workspace: string;

  setup(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alv-tail-org-')));
    workspace = path.join(home, 'project');
    fs.mkdirSync(workspace);
  });

  teardown(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('uses the workspace target-org, not a different global one, and Debug Flags inherits it', async () => {
    const clock = new FakeClock();
    const debugLevelOrgs: Array<string | undefined> = [];
    const debugFlagsShown: Array<{ selectedOrg?: string; sourceView?: string }> = [];
    const tailOrgs: Array<string | undefined> = [];
    const noEvent = () => ({ dispose: () => undefined });

    const sf = sfCli(workspace);
    const { runtimeClient } = proxyquireStrict('../../runtime/runtimeClient', {
      '../host/salesforce/sfCliAuth': sf.sfCliAuth,
      '../host/utils/workspace': { getWorkspaceRoot: () => workspace },
      '../shared/telemetry': { safeSendEvent: () => undefined },
      '../shared/telemetryErrorCodes': { getTelemetryErrorCode: () => 'TEST' }
    }) as typeof import('../../runtime/runtimeClient');

    const { SfLogTailViewProvider } = proxyquireStrict('../../provider/SfLogTailViewProvider', {
      vscode: {
        ...vscodeStub,
        workspace: { onDidChangeConfiguration: noEvent },
        window: { ...vscodeStub.window, state: { active: true }, onDidChangeWindowState: noEvent }
      },
      '../host/utils/localize': {
        localize: (_key: string, message: string, ...args: Array<string | number>) => formatLocalized(message, ...args)
      },
      '../host/salesforce/traceflags': {
        listDebugLevels: async (auth: { username?: string }) => {
          debugLevelOrgs.push(auth.username);
          return ['ALV_E2E'];
        },
        getActiveUserDebugLevel: async () => undefined,
        ensureDefaultTailDebugLevel: async () => {
          throw new Error('an org with debug levels never gets a default one');
        }
      },
      '../host/utils/logger': { logInfo: () => undefined, logWarn: () => undefined },
      '../host/utils/responsiveness': { recordInboundMessage: () => undefined },
      '../shared/telemetry': { safeSendEvent: () => undefined },
      '../shared/telemetryErrorCodes': { getTelemetryErrorCode: () => 'TEST' },
      '../host/utils/replayDebugger': { ensureReplayDebuggerAvailable: async () => true },
      '../host/utils/webviewHtml': { buildWebviewHtml: () => '<html></html>' },
      '../host/utils/tailService': {
        DEFAULT_TAIL_BUFFER_LINES: 10000,
        MAX_TAIL_BUFFER_LINES: 200000,
        MIN_TAIL_BUFFER_LINES: 1000,
        TailService: class {
          setOrg(username?: string) {
            tailOrgs.push(username);
          }
          setWindowActive() {}
          setBufferLimit() {}
          isRunning() {
            return false;
          }
          readonly bufferedLineCount = 0;
          getBufferedSnapshot() {
            return { streamId: 'test-tail', firstSeq: 0, lines: [] };
          }
          stop() {}
        }
      },
      '../host/utils/config': {
        getNumberConfig: (_key: string, fallback: number) => fallback,
        affectsConfiguration: () => false
      },
      '../panel/LogViewerPanel': { LogViewerPanel: {} },
      '../panel/DebugFlagsPanel': {
        DebugFlagsPanel: {
          show: async (options: { selectedOrg?: string; sourceView?: string }) => {
            debugFlagsShown.push(options);
          }
        }
      },
      '../runtime/runtimeClient': { runtimeClient },
      './webviewHost': { createWebviewViewHost: (view: unknown) => view },
      './webviewSession': { createWebviewSession: (options: never) => createWebviewSessionForTest(options, clock) }
    }) as typeof import('../../provider/SfLogTailViewProvider');

    const provider = new SfLogTailViewProvider({ extensionUri: {} } as never);
    const host = new FakeHost();
    provider.resolveWebviewView(host as never);
    await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    await host.emit({ type: 'ready', mountSequence: 1 });
    await until(() => host.last('debugLevels') !== undefined);

    assert.equal(host.last('orgs')?.selected, WORKSPACE_ORG);
    assert.equal(tailOrgs.at(-1), WORKSPACE_ORG);
    assert.deepEqual(debugLevelOrgs, [WORKSPACE_ORG], 'Tail reads debug levels only from the workspace org');

    await host.emit({ type: 'openDebugFlags' });

    assert.deepEqual(debugFlagsShown, [{ selectedOrg: WORKSPACE_ORG, sourceView: 'tail' }]);
    assert.ok(sf.runs.length > 0);
    assert.ok(
      sf.runs.every(run => run.cwd === workspace),
      'every sf run starts in the workspace folder'
    );
    provider.dispose();
    await runtimeClient.dispose();
  });
});
