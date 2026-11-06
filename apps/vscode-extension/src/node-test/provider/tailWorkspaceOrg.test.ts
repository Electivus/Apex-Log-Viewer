import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import proxyquire from 'proxyquire';

import { WEBVIEW_SESSION_MOUNT_DELAY_MS } from '../../provider/webviewSession';
import { FakeHost, formatLocalized, vscodeStub } from '../customLogsTestSupport';
import { FakeClock, createWebviewSessionForTest, settle } from '../webviewSessionTestSupport';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();
const coreRequire = createRequire(path.resolve(__dirname, '../../../../../packages/core/package.json'));
const { StateAggregator } = coreRequire('@salesforce/core');

const GLOBAL_ORG = 'global@example.com';
const WORKSPACE_ORG = 'workspace@example.com';
const WORKSPACE_ALIAS = 'workspace-scratch';

async function saveOrgs(): Promise<void> {
  await StateAggregator.clearInstanceAsync();
  const state = await StateAggregator.getInstance();
  for (const username of [GLOBAL_ORG, WORKSPACE_ORG]) {
    state.orgs.set(username, {
      username,
      orgId: '00D000000000001AAA',
      instanceUrl: 'https://example.test',
      loginUrl: 'https://example.test',
      accessToken: `token-${username}`
    });
    await state.orgs.write(username);
  }
  await state.aliases.setAndSave(WORKSPACE_ALIAS, WORKSPACE_ORG);
}

function writeTargetOrg(root: string, targetOrg: string): void {
  fs.mkdirSync(path.join(root, '.sf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sf', 'config.json'), JSON.stringify({ 'target-org': targetOrg }));
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for Tail to load');
    await settle();
  }
}

suite('Tail opened before Logs', () => {
  const saved = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    keychain: process.env.SF_USE_GENERIC_UNIX_KEYCHAIN,
    disableLogFile: process.env.SF_DISABLE_LOG_FILE
  };
  let home: string;
  let workspace: string;

  setup(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alv-tail-org-')));
    workspace = path.join(home, 'project');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.SF_USE_GENERIC_UNIX_KEYCHAIN = 'true';
    // The extension sets this at activation. Without it, @salesforce/core's logger starts a worker thread that creates
    // .sf/sf-<date>.log under this temporary home whenever it gets to it, which can be while teardown deletes the home.
    process.env.SF_DISABLE_LOG_FILE = 'true';
    await saveOrgs();
    writeTargetOrg(home, GLOBAL_ORG);
    writeTargetOrg(workspace, WORKSPACE_ALIAS);
  });

  teardown(async () => {
    await StateAggregator.clearInstanceAsync();
    process.env.HOME = saved.home;
    process.env.USERPROFILE = saved.userProfile;
    if (saved.keychain === undefined) {
      delete process.env.SF_USE_GENERIC_UNIX_KEYCHAIN;
    } else {
      process.env.SF_USE_GENERIC_UNIX_KEYCHAIN = saved.keychain;
    }
    if (saved.disableLogFile === undefined) {
      delete process.env.SF_DISABLE_LOG_FILE;
    } else {
      process.env.SF_DISABLE_LOG_FILE = saved.disableLogFile;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('uses the workspace target-org, not a different global one, and Debug Flags inherits it', async () => {
    const clock = new FakeClock();
    const debugLevelOrgs: Array<string | undefined> = [];
    const debugFlagsShown: Array<{ selectedOrg?: string; sourceView?: string }> = [];
    const tailOrgs: Array<string | undefined> = [];
    const noEvent = () => ({ dispose: () => undefined });

    const { runtimeClient } = proxyquireStrict('../../runtime/runtimeClient', {
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
          getBufferedLines() {
            return [];
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
    provider.dispose();
    await runtimeClient.dispose();
  });
});
