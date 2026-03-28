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

  test('logsList, searchQuery, and logsTriage use runtime request methods', async () => {
    const methods: string[] = [];
    const client = new RuntimeClient({
      requestHandler: async (method, params) => {
        methods.push(method);
        if (method === 'logs/list') {
          assert.deepEqual(params, {
            username: 'demo@example.com',
            limit: 25,
            cursor: {
              beforeStartTime: '2026-03-27T12:00:00.000Z',
              beforeId: '07L000000000001AA'
            }
          });
          return [
            {
              Id: '07L000000000001AA',
              StartTime: '2026-03-27T12:00:00.000Z',
              Operation: 'Execute Anonymous',
              Application: 'Apex',
              DurationMilliseconds: 12,
              Status: 'Success',
              Request: 'API',
              LogLength: 123
            }
          ] as never;
        }
        if (method === 'search/query') {
          assert.deepEqual(params, {
            username: 'demo@example.com',
            query: 'NullPointerException',
            logIds: ['07L000000000001AA']
          });
          return {
            logIds: ['07L000000000001AA'],
            snippets: {
              '07L000000000001AA': {
                text: 'System.NullPointerException: Attempt to de-reference a null object',
                ranges: [[7, 27]]
              }
            },
            pendingLogIds: []
          } as never;
        }
        if (method === 'logs/triage') {
          assert.deepEqual(params, {
            username: 'demo@example.com',
            logIds: ['07L000000000001AA']
          });
          return [
            {
              logId: '07L000000000001AA',
              summary: {
                hasErrors: true,
                primaryReason: 'Fatal exception',
                reasons: [
                  {
                    code: 'fatal_exception',
                    severity: 'error',
                    summary: 'Fatal exception',
                    line: 3,
                    eventType: 'EXCEPTION_THROWN'
                  }
                ]
              }
            }
          ] as never;
        }
        throw new Error(`unexpected method: ${method}`);
      }
    });

    const logs = await client.logsList({
      username: 'demo@example.com',
      limit: 25,
      cursor: {
        beforeStartTime: '2026-03-27T12:00:00.000Z',
        beforeId: '07L000000000001AA'
      }
    });
    const searchResult = await client.searchQuery({
      username: 'demo@example.com',
      query: 'NullPointerException',
      logIds: ['07L000000000001AA']
    });
    const triageEntries = await client.logsTriage({
      username: 'demo@example.com',
      logIds: ['07L000000000001AA']
    });

    assert.deepEqual(methods, ['logs/list', 'search/query', 'logs/triage']);
    assert.equal(logs[0]?.Id, '07L000000000001AA');
    assert.equal(searchResult.logIds[0], '07L000000000001AA');
    assert.equal(searchResult.snippets?.['07L000000000001AA']?.ranges[0]?.[0], 7);
    assert.equal(triageEntries[0]?.summary.primaryReason, 'Fatal exception');
  });
});
