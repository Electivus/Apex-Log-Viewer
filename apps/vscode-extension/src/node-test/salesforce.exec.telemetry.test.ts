import assert from 'assert/strict';
import { EventEmitter } from 'node:events';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

suite('salesforce exec telemetry', () => {
  test('emits cli.command telemetry when a CLI command succeeds', async () => {
    const events: Array<{
      name: string;
      properties?: Record<string, string>;
      measurements?: Record<string, number>;
    }> = [];

    const execModule = proxyquireStrict('../../../../src/salesforce/exec', {
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
      '../../apps/vscode-extension/src/shared/telemetry': {
        safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
          events.push({ name, properties, measurements });
        },
        safeSendException: () => undefined,
        '@noCallThru': true
      }
    }) as typeof import('../../../../src/salesforce/exec');

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
