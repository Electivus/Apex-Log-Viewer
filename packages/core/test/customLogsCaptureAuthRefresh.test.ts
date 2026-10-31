import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { StateAggregator } from '@salesforce/core';

import { createApexLogViewerCore } from '../src/index.ts';
import { startBayeuxDouble } from './support/cometdDouble.ts';
import { alvTestLogDescribe } from './support/describeFixtures.ts';
import { nebulaHandler } from './support/nebulaDouble.ts';
import { ORG_ID, isolateSalesforceHome } from './support/salesforceDouble.ts';

isolateSalesforceHome();
// As on a developer machine: the API version cache is in use, so connecting makes no REST request.
delete process.env.SFDX_IGNORE_API_VERSION_CACHE;
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;

const OBJECT = 'ALV_Test_Log__e';

test('an expired session mid-stream: the rebuild refreshes the access token with the saved refresh token and capture continues', async t => {
  // The stream's first long poll says the session is gone, the way Salesforce answers an expired token.
  const double = await startBayeuxDouble(
    t,
    { connects: [{ error: '401::Authentication invalid', advice: { reconnect: 'none' } }] },
    nebulaHandler({
      describes: 'unlocked-admin',
      objects: [OBJECT],
      extraDescribes: { [OBJECT]: alvTestLogDescribe() },
      answer: (_soql, request) =>
        request.path === '/limits'
          ? { body: { DailyDeliveredPlatformEvents: { Max: 25_000, Remaining: 22_000 } } }
          : undefined
    })
  );
  const upstream = new URL(double.instanceUrl);

  // A front door that plays the org's auth: after the first handshake the old token is refused,
  // and the OAuth token endpoint hands out a new one to whoever asks with the refresh token.
  const seen = { handshakeTokens: [] as string[], refreshes: 0 };
  const proxy = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      if (request.url?.startsWith('/services/oauth2/token')) {
        seen.refreshes += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'token-fresh',
            instance_url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
            id: `http://127.0.0.1/id/${ORG_ID}/005000000000001AAA`,
            token_type: 'Bearer',
            issued_at: String(Date.now()),
            signature: 'sig'
          })
        );
        return;
      }
      if (request.url?.startsWith('/cometd/') && body.length > 0) {
        let messages: { id?: string; channel?: string }[] = [];
        try {
          const parsed = JSON.parse(body.toString('utf8')) as unknown;
          messages = Array.isArray(parsed) ? parsed : [parsed as { id?: string; channel?: string }];
        } catch {}
        const handshake = messages.find(message => message.channel === '/meta/handshake');
        if (handshake) {
          const token = String(request.headers.authorization ?? '');
          seen.handshakeTokens.push(token);
          if (seen.handshakeTokens.length > 1 && token !== 'OAuth token-fresh') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify([
                {
                  id: handshake.id,
                  channel: '/meta/handshake',
                  successful: false,
                  error: '403::Handshake denied',
                  advice: { reconnect: 'none' },
                  ext: { sfdc: { failureReason: '401::Authentication invalid' } }
                }
              ])
            );
            return;
          }
        }
      }
      if (!request.url?.startsWith('/cometd/')) {
      }
      if (
        !request.url?.startsWith('/cometd/') &&
        seen.handshakeTokens.length > 1 &&
        String(request.headers.authorization ?? '').endsWith('token-double')
      ) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify([{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]));
        return;
      }
      const forward = http.request(
        {
          host: upstream.hostname,
          port: upstream.port,
          method: request.method,
          path: request.url,
          headers: request.headers
        },
        answer => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        }
      );
      forward.end(body);
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => (proxy.closeAllConnections(), proxy.close(() => resolve()))));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  // The org as `sf org login web` leaves it: an access token AND a refresh token.
  const username = 'expiring@example.com';
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    instanceUrl: proxyUrl,
    loginUrl: proxyUrl,
    accessToken: 'token-double',
    refreshToken: 'refresh-token-double',
    clientId: 'PlatformCLI',
    instanceApiVersion: '63.0',
    instanceApiVersionLastRetrieved: new Date().toLocaleString('en-US')
  });
  await state.orgs.write(username);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-adv-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, 'sfdx-project.json'),
    JSON.stringify({
      plugins: {
        electivus: {
          customLogs: {
            sources: [
              {
                id: 'alv-events',
                label: 'ALV events',
                event: { object: OBJECT, fields: { time: 'Logged_At__c', message: 'Message__c' } }
              }
            ]
          }
        }
      }
    })
  );

  const core = createApexLogViewerCore({ surface: 'cli' });
  t.after(() => core.dispose());
  let failure: unknown;
  try {
    await core.customLog.capture({
      targetOrg: username,
      projectDir: root,
      source: 'alv-events',
      follow: false,
      initial: 'new',
      maxDurationMs: 60_000
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure, undefined, 'capture does not ask the user to log in again');
  assert.equal(seen.refreshes, 1);
  assert.equal(seen.handshakeTokens.at(-1), 'OAuth token-fresh', 'the next handshake carries the refreshed token');
});
