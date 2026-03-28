import assert from 'assert/strict';
import { getOrgAuth } from '../../../../src/salesforce/cli';
import { __setExecFileImplForTests, __resetExecFileImplForTests } from '../../../../src/salesforce/exec';
const proxyquire: any = require('proxyquire').noCallThru().noPreserveCache();

suite('salesforce exec safety', () => {
  teardown(() => {
    __resetExecFileImplForTests();
  });

  test('passes alias with spaces/special chars as single argv', async () => {
    const alias = "My Alias; echo 'oops' | cat";
    let capturedProgram: string | undefined;
    let capturedArgs: readonly string[] | undefined;

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      capturedProgram = program;
      capturedArgs = args;
      // Return a minimal successful JSON payload similar to sf/sfdx
      const stdout = JSON.stringify({
        result: {
          accessToken: 'token',
          instanceUrl: 'https://example.my.salesforce.com',
          username: 'user@example.com'
        }
      });
      cb(null, stdout, '');
      return undefined as any;
    }) as any);

    const auth = await getOrgAuth(alias);
    assert.equal(auth.instanceUrl, 'https://example.my.salesforce.com');
    assert.equal(auth.accessToken, 'token');

    assert.equal(capturedProgram, 'sf');
    assert.ok(Array.isArray(capturedArgs));
    const args = capturedArgs as string[];
    // Ensure -o and the exact alias value are consecutive args
    const idx = args.indexOf('-o');
    assert.ok(idx >= 0, 'expected -o flag to be present');
    assert.equal(args[idx + 1], alias, 'alias should be single argv item, unchanged');
  });

  test('reports missing CLI when ENOENT is raised', async () => {
    __setExecFileImplForTests(((_program: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      const err: any = new Error('command not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    // Should surface a friendly error after trying both sf and sfdx
    await assert.rejects(getOrgAuth(undefined), (e: any) => {
      assert.match(String(e?.message || ''), /CLI não encontrada|CLI not found|Salesforce CLI/);
      return true;
    });
  });

  test('spawns CLI children with stdin ignored', done => {
    const { EventEmitter } = require('events');
    let capturedOpts: any;

    const execModule = proxyquire('../../../../src/salesforce/exec', {
      'cross-spawn': (_file: string, _args: readonly string[] | undefined, opts: any) => {
        capturedOpts = opts;
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stdout.setEncoding = () => {};
        child.stderr = new EventEmitter();
        child.stderr.setEncoding = () => {};
        process.nextTick(() => {
          child.stdout.emit('data', '{"status":0}');
          child.emit('close', 0, null);
        });
        return child;
      },
      '../utils/logger': { logTrace: () => undefined, logWarn: () => undefined, '@noCallThru': true },
      '../utils/localize': { localize: (_key: string, fallback: string) => fallback, '@noCallThru': true },
      '../../apps/vscode-extension/src/shared/telemetry': {
        safeSendException: () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../../../../src/salesforce/exec');

    execModule.execFileImpl(
      'sf',
      ['org', 'display', '--json'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      error => {
        assert.ifError(error);
        assert.deepEqual(capturedOpts?.stdio, ['ignore', 'pipe', 'pipe']);
        done();
      }
    );
  });
});
