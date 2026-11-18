import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { AlvError, createApexLogViewerCore } from '../src/index.ts';
import { authSourceDouble, saveOrgAuth } from './support/salesforceDouble.ts';

const recordsBySobject: Record<string, Record<string, unknown>> = {
  ApexLog: {
    Id: '07L000000000001AAA',
    StartTime: '2026-10-14T09:00:00.000+0000',
    Operation: 'API',
    Application: 'Unknown',
    DurationMilliseconds: 12,
    Status: 'Success',
    Request: 'API',
    LogLength: 2048,
    LogUser: { Name: 'Demo User' }
  },
  ApexClass: { Id: '01p000000000001AAA', Name: 'OrderService' },
  DebugLevel: {
    Id: '7dl000000000001AAA',
    DeveloperName: 'ALV_DEBUG',
    MasterLabel: 'ALV Debug',
    Language: 'en_US',
    Workflow: 'INFO',
    Validation: 'INFO',
    Callout: 'INFO',
    ApexCode: 'FINEST',
    ApexProfiling: 'INFO',
    Visualforce: 'INFO',
    System: 'DEBUG',
    Database: 'INFO',
    Wave: 'INFO',
    Nba: 'INFO',
    DataAccess: 'INFO'
  },
  User: { Id: '005000000000001AAA', Name: 'Demo User', Username: 'demo@example.com', IsActive: true }
};

const debugLevel = {
  id: '7dl000000000001AAA',
  developerName: 'ALV_DEBUG',
  masterLabel: 'ALV Debug',
  language: 'en_US',
  workflow: 'INFO',
  validation: 'INFO',
  callout: 'INFO',
  apexCode: 'FINEST',
  apexProfiling: 'INFO',
  visualforce: 'INFO',
  system: 'DEBUG',
  database: 'INFO',
  wave: 'INFO',
  nba: 'INFO',
  dataAccess: 'INFO'
};

type SalesforceDouble = {
  instanceUrl: string;
  acceptedTokens: Set<string>;
  requestCount: () => number;
  versionListRequests: () => number;
  tokenRefreshRequests: () => number;
  queryTokens: () => string[];
  deleteTokens: () => string[];
  holdVersionList: () => () => void;
  holdQueries: () => () => void;
};

type Route = 'versionList' | 'tokenRefresh' | 'query' | 'delete' | 'other';

function routeOf(method: string | undefined, pathname: string): Route {
  if (pathname === '/services/data') return 'versionList';
  if (pathname === '/services/oauth2/token') return 'tokenRefresh';
  if (method === 'DELETE') return 'delete';
  return pathname.endsWith('/query') ? 'query' : 'other';
}

