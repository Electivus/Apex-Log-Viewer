import { strict as assert } from 'node:assert';
import { resolveBundledBinary } from '../../runtime/bundledBinary';
import { RuntimeClient } from '../../runtime/runtimeClient';

suite('runtime client', () => {
  test('resolves a platform specific bundled binary path', () => {
    const resolved = resolveBundledBinary('linux', 'x64');
    assert.equal(resolved.endsWith('bin/linux-x64/apex-log-viewer'), true);
  });

  test('tracks initialize capabilities from the daemon handshake', async () => {
    const writes: unknown[] = [];
    const client = new RuntimeClient({
      clientVersion: '0.1.0',
      createProcess: () => ({
        child: {} as never,
        onMessage: () => () => {},
        onExit: () => () => {},
        writeMessage: message => {
          writes.push(message);
        },
        dispose: () => {}
      })
    });
    const result = await client.initialize();

    assert.equal(result.protocol_version, '1');
    assert.equal(result.capabilities.orgs, true);
    assert.equal(writes.length, 1);
  });
});
