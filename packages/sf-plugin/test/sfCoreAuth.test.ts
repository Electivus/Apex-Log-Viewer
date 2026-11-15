import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

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

test('a rejected session is renewed with the refresh token, as sf itself would', async t => {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    request.resume();
    request.on('end', () => {
      if (request.url === '/services/oauth2/token') {
        send(200, {
          access_token: 'token-renewed',
          instance_url: instanceUrl,
          id: `${instanceUrl}/id/${ORG_ID}/005000000000001AAA`,
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          signature: 'sig'
        });
      } else if (request.headers.authorization === 'Bearer token-renewed') {
        send(200, {});
      } else {
        send(401, [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve()))));
  const instanceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const username = 'renewal@example.com';
  await saveSfOrgAuth(username, instanceUrl, { accessToken: 'token-expired', refreshToken: 'refresh-valid' });
  const source = createSfCoreAuthSource();
  const org = (await source.listOrgs()).find(candidate => candidate.username === username)!;

  assert.equal((await source.session(org, 'first-use')).accessToken, 'token-expired');
  assert.deepEqual(await source.session(org, 'rejected'), {
    accessToken: 'token-renewed',
    instanceUrl,
    orgId: ORG_ID
  });
  assert.equal(seen.filter(line => line === 'POST /services/oauth2/token').length, 1);
  assert.ok(!seen.includes('GET /services/data'), 'renewing looks up no API version');
  assert.equal(
    (await createSfCoreAuthSource().session(org, 'first-use')).accessToken,
    'token-renewed',
    'the renewed token is stored for the next sf command'
  );
});
