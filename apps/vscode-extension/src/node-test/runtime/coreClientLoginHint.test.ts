import assert from 'node:assert/strict';
import { mock } from 'node:test';
import proxyquire from 'proxyquire';

import { AlvError, type ApexLogViewerCore } from '@alv/core';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const LOGIN_REQUIRED =
  'Salesforce rejected the session of dev@example.com and the Salesforce CLI has no other. Run "sf org login web" to log in again.';

/** A `--version` that never answers: the scripted exec then rejects when its timeout passes, as the real one does. */
const HANGS = Symbol('hangs');

/**
 * The extension's core client over a core that fails as `failure` says, with the real `sf` auth source over a
 * scripted `sf` whose `--version` prints `version`. Every `sf` run is recorded.
 */
function load(options: { version: string | typeof HANGS; failure?: unknown }) {
  const runs: string[][] = [];
  const sfCliAuth = proxyquireStrict('../../host/salesforce/sfCliAuth', {
    './exec': {
      CLI_TIMEOUT_MS: 120_000,
      execCommand: async (_program: string, args: string[], _env: unknown, timeoutMs: number) => {
        runs.push(args);
        if (args[0] === '--version' && options.version === HANGS) {
          return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('sf timed out')), timeoutMs));
        }
        if (args[0] === '--version') return { stdout: `${String(options.version)}\n`, stderr: '' };
        throw new Error(`unexpected sf ${args.join(' ')}`);
      }
    },
    './path': { getLoginShellEnv: async () => ({ PATH: '/usr/bin' }) },
    './proxy': { readProxySettings: () => ({}) },
    '../utils/localize': {
      localize: (_key: string, message: string, ...args: unknown[]) =>
        message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
    }
  });
  const { CoreClient } = proxyquireStrict('../../runtime/runtimeClient', {
    '../host/salesforce/sfCliAuth': sfCliAuth,
    '../host/utils/workspace': { getWorkspaceRoot: () => undefined },
    '../shared/telemetry': { safeSendEvent: () => undefined },
    '../shared/telemetryErrorCodes': { getTelemetryErrorCode: () => 'TEST' }
  }) as typeof import('../../runtime/runtimeClient');
  const core = {
    log: {
      list: async () => {
        if (options.failure) throw options.failure;
        return [];
      }
    }
  } as unknown as ApexLogViewerCore;
  return { client: new CoreClient({ core }), runs };
}

const loginRequired = () => new AlvError('AUTH_REQUIRED', LOGIN_REQUIRED);

suite('core client: a new login with an sf older than 2.152.9', () => {
  test('the login request also names the installed sf, the release that keeps the login, and how to update', async () => {
    const { client, runs } = load({
      version: '@salesforce/cli/2.152.8 darwin-arm64 node-v24.22.2',
      failure: loginRequired()
    });

    const error = (await client.logsList().then(
      () => assert.fail('logsList should fail'),
      (rejection: unknown) => rejection
    )) as AlvError;

    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.ok(error.message.startsWith(LOGIN_REQUIRED), "core's request to log in comes first");
    assert.match(error.message, /2\.152\.8/);
    assert.match(error.message, /2\.152\.9/);
    assert.match(error.message, /"sf update"/);
    assert.match(error.message, /npm install --global @salesforce\/cli/);
    assert.deepEqual(runs, [['--version']], 'one sf --version, read after the failure');
  });

  for (const version of [
    '@salesforce/cli/2.152.9 darwin-arm64 node-v24.22.2',
    '@salesforce/cli/2.158.7 win32-x64 node-v24.22.2',
    'unexpected output'
  ]) {
    test(`with "${version}" the login request is core's alone`, async () => {
      const { client } = load({ version, failure: loginRequired() });

      await assert.rejects(client.logsList(), (error: AlvError) => {
        assert.equal(error.code, 'AUTH_REQUIRED');
        assert.equal(error.message, LOGIN_REQUIRED);
        return true;
      });
    });
  }

  test('a sf --version that never answers holds the login request back no more than 10 seconds', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { client } = load({ version: HANGS, failure: loginRequired() });
      let settled: unknown;
      void client.logsList().then(
        () => (settled = 'resolved'),
        (rejection: unknown) => (settled = rejection)
      );
      for (let elapsed = 0; elapsed < 10_000 && settled === undefined; elapsed += 250) {
        await new Promise(resolve => setImmediate(resolve));
        mock.timers.tick(250);
      }
      await new Promise(resolve => setImmediate(resolve));

      assert.notEqual(settled, undefined, 'the login request has arrived within 10 seconds');
      const error = settled as AlvError;
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.equal(error.message, LOGIN_REQUIRED, 'without the hint the CLI never gave');
    } finally {
      mock.timers.reset();
    }
  });

  test('a success or another failure never runs sf --version', async () => {
    const success = load({ version: '@salesforce/cli/2.136.5 darwin-arm64 node-v24.22.2' });
    assert.deepEqual(await success.client.logsList(), []);

    const other = load({
      version: '@salesforce/cli/2.136.5 darwin-arm64 node-v24.22.2',
      failure: new AlvError('SF_CLI_FAILED', 'sf failed')
    });
    await assert.rejects(other.client.logsList(), /sf failed/);

    assert.deepEqual([...success.runs, ...other.runs], []);
  });
});
