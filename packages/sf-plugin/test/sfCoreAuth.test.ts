import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { StateAggregator } from '@salesforce/core';

import { createSfCoreAuthSource } from '../src/sfCoreAuth.ts';
import { ORG_ID } from '../../core/test/support/salesforceDouble.ts';
import { isolateSalesforceHome, saveSfOrgAuth } from './support/salesforceHome.ts';

const sfHome = isolateSalesforceHome();

const GLOBAL_ORG = 'global@example.com';
const PROJECT_ORG = 'project@example.com';
const PROJECT_ALIAS = 'project-scratch';
const HUB_ORG = 'hub@example.com';
const UNREACHABLE = 'http://127.0.0.1:9';

function writeConfig(root: string, values: Record<string, string>): string {
  fs.mkdirSync(path.join(root, '.sf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sf', 'config.json'), JSON.stringify(values));
  return root;
}

function project(values: Record<string, string>): string {
  const root = writeConfig(fs.mkdtempSync(path.join(sfHome, 'project-')), values);
  fs.writeFileSync(path.join(root, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app"}]}');
  fs.mkdirSync(path.join(root, 'force-app'));
  return root;
}

async function inDirectory<T>(directory: string, run: () => Promise<T>): Promise<T> {
  process.chdir(directory);
  try {
    return await run();
  } finally {
    process.chdir(sfHome);
  }
}

const defaults = (orgs: Array<{ username: string; isDefaultUsername?: boolean }>): string[] =>
  orgs.filter(org => org.isDefaultUsername).map(org => org.username);

test.before(async () => {
  await saveSfOrgAuth(GLOBAL_ORG, UNREACHABLE, { accessToken: 'token-global' });
  await saveSfOrgAuth(PROJECT_ORG, UNREACHABLE, {
    accessToken: 'token-project',
    alias: PROJECT_ALIAS,
    isScratch: true
  });
  await saveSfOrgAuth(HUB_ORG, UNREACHABLE, { accessToken: 'token-hub' });
  writeConfig(sfHome, { 'target-org': GLOBAL_ORG, 'target-dev-hub': HUB_ORG });
});

test('the source lists every saved org with its alias and flags, and no token', async () => {
  const orgs = await createSfCoreAuthSource().listOrgs();
  const byName = new Map(orgs.map(org => [org.username, org]));

  assert.deepEqual(byName.get(PROJECT_ORG), {
    username: PROJECT_ORG,
    alias: PROJECT_ALIAS,
    aliases: [PROJECT_ALIAS],
    orgId: ORG_ID,
    instanceUrl: UNREACHABLE,
    isScratchOrg: true,
    isDefaultUsername: false,
    isDefaultDevHubUsername: false
  });
  assert.equal(byName.get(HUB_ORG)?.isDefaultDevHubUsername, true);
  assert.doesNotMatch(JSON.stringify(orgs), /token-/);
});

test('outside a project the global target-org is the default', async () => {
  assert.deepEqual(defaults(await createSfCoreAuthSource().listOrgs()), [GLOBAL_ORG]);
});

test("inside a project, anywhere in it, the project's target-org is the default, by alias too", async () => {
  const root = project({ 'target-org': PROJECT_ALIAS });
  const source = createSfCoreAuthSource();

  assert.deepEqual(await inDirectory(root, () => source.listOrgs().then(defaults)), [PROJECT_ORG]);
  assert.deepEqual(await inDirectory(path.join(root, 'force-app'), () => source.listOrgs().then(defaults)), [
    PROJECT_ORG
  ]);
  assert.deepEqual(defaults(await source.listOrgs()), [GLOBAL_ORG], 'each call reads the working directory anew');
});

test('an org with two aliases lists both, and a target-org naming the second finds it', async () => {
  const username = 'renamed@example.com';
  await saveSfOrgAuth(username, UNREACHABLE, { accessToken: 'token-renamed', alias: 'renamed' });
  await (await StateAggregator.getInstance()).aliases.setAndSave('renamed-old', username);
  const root = project({ 'target-org': 'renamed-old' });

  const orgs = await inDirectory(root, () => createSfCoreAuthSource().listOrgs());
  const renamed = orgs.find(org => org.username === username);

  assert.equal(renamed?.alias, 'renamed');
  assert.deepEqual(renamed?.aliases, ['renamed', 'renamed-old']);
  assert.deepEqual(defaults(orgs), [username]);
});

test('a project with no target-org falls back to the global one', async () => {
  const root = project({});

  assert.deepEqual(await inDirectory(root, () => createSfCoreAuthSource().listOrgs().then(defaults)), [GLOBAL_ORG]);
});

test('a first use reads the stored session and writes nothing', async () => {
  const authFile = path.join(sfHome, '.sfdx', `${PROJECT_ORG}.json`);
  const before = fs.readFileSync(authFile, 'utf8');
  const org = (await createSfCoreAuthSource().listOrgs()).find(candidate => candidate.username === PROJECT_ORG)!;

  assert.deepEqual(await createSfCoreAuthSource().session(org, 'first-use'), {
    accessToken: 'token-project',
    instanceUrl: UNREACHABLE,
    orgId: ORG_ID
  });
  assert.equal(fs.readFileSync(authFile, 'utf8'), before);
});

test('a first use of an org with no stored auth fails', async () => {
  await assert.rejects(createSfCoreAuthSource().session({ username: 'missing@example.com' }, 'first-use'));
});

/**
 * A fake org whose token endpoint rotates the refresh token, as an org with Refresh Token Rotation does: each refresh
 * returns a new access token and a new refresh token, and the refresh token it replaced stops working. Only the
 * latest access token is accepted, until `expireSession` rejects it too.
 */
async function rotatingOrg(t: TestContext, firstRefreshToken: string) {
  const seen: string[] = [];
  let refreshToken = firstRefreshToken;
  let accessToken: string | undefined;
  let renewals = 0;
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    let body = '';
    request.setEncoding('utf8').on('data', chunk => (body += chunk));
    request.on('end', () => {
      if (request.url === '/services/oauth2/token') {
        if (new URLSearchParams(body).get('refresh_token') !== refreshToken) {
          send(400, { error: 'invalid_grant', error_description: 'expired access/refresh token' });
          return;
        }
        renewals += 1;
        accessToken = `token-renewed-${renewals}`;
        refreshToken = `refresh-rotated-${renewals}`;
        send(200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          instance_url: instanceUrl,
          id: `${instanceUrl}/id/${ORG_ID}/005000000000001AAA`,
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          signature: 'sig'
        });
      } else if (accessToken && request.headers.authorization === `Bearer ${accessToken}`) {
        send(200, {});
      } else {
        send(401, [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve()))));
  const instanceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { instanceUrl, seen, expireSession: () => (accessToken = undefined) };
}

/**
 * Sets the clock that @salesforce/core 9.2 stamps auth changes with, `performance.timeOrigin + performance.now()`, `ms`
 * behind the wall clock that dates files until the test ends.
 */
function trailStampClock(t: TestContext, ms: number): void {
  const own = Object.getOwnPropertyDescriptor(performance, 'timeOrigin');
  Object.defineProperty(performance, 'timeOrigin', {
    value: performance.timeOrigin - ms,
    enumerable: true,
    configurable: true
  });
  t.after(() => {
    if (own) Object.defineProperty(performance, 'timeOrigin', own);
    else delete (performance as { timeOrigin?: number }).timeOrigin;
  });
}

test('a rejected session is renewed with the refresh token, as sf itself would', async t => {
  const { instanceUrl, seen } = await rotatingOrg(t, 'refresh-valid');
  const username = 'renewal@example.com';
  await saveSfOrgAuth(username, instanceUrl, { accessToken: 'token-expired', refreshToken: 'refresh-valid' });
  const source = createSfCoreAuthSource();
  const org = (await source.listOrgs()).find(candidate => candidate.username === username)!;

  assert.equal((await source.session(org, 'first-use')).accessToken, 'token-expired');
  assert.deepEqual(await source.session(org, 'rejected'), {
    accessToken: 'token-renewed-1',
    instanceUrl,
    orgId: ORG_ID
  });
  assert.equal(seen.filter(line => line === 'POST /services/oauth2/token').length, 1);
  assert.ok(!seen.includes('GET /services/data'), 'renewing looks up no API version');
  assert.equal(
    (await createSfCoreAuthSource().session(org, 'first-use')).accessToken,
    'token-renewed-1',
    'the renewed token is stored for the next sf command'
  );
});

// @salesforce/core 9.2 to 9.4.0 stamped auth changes with the performance clock, which starts from the wall clock at
// process start and then counts on its own: it started up to 2 ms behind NTFS file times on Windows and fell 0.34 ms a
// minute behind on a Mac (#1449). Once it trailed by more than the few milliseconds between a refresh's own saves, a
// renewal kept the expired access token and the refresh token rotation had replaced (#1463). 9.4.1 and later stamp with
// Date.now(), so this fails only on a core that stamps with the performance clock again.
test('renewals keep each rotated token while the stamp clock trails the auth file', async t => {
  const fakeOrg = await rotatingOrg(t, 'refresh-valid');
  const username = 'renewal-trailing-clock@example.com';
  await saveSfOrgAuth(username, fakeOrg.instanceUrl, { accessToken: 'token-expired', refreshToken: 'refresh-valid' });
  trailStampClock(t, 10_000);
  const org = (await createSfCoreAuthSource().listOrgs()).find(candidate => candidate.username === username)!;
  const nextSfCommand = () => (StateAggregator.clearInstance(), createSfCoreAuthSource());

  assert.equal((await createSfCoreAuthSource().session(org, 'rejected')).accessToken, 'token-renewed-1');
  assert.equal(
    (await nextSfCommand().session(org, 'first-use')).accessToken,
    'token-renewed-1',
    'the renewed token is stored for the next sf command'
  );

  fakeOrg.expireSession();
  assert.equal(
    (await nextSfCommand().session(org, 'rejected')).accessToken,
    'token-renewed-2',
    'the next renewal reads the rotated refresh token, the only one the org still accepts'
  );
});
