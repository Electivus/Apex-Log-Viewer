import assert from 'assert/strict';
import { EventEmitter } from 'node:events';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (chunk: string) => boolean };
  killed: boolean;
  kill: () => boolean;
};

function createFakeChild(): { child: FakeChild; writes: string[] } {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes: string[] = [];
  child.stdin = {
    write(chunk: string) {
      writes.push(chunk);
      return true;
    }
  };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return { child, writes };
}

function loadCreateDaemonProcess(spawnImpl: () => FakeChild) {
  const module = proxyquireStrict('../../../../../packages/app-server-client-ts/src/daemonProcess', {
    'node:child_process': {
      spawn: spawnImpl
    }
  }) as typeof import('../../../../../packages/app-server-client-ts/src/daemonProcess');
  return module.createDaemonProcess;
}

suite('daemon process transport', () => {
  test('surfaces child process spawn errors through onError', () => {
    const { child } = createFakeChild();
    const createDaemonProcess = loadCreateDaemonProcess(() => child);
    const daemon = createDaemonProcess('/bin/apex-log-viewer', ['app-server', '--stdio']);
    const seen: Error[] = [];
    daemon.onError(error => {
      seen.push(error);
    });

    child.emit('error', new Error('ENOENT'));

    assert.equal(seen.length, 1);
    assert.match(seen[0]?.message ?? '', /runtime exited \(process error: ENOENT\)/);
  });

  test('turns malformed stdout frames into handled daemon errors instead of throwing', () => {
    const { child } = createFakeChild();
    const createDaemonProcess = loadCreateDaemonProcess(() => child);
    const daemon = createDaemonProcess('/bin/apex-log-viewer', ['app-server', '--stdio']);
    const seen: Error[] = [];
    daemon.onError(error => {
      seen.push(error);
    });

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":"ok","result":true}\nnot-json\n', 'utf8'));

    assert.equal(seen.length, 1);
    assert.match(seen[0]?.message ?? '', /runtime exited \(protocol error:/);
    assert.equal(child.killed, true);
  });

  test('preserves UTF-8 characters split across stdout chunks', () => {
    const { child } = createFakeChild();
    const createDaemonProcess = loadCreateDaemonProcess(() => child);
    const daemon = createDaemonProcess('/bin/apex-log-viewer', ['app-server', '--stdio']);
    const messages: unknown[] = [];
    daemon.onMessage(message => {
      messages.push(message);
    });

    const prefix = Buffer.from('{"jsonrpc":"2.0","id":"msg-1","result":{"text":"', 'utf8');
    const emoji = Buffer.from('😀', 'utf8');
    const suffix = Buffer.from('"}}\n', 'utf8');
    child.stdout.emit('data', Buffer.concat([prefix, emoji.subarray(0, 2)]));
    child.stdout.emit('data', Buffer.concat([emoji.subarray(2), suffix]));

    assert.deepEqual(messages, [
      {
        jsonrpc: '2.0',
        id: 'msg-1',
        result: {
          text: '😀'
        }
      }
    ]);
  });
});
