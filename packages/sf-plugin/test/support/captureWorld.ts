import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Config } from '@oclif/core';

import { recordedEvents, startBayeuxDouble } from '../../../core/test/support/cometdDouble.ts';
import { alvTestLogDescribe } from '../../../core/test/support/describeFixtures.ts';
import { nebulaHandler } from '../../../core/test/support/nebulaDouble.ts';
import { isolateSalesforceHome, saveSfOrgAuth } from './salesforceHome.ts';

/**
 * What the custom-log commands need to run over the real core: an isolated Salesforce home, the plugin's oclif
 * config, and `world`, an org double with a project that has an event source over it.
 */

isolateSalesforceHome();
// Faye reads http_proxy and ignores NO_PROXY, so a proxied machine would send the loopback double's traffic away.
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const config = await Config.load({ root: pluginRoot });

export const OBJECT = 'ALV_Test_Log__e';
const SOURCE = 'alv-events';

/** A recording delivered as if it had just been published: same uuids, replay ids and order, instants moved so the retention purge keeps them. */
function freshSingleEvent() {
  const [recorded] = recordedEvents('single');
  const { data } = recorded!;
  const shift = Date.now() - 60_000 - Date.parse(String(data.payload.CreatedDate));
  const moved = (iso: unknown): string => new Date(Date.parse(String(iso)) + shift).toISOString();
  return [
    {
      data: {
        ...data,
        payload: {
          ...data.payload,
          CreatedDate: moved(data.payload.CreatedDate),
          Logged_At__c: moved(data.payload.Logged_At__c),
          Epoch_Ms__c: Number(data.payload.Epoch_Ms__c) + shift
        }
      }
    }
  ];
}

/** An org that serves the REST half of a capture and the Bayeux stream on one host, and a project with an event source over it. */
export async function world(t: test.TestContext, { remaining = 22_000 } = {}) {
  const double = await startBayeuxDouble(
    t,
    { connects: [{ events: freshSingleEvent() }] },
    nebulaHandler({
      describes: 'unlocked-admin',
      objects: [OBJECT],
      extraDescribes: { [OBJECT]: alvTestLogDescribe() },
      answer: (_soql, request) =>
        request.path === '/limits'
          ? { body: { DailyDeliveredPlatformEvents: { Max: 25_000, Remaining: remaining } } }
          : undefined
    })
  );
  await saveSfOrgAuth(double.username, double.instanceUrl);
  const home = process.cwd();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-cli-capture-'));
  // Windows will not remove a process's working directory, so the cwd moves back before the directory goes.
  t.after(async () => {
    process.chdir(home);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(
    path.join(root, 'sfdx-project.json'),
    JSON.stringify({
      plugins: {
        electivus: {
          customLogs: {
            sources: [
              {
                id: SOURCE,
                label: 'ALV events',
                event: {
                  object: OBJECT,
                  fields: {
                    time: 'Logged_At__c',
                    message: 'Message__c',
                    level: 'Level__c',
                    user: 'Username__c',
                    transactionId: 'Transaction_Id__c',
                    order: 'Sequence__c'
                  }
                }
              }
            ]
          }
        }
      }
    })
  );
  process.chdir(root);
  return { double, org: ['--target-org', double.username, '--source', SOURCE] };
}
