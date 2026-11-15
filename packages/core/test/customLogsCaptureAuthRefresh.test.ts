import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApexLogViewerCore } from '../src/index.ts';
import { startBayeuxDouble } from './support/cometdDouble.ts';
import { alvTestLogDescribe } from './support/describeFixtures.ts';
import { nebulaHandler } from './support/nebulaDouble.ts';
import { authSourceDouble, saveOrgAuth } from './support/salesforceDouble.ts';

delete process.env.http_proxy;
delete process.env.HTTP_PROXY;

const OBJECT = 'ALV_Test_Log__e';

test('an expired session mid-stream: capture renews the session through the auth source and continues', async t => {
  // The stream's first long poll says the session is gone, the way Salesforce answers an expired token;
  // from then on only a renewed token gets a handshake.
  const double = await startBayeuxDouble(
    t,
    {
      connects: [{ error: '401::Authentication invalid', advice: { reconnect: 'none' } }],
      acceptsHandshake: (token, handshake) => handshake === 1 || token === 'token-fresh'
    },
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
  // The org as `sf org login web` leaves it: an access token, and a refresh token `sf` renews it with.
  saveOrgAuth(double.username, double.instanceUrl, { accessToken: 'token-double', refreshesTo: 'token-fresh' });

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

  const auth = authSourceDouble();
  const core = createApexLogViewerCore({ auth, surface: 'cli' });
  t.after(() => core.dispose());
  let failure: unknown;
  try {
    await core.customLog.capture({
      targetOrg: double.username,
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
  assert.deepEqual(auth.sessionReasons(double.username), ['first-use', 'rejected']);
  assert.equal(double.handshakeTokens[0], 'token-double');
  assert.equal(double.handshakeTokens.at(-1), 'token-fresh', 'the next handshake carries the renewed token');
});
