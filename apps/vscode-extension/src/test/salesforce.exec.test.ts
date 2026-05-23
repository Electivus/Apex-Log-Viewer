import assert from 'assert/strict';
import { getOrgAuth, __resetOrgAuthCacheForTests } from '../../../../src/salesforce/cli';
import {
  __setExecFileImplForTests,
  __resetExecFileImplForTests,
  __resetExecDedupeCacheForTests
} from '../../../../src/salesforce/exec';
const proxyquire: any = require('proxyquire').noCallThru().noPreserveCache();

suite('salesforce exec safety', () => {
  teardown(() => {
    __resetExecFileImplForTests();
    __resetExecDedupeCacheForTests();
    __resetOrgAuthCacheForTests();
  });

  test('passes alias with spaces/special chars as single argv', async () => {
    const alias = "My Alias; echo 'oops' | cat";
    const calls: Array<{ program: string; args: string[] }> = [];

    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      const argList = Array.isArray(args) ? [...args] : [];
      calls.push({ program, args: argList });
      const stdout =
        argList[0] === 'org' && argList[1] === 'auth'
          ? JSON.stringify({ result: { accessToken: 'token' } })
          : JSON.stringify({
              result: {
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

    assert.equal(calls[0]?.program, 'sf');
    assert.equal(calls[1]?.program, 'sf');
    for (const call of calls) {
      const idx = call.args.indexOf('--target-org');
      assert.ok(idx >= 0, 'expected --target-org flag to be present');
      assert.equal(call.args[idx + 1], alias, 'alias should be single argv item, unchanged');
    }
  });

  test('reports missing CLI when ENOENT is raised', async () => {
    __setExecFileImplForTests(((_program: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      const err: any = new Error('command not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    // Should surface a friendly error after exhausting sf candidates
    await assert.rejects(getOrgAuth(undefined), (e: any) => {
      assert.match(String(e?.message || ''), /CLI não encontrada|CLI not found|Salesforce CLI/);
      return true;
    });
  });

  test('uses explicit access-token command when org display redacts secrets', async () => {
    const calls: string[] = [];
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      const argList = Array.isArray(args) ? [...args] : [];
      calls.push(`${program} ${argList.join(' ')}`);
      if (argList.join(' ') === 'org display --json --target-org ALV') {
        cb(
          null,
          JSON.stringify({
            result: {
              accessToken: "[REDACTED] Use 'sf org auth show-access-token' to view",
              instanceUrl: 'https://example.my.salesforce.com',
              username: 'user@example.com'
            }
          }),
          ''
        );
        return undefined as any;
      }
      if (argList.join(' ') === 'org auth show-access-token --json --no-prompt --target-org ALV') {
        cb(null, JSON.stringify({ result: { accessToken: 'fresh-token' } }), '');
        return undefined as any;
      }
      cb(new Error('unexpected command'), '', '');
      return undefined as any;
    }) as any);

    const auth = await getOrgAuth('ALV');
    assert.equal(auth.accessToken, 'fresh-token');
    assert.equal(auth.instanceUrl, 'https://example.my.salesforce.com');
    assert.deepEqual(calls, [
      'sf org display --json --target-org ALV',
      'sf org auth show-access-token --json --no-prompt --target-org ALV'
    ]);
  });

  test('falls back to legacy display when explicit access-token command is unavailable', async () => {
    const calls: string[] = [];
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      const argList = Array.isArray(args) ? [...args] : [];
      calls.push(`${program} ${argList.join(' ')}`);
      if (argList.join(' ') === 'org display --json --target-org ALV') {
        cb(null, JSON.stringify({ result: { instanceUrl: 'https://example.my.salesforce.com' } }), '');
        return undefined as any;
      }
      if (argList.join(' ') === 'org auth show-access-token --json --no-prompt --target-org ALV') {
        const err: any = new Error('not a sf command');
        err.code = 1;
        cb(err, '', 'not a sf command');
        return undefined as any;
      }
      if (argList.join(' ') === 'org display --json --verbose --target-org ALV') {
        cb(
          null,
          JSON.stringify({
            result: {
              accessToken: 'legacy-token',
              instanceUrl: 'https://legacy.example.com',
              username: 'legacy@example.com'
            }
          }),
          ''
        );
        return undefined as any;
      }
      cb(new Error('unexpected command'), '', '');
      return undefined as any;
    }) as any);

    const auth = await getOrgAuth('ALV');
    assert.equal(auth.accessToken, 'legacy-token');
    assert.equal(auth.instanceUrl, 'https://legacy.example.com');
    assert.equal(calls[2], 'sf org display --json --verbose --target-org ALV');
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