/** An org that accepts only `acceptedTokens`. Its OAuth endpoint refuses everyone: only the auth source renews. */
async function startSalesforceDouble(t: test.TestContext, acceptedTokens: string[]): Promise<SalesforceDouble> {
  const requests: Array<{ route: Route; token: string }> = [];
  const accepted = new Set(acceptedTokens);
  const gates = new Map<Route, Promise<void>>();
  const hold = (route: Route) => (): (() => void) => {
    let release!: () => void;
    gates.set(
      route,
      new Promise(resolve => {
        release = resolve;
      })
    );
    return release;
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    const route = routeOf(request.method, url.pathname);
    requests.push({ route, token });
    const send = (status: number, body: unknown): void => {
      void (gates.get(route) ?? Promise.resolve()).then(() => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    };
    if (route === 'versionList') {
      send(200, [{ label: "Spring '25", url: '/services/data/v63.0', version: '63.0' }]);
      return;
    }
    if (route === 'tokenRefresh') {
      send(400, { error: 'invalid_grant', error_description: 'expired access/refresh token' });
      return;
    }
    if (!accepted.has(token)) {
      send(401, [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
      return;
    }
    if (route === 'delete') {
      send(
        200,
        (url.searchParams.get('ids') ?? '').split(',').map(id => ({ id, success: true, errors: [] }))
      );
      return;
    }
    const sobject = /\bFROM\s+(\w+)/i.exec(url.searchParams.get('q') ?? '')?.[1] ?? '';
    send(200, { totalSize: 1, done: true, records: [recordsBySobject[sobject]] });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return {
    instanceUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    acceptedTokens: accepted,
    requestCount: () => requests.length,
    versionListRequests: () => requests.filter(request => request.route === 'versionList').length,
    tokenRefreshRequests: () => requests.filter(request => request.route === 'tokenRefresh').length,
    queryTokens: () => requests.filter(request => request.route === 'query').map(request => request.token),
    deleteTokens: () => requests.filter(request => request.route === 'delete').map(request => request.token),
    holdVersionList: hold('versionList'),
    holdQueries: hold('query')
  };
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise(resolve => setImmediate(resolve));
}

/** Salesforce stops accepting every token it knew, as after a revoked or expired session. */
function revokeSessions(salesforce: SalesforceDouble, ...replacements: string[]): void {
  salesforce.acceptedTokens.clear();
  for (const token of replacements) salesforce.acceptedTokens.add(token);
}

const isAuthRequired = (error: unknown) => error instanceof AlvError && error.code === 'AUTH_REQUIRED';

test('five operations against one org ask the auth source for one session and look up the API version once', async t => {
  const username = 'reuse@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-reuse']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-reuse');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  const resolved = await core.org.resolve({ targetOrg: username });
  const logs = await core.log.list({ username, limit: 1 });
  const debugLevels = await core.debugLevel.list({ targetOrg: username });
  const users = await core.user.search({ targetOrg: username, query: 'Demo' });
  const classes = await core.tooling.query({ targetOrg: username, soql: 'SELECT Id, Name FROM ApexClass' });

  assert.deepEqual(resolved, {
    requested: username,
    username,
    alias: undefined,
    instanceUrl: salesforce.instanceUrl,
    source: 'username'
  });
  assert.deepEqual(logs, [
    {
      id: '07L000000000001AAA',
      startTime: '2026-10-14T09:00:00.000+0000',
      operation: 'API',
      application: 'Unknown',
      durationMilliseconds: 12,
      status: 'Success',
      request: 'API',
      logLength: 2048,
      logUser: { name: 'Demo User' }
    }
  ]);
  assert.deepEqual(debugLevels, [debugLevel]);
  assert.deepEqual(users, {
    users: [{ id: '005000000000001AAA', name: 'Demo User', username: 'demo@example.com', active: true }]
  });
  assert.deepEqual(classes.records, [{ Id: '01p000000000001AAA', Name: 'OrderService' }]);
  assert.equal(salesforce.versionListRequests(), 1);
  assert.deepEqual(auth.sessionReasons(username), ['first-use']);
});

test('org auth answers from the session in memory and asks the source again only for a rejected token', async t => {
  const username = 'auth-memory@example.com';
  const salesforce = await startSalesforceDouble(t, []);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-first');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());
  const session = (accessToken: string) => ({ accessToken, instanceUrl: salesforce.instanceUrl, username });

  assert.deepEqual(await core.org.getAuth({ username }), session('token-first'));
  assert.deepEqual(await core.org.getAuth({ username }), session('token-first'));
  assert.deepEqual(auth.sessionReasons(username), ['first-use']);

  saveOrgAuth(username, salesforce.instanceUrl, 'token-renewed');
  assert.deepEqual(await core.org.getAuth({ username, rejected: 'token-first' }), session('token-renewed'));
  assert.deepEqual(await core.org.getAuth({ username }), session('token-renewed'));
  assert.deepEqual(
    await core.org.getAuth({ username, rejected: 'token-first' }),
    session('token-renewed'),
    'a caller late with the old token gets the session already renewed'
  );
  assert.deepEqual(auth.sessionReasons(username), ['first-use', 'rejected']);
  assert.equal(salesforce.requestCount(), 0, 'handing out a session sends nothing to Salesforce');
});

test('a session Salesforce rejects is renewed once through the auth source and the request retried', async t => {
  const username = 'revoked@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-first']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-first');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  revokeSessions(salesforce, 'token-renewed');
  saveOrgAuth(username, salesforce.instanceUrl, 'token-renewed');

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  assert.deepEqual(salesforce.queryTokens(), ['token-first', 'token-first', 'token-renewed', 'token-renewed']);
  assert.deepEqual(auth.sessionReasons(username), ['first-use', 'rejected']);
  assert.equal(salesforce.tokenRefreshRequests(), 0, 'core never refreshes a token itself');
});

test('concurrent requests Salesforce rejects share one renewal', async t => {
  const username = 'refresh-shared@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-expiring']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-expiring');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  revokeSessions(salesforce, 'token-renewed');
  saveOrgAuth(username, salesforce.instanceUrl, 'token-renewed');
  const releaseQueries = salesforce.holdQueries();

  const first = core.debugLevel.list({ targetOrg: username });
  const second = core.debugLevel.list({ targetOrg: username });
  await until(() => salesforce.queryTokens().length === 3);
  releaseQueries();

  assert.deepEqual(await Promise.all([first, second]), [[debugLevel], [debugLevel]]);
  assert.deepEqual(salesforce.queryTokens(), [
    'token-expiring',
    'token-expiring',
    'token-expiring',
    'token-renewed',
    'token-renewed'
  ]);
  assert.deepEqual(auth.sessionReasons(username), ['first-use', 'rejected']);
  assert.equal(salesforce.versionListRequests(), 1);
});

test('an auth source that hands back the rejected token ends with AUTH_REQUIRED', async t => {
  const username = 'logged-out@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-first']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-first');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  revokeSessions(salesforce);

  await assert.rejects(core.debugLevel.list({ targetOrg: username }), isAuthRequired);
  assert.deepEqual(auth.sessionReasons(username), ['first-use', 'rejected']);
  assert.deepEqual(salesforce.queryTokens(), ['token-first', 'token-first']);
});

