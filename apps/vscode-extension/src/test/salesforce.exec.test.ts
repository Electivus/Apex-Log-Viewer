import assert from 'assert/strict';
import {
  __setExecFileImplForTests,
  __resetExecFileImplForTests,
  __resetExecDedupeCacheForTests,
  execCommand
} from '../host/salesforce/exec';
const proxyquire: any = require('proxyquire').noCallThru().noPreserveCache();

type ExecCall = { program: string; args: string[]; cwd?: string };

/** Every child exec.ts starts, answered with `stdout` once `release` is called, or at once. */
function recordExecs(stdout = '{"status":0,"result":{}}') {
  const calls: ExecCall[] = [];
  const pending: Array<() => void> = [];
  let held = false;
  __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, opts: any, cb: any) => {
    calls.push({ program, args: Array.isArray(args) ? [...args] : [], cwd: opts?.cwd });
    const answer = () => cb(null, stdout, '');
    if (held) pending.push(answer);
    else answer();
    return undefined as any;
  }) as any);
  return {
    calls,
    hold: () => {
      held = true;
    },
    release: () => pending.splice(0).forEach(answer => answer())
  };
}

suite('salesforce exec safety', () => {
  teardown(() => {
    __resetExecFileImplForTests();
    __resetExecDedupeCacheForTests();
  });

  test('passes alias with spaces/special chars as single argv', async () => {
    const alias = "My Alias; echo 'oops' | cat";
    const { calls } = recordExecs();

    await execCommand('sf', ['org', 'auth', 'show-access-token', '--target-org', alias, '--json']);

    assert.equal(calls[0]?.program, 'sf');
    const idx = calls[0]!.args.indexOf('--target-org');
    assert.ok(idx >= 0, 'expected --target-org flag to be present');
    assert.equal(calls[0]!.args[idx + 1], alias, 'alias should be single argv item, unchanged');
  });

  test('reports missing CLI when ENOENT is raised', async () => {
    __setExecFileImplForTests(((_program: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      const err: any = new Error('command not found');
      err.code = 'ENOENT';
      cb(err, '', '');
      return undefined as any;
    }) as any);

    await assert.rejects(execCommand('sf', ['org', 'list', 'auth', '--json']), (e: any) => {
      assert.equal(e?.code, 'ENOENT');
      assert.match(String(e?.message || ''), /CLI not found: sf org list auth --json/);
      return true;
    });
  });

  test('runs the child in the working directory it is given, and never shares a run across directories', async () => {
    const execs = recordExecs();
    execs.hold();

    const inProject = execCommand('sf', ['org', 'list', 'auth', '--json'], undefined, undefined, undefined, '/work/a');
    const sameProject = execCommand(
      'sf',
      ['org', 'list', 'auth', '--json'],
      undefined,
      undefined,
      undefined,
      '/work/a'
    );
    const otherProject = execCommand(
      'sf',
      ['org', 'list', 'auth', '--json'],
      undefined,
      undefined,
      undefined,
      '/work/b'
    );
    execs.release();
    await Promise.all([inProject, sameProject, otherProject]);

    assert.deepEqual(
      execs.calls.map(call => call.cwd),
      ['/work/a', '/work/b']
    );
  });

  test('spawns CLI children with stdin ignored', done => {
    const { EventEmitter } = require('events');
    let capturedOpts: any;

    const execModule = proxyquire('../host/salesforce/exec', {
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
      '../../shared/telemetry': {
        safeSendException: () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../host/salesforce/exec');

    execModule.execFileImpl('sf', ['org', 'display', '--json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }, error => {
      assert.ifError(error);
      assert.deepEqual(capturedOpts?.stdio, ['ignore', 'pipe', 'pipe']);
      done();
    });
  });
});
