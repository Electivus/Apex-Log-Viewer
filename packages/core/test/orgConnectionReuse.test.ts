import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import { StateAggregator } from '@salesforce/core';

import { AlvError, createApexLogViewerCore } from '../src/index.ts';

const originalCwd = process.cwd();
const sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-sf-home-'));
process.env.HOME = sfHome;
process.env.USERPROFILE = sfHome;
process.env.SF_USE_GENERIC_UNIX_KEYCHAIN = 'true';
process.env.SF_DISABLE_LOG_FILE = 'true';
process.env.SF_DISABLE_DNS_CHECK = 'true';
// Under pt-BR or de-DE the SDK writes a version timestamp it cannot parse back, so its version cache never hits.
// Ignoring that cache reproduces those locales on every machine.
process.env.SFDX_IGNORE_API_VERSION_CACHE = 'true';
process.chdir(sfHome);
after(() => {
  process.chdir(originalCwd);
  fs.rmSync(sfHome, { recursive: true, force: true });
});

const authFileWrites = mock.method(fs.promises, 'writeFile');

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
  versionListRequests: () => number;
  tokenRefreshRequests: () => number;
  queryTokens: () => string[];
  holdVersionList: () => () => void;
};

async function startSalesforceDouble(t: test.TestContext, acceptedTokens: string[]): Promise<SalesforceDouble> {
  const requests: Array<{ path: string; token: string }> = [];
  const accepted = new Set(acceptedTokens);
  let versionListGate: Promise<void> = Promise.resolve();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    requests.push({ path: url.pathname, token });
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/services/data') {
      void versionListGate.then(() =>
        send(200, [{ label: "Spring '25", url: '/services/data/v63.0', version: '63.0' }])
      );
      return;
    }
    if (url.pathname === '/services/oauth2/token') {
      send(400, { error: 'invalid_grant', error_description: 'expired access/refresh token' });
      return;
    }
    if (!accepted.has(token)) {
      send(401, [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
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
    versionListRequests: () => requests.filter(request => request.path === '/services/data').length,
    tokenRefreshRequests: () => requests.filter(request => request.path === '/services/oauth2/token').length,
    queryTokens: () => requests.filter(request => request.path.endsWith('/query')).map(request => request.token),
    holdVersionList: () => {
      let release!: () => void;
      versionListGate = new Promise(resolve => {
        release = resolve;
      });
      return release;
    }
  };
}

async function saveOrgAuth(
  username: string,
  instanceUrl: string,
  tokens: { accessToken: string; refreshToken?: string }
): Promise<void> {
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: '00D000000000001AAA',
    orgEdition: 'Developer Edition',
    namespacePrefix: null,
    instanceUrl,
    loginUrl: instanceUrl,
    ...tokens
  });
  await state.orgs.write(username);
}

function authFileWritesFor(username: string): number {
  const authFile = path.join(sfHome, '.sfdx', `${username}.json`);
  return authFileWrites.mock.calls.filter(call => String(call.arguments[0]) === authFile).length;
}

test('five operations against one org look up its API version once and rewrite its auth file once', async t => {
  const username = 'reuse@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-reuse']);
  await saveOrgAuth(username, salesforce.instanceUrl, { accessToken: 'token-reuse' });
  const writesBefore = authFileWritesFor(username);
  const core = createApexLogViewerCore();
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
  assert.equal(authFileWritesFor(username) - writesBefore, 1);
});

test('a session Salesforce rejects is rebuilt from the saved auth and retried once', async t => {
  const username = 'revoked@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-first']);
  await saveOrgAuth(username, salesforce.instanceUrl, { accessToken: 'token-first' });
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  salesforce.acceptedTokens.clear();
  salesforce.acceptedTokens.add('token-relogin');
  await saveOrgAuth(username, salesforce.instanceUrl, { accessToken: 'token-relogin' });

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  assert.deepEqual(salesforce.queryTokens(), ['token-first', 'token-first', 'token-relogin']);

  salesforce.acceptedTokens.clear();
  await assert.rejects(
    core.debugLevel.list({ targetOrg: username }),
    (error: Error & { errorCode?: string }) => error.errorCode === 'INVALID_SESSION_ID'
  );
  assert.deepEqual(salesforce.queryTokens(), [
    'token-first',
    'token-first',
    'token-relogin',
    'token-relogin',
    'token-relogin'
  ]);
});

test('a session whose refresh token was revoked is rebuilt from the saved auth', async t => {
  const username = 'refresh-revoked@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-expiring']);
  await saveOrgAuth(username, salesforce.instanceUrl, {
    accessToken: 'token-expiring',
    refreshToken: 'refresh-revoked'
  });
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  salesforce.acceptedTokens.clear();
  salesforce.acceptedTokens.add('token-relogin');
  await saveOrgAuth(username, salesforce.instanceUrl, {
    accessToken: 'token-relogin',
    refreshToken: 'refresh-relogin'
  });

  assert.deepEqual(await core.debugLevel.list({ targetOrg: username }), [debugLevel]);
  assert.deepEqual(salesforce.queryTokens(), ['token-expiring', 'token-expiring', 'token-relogin']);
  assert.equal(salesforce.tokenRefreshRequests(), 1);
});

test('cancelling one caller does not cancel the connection another caller is waiting for', async t => {
  const username = 'shared@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-shared']);
  await saveOrgAuth(username, salesforce.instanceUrl, { accessToken: 'token-shared' });
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());
  const releaseVersionList = salesforce.holdVersionList();
  const cancelled = new AbortController();

  const abandoned = core.debugLevel.list({ targetOrg: username }, { signal: cancelled.signal });
  const awaited = core.debugLevel.list({ targetOrg: username });
  await new Promise(resolve => setImmediate(resolve));
  cancelled.abort();
  await assert.rejects(abandoned, error => error instanceof AlvError && error.code === 'ABORTED');
  releaseVersionList();

  assert.deepEqual(await awaited, [debugLevel]);
  assert.equal(salesforce.versionListRequests(), 1);
});

test('separate core instances never share an org connection', async t => {
  const username = 'isolated@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-isolated']);
  await saveOrgAuth(username, salesforce.instanceUrl, { accessToken: 'token-isolated' });
  const first = createApexLogViewerCore();
  const second = createApexLogViewerCore();
  t.after(() => first.dispose());
  t.after(() => second.dispose());

  await first.debugLevel.list({ targetOrg: username });
  await first.debugLevel.list({ targetOrg: username });
  await second.debugLevel.list({ targetOrg: username });
  await second.debugLevel.list({ targetOrg: username });

  assert.equal(salesforce.versionListRequests(), 2);
});

test('a forced org list refresh rebuilds the next connection', async t => {
  const username = 'refreshed@example.com';
  const salesforce = await startSalesforceDouble(t, ['token-refreshed']);
  await saveOrgAuth(username, salesforce.instanceUrl, { accessToken: 'token-refreshed' });
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());

  await core.debugLevel.list({ targetOrg: username });
  await core.org.list();
  await core.debugLevel.list({ targetOrg: username });
  assert.equal(salesforce.versionListRequests(), 1);

  await core.org.list({ forceRefresh: true });
  await core.debugLevel.list({ targetOrg: username });
  assert.equal(salesforce.versionListRequests(), 2);
});