test('after AUTH_REQUIRED, the next operation uses the session of a new login', async t => {
  const username = 'relogin@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-first']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-first');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  revokeSessions(salesforce);
  await assert.rejects(core.debugLevel.list({ targetOrg: username }), isAuthRequired);

  revokeSessions(salesforce, 'token-relogin');
  saveOrgAuth(username, salesforce.instanceUrl, 'token-relogin');

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  assert.equal(salesforce.queryTokens().at(-1), 'token-relogin');
});

test('a renewed token Salesforce rejects again ends with AUTH_REQUIRED without asking the source a third time', async t => {
  const username = 'renewed-rejected@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-first']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-first');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  revokeSessions(salesforce);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-renewed');

  await assert.rejects(core.debugLevel.list({ targetOrg: username }), isAuthRequired);
  assert.deepEqual(salesforce.queryTokens(), ['token-first', 'token-first', 'token-renewed']);
  assert.deepEqual(auth.sessionReasons(username), ['first-use', 'rejected']);
});

test('after a renewed session is refused again, the next operation uses the session of a new login', async t => {
  const username = 'renewed-relogin@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-first']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-first');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  revokeSessions(salesforce);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-renewed');
  await assert.rejects(core.debugLevel.list({ targetOrg: username }), isAuthRequired);

  revokeSessions(salesforce, 'token-relogin');
  saveOrgAuth(username, salesforce.instanceUrl, 'token-relogin');

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  assert.equal(salesforce.queryTokens().at(-1), 'token-relogin');
});

test('a log delete whose session Salesforce rejects is retried with the renewed session', async t => {
  const username = 'delete-relogin@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-first']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-first');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  revokeSessions(salesforce, 'token-renewed');
  saveOrgAuth(username, salesforce.instanceUrl, 'token-renewed');

  const result = await core.log.delete({
    targetOrg: username,
    ids: ['07L000000000001AAA', '07L000000000002AAA'],
    confirmed: true
  });

  assert.deepEqual(result, {
    status: 'success',
    targetOrg: username,
    scope: 'mine',
    dryRun: false,
    listed: 2,
    total: 2,
    deleted: 2,
    failed: 0,
    cancelled: 0,
    failedLogIds: []
  });
  assert.deepEqual(salesforce.deleteTokens(), ['token-first', 'token-renewed']);
  assert.deepEqual(auth.sessionReasons(username), ['first-use', 'rejected']);
});

