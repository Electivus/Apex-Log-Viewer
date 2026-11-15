import assert from 'node:assert/strict';
import test from 'node:test';

import { StateAggregator } from '@salesforce/core';

import { createApexLogViewerCore } from '../src/index.ts';
import { ORG_ID, isolateSalesforceHome, startSalesforceDouble } from './support/salesforceDouble.ts';

isolateSalesforceHome();

// @salesforce/core 9.2 keeps a field's value from the auth file when the file's mtime is later than the stamp the
// in-memory change got, and stamps with performance.timeOrigin + performance.now(). That clock is anchored when the
// process starts, so it trails every new file time once the wall clock moves ahead of it: a clock step or time sync,
// a resume on Linux, whose monotonic clock stops while suspended, or Windows' coarse reading of the anchor.
function trailStampClock(t: test.TestContext, ms: number): void {
  const own = Object.getOwnPropertyDescriptor(globalThis.performance, 'timeOrigin');
  const origin = performance.timeOrigin - ms;
  Object.defineProperty(globalThis.performance, 'timeOrigin', { get: () => origin, configurable: true });
  t.after(() => {
    if (own) Object.defineProperty(globalThis.performance, 'timeOrigin', own);
    else delete (globalThis.performance as { timeOrigin?: number }).timeOrigin;
  });
}

test('each token refresh keeps its new tokens while the auth stamp clock trails the auth file by ten seconds', async t => {
  let issued = 0;
  let sessionExpired = false;
  const double = await startSalesforceDouble(t, request => {
    if (request.path === '/services/oauth2/token') {
      issued += 1;
      sessionExpired = false;
      return {
        body: {
          access_token: `token-${issued}`,
          refresh_token: `refresh-token-${issued}`,
          instance_url: double.instanceUrl,
          id: `${double.instanceUrl}/id/${ORG_ID}/005000000000001AAA`,
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          signature: 'signature-double'
        }
      };
    }
    if (sessionExpired) {
      return { status: 401, body: [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }] };
    }
    return { body: { totalSize: 0, done: true, records: [] } };
  });

  const username = 'refreshed-in-a-row@example.com';
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    instanceUrl: double.instanceUrl,
    loginUrl: double.instanceUrl,
    accessToken: 'token-0',
    refreshToken: 'refresh-token-0',
    clientId: 'PlatformCLI'
  });
  await state.orgs.write(username);
  trailStampClock(t, 10_000);

  const core = createApexLogViewerCore({ surface: 'cli' });
  t.after(() => core.dispose());

  const kept: { refreshed: string; stored: string; persisted?: string; persistedRefreshToken?: string }[] = [];
  for (let i = 1; i <= 5; i += 1) {
    sessionExpired = true;
    const refreshed = (await core.org.getAuth({ username, refresh: true })).accessToken;
    const stored = (await core.org.getAuth({ username })).accessToken;
    const persisted = await state.orgs.peek(username, true);
    kept.push({
      refreshed,
      stored,
      persisted: persisted?.accessToken,
      persistedRefreshToken: persisted?.refreshToken
    });
  }

  assert.equal(issued, 5, 'each refresh asked the token endpoint once');
  assert.deepEqual(
    kept,
    [1, 2, 3, 4, 5].map(i => ({
      refreshed: `token-${i}`,
      stored: `token-${i}`,
      persisted: `token-${i}`,
      persistedRefreshToken: `refresh-token-${i}`
    }))
  );
});
