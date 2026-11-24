import assert from 'assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import proxyquire from 'proxyquire';
import * as redact from '../host/utils/redact';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

suite('salesforce exec failure redaction', () => {
  test('rejects without exposing command output when the redactor throws', async () => {
    const stdout = 'sample stdout';
    const stderr = 'sample stderr';
    const message = 'sample command failure';
    const logs: unknown[][] = [];
    const recordLog = (...args: unknown[]) => logs.push(args);
    const execModule = proxyquireStrict('../host/salesforce/exec', {
      '../utils/redact': {
        ...redact,
        redactSecrets: (text: string) => {
          if (text === stderr) throw new Error(`sample redactor failure: ${text}`);
          return text;
        }
      },
      '../utils/logger': { logTrace: recordLog, logWarn: recordLog },
      '../utils/localize': { localize: (_key: string, fallback: string) => fallback },
      '../../shared/telemetry': { safeSendEvent: () => undefined, safeSendException: () => undefined }
    }) as typeof import('../host/salesforce/exec');
    let finish: () => void = () => assert.fail('expected a child process');
    execModule.__setExecFileImplForTests((_file, _args, _options, callback) => {
      finish = () => callback(new Error(message), stdout, stderr);
      return new ChildProcess();
    });

    const result = execModule.execCommand('sf', ['org', 'list']);
    assert.doesNotThrow(finish);
    await assert.rejects(result, error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Command failed and its output could not be redacted.');
      for (const property of ['stdout', 'stderr', 'cause']) {
        assert.equal(property in error, false);
      }
      return true;
    });
    const logged = logs.flat().join(' ');
    for (const text of [stdout, stderr, message, 'sample redactor failure']) {
      assert.equal(logged.includes(text), false);
    }
  });
});

suite('salesforce exec telemetry', () => {
  test('emits cli.command telemetry when a CLI command succeeds', async () => {
    const events: Array<{
      name: string;
      properties?: Record<string, string>;
      measurements?: Record<string, number>;
    }> = [];

    const execModule = proxyquireStrict('../host/salesforce/exec', {
      'cross-spawn': (_file: string, _args: readonly string[] | undefined, _opts: any) => {
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
        safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
          events.push({ name, properties, measurements });
        },
        safeSendException: () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../host/salesforce/exec');

    const result = await execModule.execCommand('sf', ['org', 'display', '--json']);
    assert.equal(result.stdout, '{"status":0}');

    assert.equal(events.length, 1);
    assert.equal(events[0]?.name, 'cli.command');
    assert.deepEqual(events[0]?.properties, {
      command: 'sf',
      outcome: 'ok'
    });
    assert.equal(Number.isFinite(events[0]?.measurements?.durationMs), true);
  });
});
