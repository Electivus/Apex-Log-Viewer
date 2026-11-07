import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

function loadDebugFlagsPanel() {
  return proxyquireStrict('../../panel/DebugFlagsPanel', {
    vscode: {},
    '../host/salesforce/traceflags': {},
    '../host/services/apexLogCleanup': {},
    '../host/utils/localize': { localize: (_key: string, message: string) => message },
    '../host/utils/logsCleanup': {},
    '../host/utils/logger': { logInfo: () => undefined, logWarn: () => undefined },
    '../host/utils/responsiveness': { recordInboundMessage: () => undefined },
    '../host/utils/webviewHtml': { buildWebviewHtml: () => '' },
    '../shared/telemetry': { safeSendEvent: () => undefined },
    '../runtime/runtimeClient': { runtimeClient: {} }
  }) as typeof import('../../panel/DebugFlagsPanel');
}

suite('the authenticated user in a truncated user list', () => {
  const user = (name: string, username: string) => ({ id: `005${name}`.padEnd(18, 'A'), name, username, active: true });
  const page = (size: number) => Array.from({ length: size }, (_, i) => user(`U${i}`, `u${i}@example.com`));

  const search = async (query: string, firstPage: ReturnType<typeof page>, ownLookup: ReturnType<typeof page>) => {
    const { DebugFlagsPanel } = loadDebugFlagsPanel();
    const queries: string[] = [];
    const panelLike = {
      searchUsersOnce: async (_auth: unknown, q: string) => {
        queries.push(q);
        return q === 'me@example.com' ? ownLookup : firstPage;
      }
    };
    const users = await (DebugFlagsPanel as any).prototype.searchUsersWithRuntimeFallback.call(
      panelLike,
      { username: 'Me@Example.com' },
      query,
      50
    );
    return { users, queries };
  };

  test('is fetched and put first when the name-ordered page cut them off', async () => {
    const me = user('Zed', 'me@example.com');
    const { users, queries } = await search('', page(50), [me]);
    assert.deepEqual(queries, ['', 'me@example.com']);
    assert.equal(users.length, 50);
    assert.equal(users[0].username, 'me@example.com');
  });

  test('is not fetched again when the page already has them, or lists every active user', async () => {
    const me = user('Zed', 'me@example.com');
    assert.deepEqual((await search('', [...page(49), me], [me])).queries, ['']);
    assert.deepEqual((await search('', page(10), [me])).queries, ['']);
  });

  test('is left out of a search the user typed', async () => {
    const me = user('Zed', 'me@example.com');
    assert.deepEqual((await search('u1', page(50), [me])).queries, ['u1']);
  });

  test('is not invented when the lookup finds another user', async () => {
    const { users } = await search('', page(50), [user('Other', 'other@example.com')]);
    assert.equal(users.length, 50);
    assert.equal(users[0].username, 'u0@example.com');
  });
});
