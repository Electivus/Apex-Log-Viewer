import assert from 'assert/strict';
import * as net from 'net';
import { installNetworkGuard } from '../test/networkGuard';

class FakeRunnable {
  constructor(private readonly title: string) {}
  fullTitle(): string {
    return this.title;
  }
  run(body: () => void): void {
    body();
  }
}

suite('network guard', () => {
  const originalConnect = net.Socket.prototype.connect;
  const originalRun = FakeRunnable.prototype.run;

  teardown(() => {
    net.Socket.prototype.connect = originalConnect;
    FakeRunnable.prototype.run = originalRun;
  });

  function dial(title: string, host: string): readonly string[] {
    const violations = installNetworkGuard(FakeRunnable as never);
    new FakeRunnable(title).run(() => {
      const socket = new net.Socket();
      socket.on('error', () => {});
      socket.connect({ host, port: 9 });
      socket.destroy();
    });
    return violations;
  }

  for (const host of [
    'localhost',
    'LOCALHOST',
    'localhost.',
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '::',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1'
  ]) {
    test(`allows ${host}`, () => {
      assert.deepEqual(dial('unit test', host), []);
    });
  }

  for (const host of ['example.com', '10.0.0.1', '128.0.0.1', '2001:db8::1', '::ffff:10.0.0.1']) {
    test(`refuses ${host}`, () => {
      assert.deepEqual(dial('unit test', host), [`unit test -> ${host}:9`]);
    });
  }

  test('lets integration tests connect anywhere', () => {
    assert.deepEqual(dial('integration: reaches out', 'example.com'), []);
  });
});
