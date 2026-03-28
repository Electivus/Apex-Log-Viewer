import { strict as assert } from 'node:assert';
import { resolveBundledBinary } from '../../runtime/bundledBinary';
import { RuntimeClient } from '../../runtime/runtimeClient';

suite('runtime client', () => {
  test('resolves a platform specific bundled binary path', () => {
    const resolved = resolveBundledBinary('linux', 'x64');
    assert.equal(resolved.endsWith('bin/linux-x64/apex-log-viewer'), true);
  });

  test('tracks initialize capabilities from the daemon handshake', async () => {
    const client = new RuntimeClient({
      clientVersion: '0.1.0',
      requestHandler: async method => {
        assert.equal(method, 'initialize');
        return {
          runtime_version: '0.1.0',
          protocol_version: '1',
          platform: 'linux',
          arch: 'x64',
          capabilities: {
            orgs: true,
            logs: true,
            search: true,
            tail: true,
            debug_flags: true,
            doctor: true
          },
          state_dir: '.alv/state',
          cache_dir: '.alv/cache'
        };
      }
    });
    const result = await client.initialize();

    assert.equal(result.protocol_version, '1');
    assert.equal(result.capabilities.orgs, true);
  });

  test('orgList and getOrgAuth use runtime request methods', async () => {
    const methods: string[] = [];
    const client = new RuntimeClient({
      requestHandler: async (method, params) => {
        methods.push(method);
        if (method === 'org/list') {
          return [
            {
              username: 'demo@example.com',
              alias: 'Demo',
              isDefaultUsername: true
            }
          ] as never;
        }
        if (method === 'org/auth') {
          return {
            username: (params as { username?: string }).username,
            instanceUrl: 'https://example.my.salesforce.com',
            accessToken: 'token'
          } as never;
        }
        throw new Error(`unexpected method: ${method}`);
      }
    });

    const orgs = await client.orgList({ forceRefresh: true });
    const auth = await client.getOrgAuth({ username: 'demo@example.com' });

    assert.deepEqual(methods, ['org/list', 'org/auth']);
    assert.equal(orgs[0]?.username, 'demo@example.com');
    assert.equal(auth.username, 'demo@example.com');
  });
});