test('a log delete whose every chunk Salesforce rejects renews the session once', async t => {
  const username = 'delete-chunks-relogin@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-first']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-first');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());
  const logIds = Array.from({ length: 201 }, (_, index) => `07L${String(index).padStart(12, '0')}AAA`);

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  revokeSessions(salesforce, 'token-renewed');
  saveOrgAuth(username, salesforce.instanceUrl, 'token-renewed');

  const result = await core.log.delete({ targetOrg: username, ids: logIds, confirmed: true });

  assert.deepEqual(result, {
    status: 'success',
    targetOrg: username,
    scope: 'mine',
    dryRun: false,
    listed: 201,
    total: 201,
    deleted: 201,
    failed: 0,
    cancelled: 0,
    failedLogIds: []
  });
  assert.deepEqual(salesforce.deleteTokens(), ['token-first', 'token-first', 'token-renewed', 'token-renewed']);
  assert.deepEqual(auth.sessionReasons(username), ['first-use', 'rejected']);
});

test('cancelling one caller does not cancel the connection another caller is waiting for', async t => {
  const username = 'shared@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-shared']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-shared');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());
  const releaseVersionList = salesforce.holdVersionList();
  const cancelled = new AbortController();

  const abandoned = core.debugLevel.list({ targetOrg: username }, { signal: cancelled.signal });
  const awaited = core.debugLevel.list({ targetOrg: username });
  await until(() => salesforce.versionListRequests() === 1);
  cancelled.abort();
  await assert.rejects(abandoned, error => error instanceof AlvError && error.code === 'ABORTED');
  releaseVersionList();

  assert.deepEqual(await awaited, [debugLevel]);
  assert.equal(salesforce.versionListRequests(), 1);
  assert.deepEqual(auth.sessionReasons(username), ['first-use']);
});

test('separate core instances never share an org connection or a session', async t => {
  const username = 'isolated@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-isolated']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-isolated');
  const auth = authSourceDouble();
  const first = createApexLogViewerCore({ auth });
  const second = createApexLogViewerCore({ auth });
  t.after(() => first.dispose());
  t.after(() => second.dispose());

  await first.debugLevel.list({ targetOrg: username });
  await first.debugLevel.list({ targetOrg: username });
  await second.debugLevel.list({ targetOrg: username });
  await second.debugLevel.list({ targetOrg: username });

  assert.equal(salesforce.versionListRequests(), 2);
  assert.deepEqual(auth.sessionReasons(username), ['first-use', 'first-use']);
});

const listCalls = (auth: { calls: readonly { method: string }[] }) =>
  auth.calls.filter(call => call.method === 'listOrgs').length;

test('org list answers from memory; a forced refresh lists again and keeps the session in use', async t => {
  const username = 'refreshed@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-refreshed']);
  saveOrgAuth(username, salesforce.instanceUrl, 'token-refreshed');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());

  await core.org.list();
  await core.org.list();
  assert.equal(listCalls(auth), 1);

  await core.debugLevel.list({ targetOrg: username });
  await core.org.list({ forceRefresh: true });
  assert.equal(listCalls(auth), 2);
  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);

  assert.deepEqual(auth.sessionReasons(username), ['first-use']);
  assert.equal(salesforce.versionListRequests(), 1);
  assert.deepEqual(salesforce.queryTokens(), ['token-refreshed', 'token-refreshed']);
});

test('an org logged in after core listed the orgs is found by one more list, without a forced refresh', async t => {
  const listed = 'listed@example.com';
  const late = 'late-login@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-listed', 'token-late']);
  saveOrgAuth(listed, salesforce.instanceUrl, 'token-listed');
  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth });
  t.after(() => core.dispose());
  const before = (await core.org.list()).map(org => org.username);
  assert.ok(before.includes(listed) && !before.includes(late));

  saveOrgAuth(late, salesforce.instanceUrl, 'token-late');

  assert.equal((await core.org.resolve({ targetOrg: late })).username, late);
  assert.equal(listCalls(auth), 2);
  assert.deepEqual(await core.debugLevel.list({ targetOrg: late }), [debugLevel]);
  assert.deepEqual(await core.debugLevel.list({ targetOrg: listed }), [debugLevel]);
  assert.equal(listCalls(auth), 2, 'orgs already listed resolve from memory');

  await assert.rejects(
    core.org.resolve({ targetOrg: 'never-logged-in@example.com' }),
    /No authorization information found for never-logged-in@example.com/
  );
  assert.equal(listCalls(auth), 3, 'a name no list names costs one more list, then fails');
});
