import assert from 'node:assert/strict';
import test from 'node:test';

import { createApexLogViewerCore } from '../src/index.ts';
import { debugLevelOrg, EXISTING_LEVEL, LEVEL_ID } from './support/debugLevelDouble.ts';
import { isolateSalesforceHome } from './support/salesforceDouble.ts';

isolateSalesforceHome();

const core = createApexLogViewerCore();
test.after(() => core.dispose());

const fullRecord = {
  id: LEVEL_ID,
  developerName: 'ALV_RENAMED',
  masterLabel: 'ALV Renamed',
  language: 'pt_BR',
  workflow: 'DEBUG',
  validation: 'DEBUG',
  callout: 'DEBUG',
  apexCode: 'DEBUG',
  apexProfiling: 'DEBUG',
  visualforce: 'DEBUG',
  system: 'DEBUG',
  database: 'DEBUG',
  wave: 'DEBUG',
  nba: 'DEBUG',
  dataAccess: 'DEBUG'
};

test('an update with the whole record, as the Debug Flags panel sends it, writes every field but the id', async t => {
  const org = await debugLevelOrg(t, 'full-record@example.com');

  await core.debugLevel.update({
    targetOrg: 'full-record@example.com',
    id: LEVEL_ID,
    changes: fullRecord,
    confirmed: true
  });

  assert.deepEqual(org.writes(), [
    {
      method: 'PATCH',
      path: `/tooling/sobjects/DebugLevel/${LEVEL_ID}`,
      body: {
        DeveloperName: 'ALV_RENAMED',
        MasterLabel: 'ALV Renamed',
        Language: 'pt_BR',
        Workflow: 'DEBUG',
        Validation: 'DEBUG',
        Callout: 'DEBUG',
        ApexCode: 'DEBUG',
        ApexProfiling: 'DEBUG',
        Visualforce: 'DEBUG',
        System: 'DEBUG',
        Database: 'DEBUG',
        Wave: 'DEBUG',
        Nba: 'DEBUG',
        DataAccess: 'DEBUG'
      }
    }
  ]);
});

test('a blank field counts as not passed', async t => {
  const org = await debugLevelOrg(t, 'blank@example.com');

  const updated = await core.debugLevel.update({
    targetOrg: 'blank@example.com',
    id: LEVEL_ID,
    changes: { workflow: ' ', apexCode: 'FINEST' },
    confirmed: true
  });
  const created = await core.debugLevel.create({
    targetOrg: 'blank@example.com',
    record: { developerName: 'ALV_NEW', language: '', system: ' ' },
    confirmed: true
  });

  assert.deepEqual(org.writes()[0]?.body, { ApexCode: 'FINEST' });
  assert.equal(updated.record?.workflow, EXISTING_LEVEL.Workflow);
  assert.equal(created.record?.language, 'en_US');
  assert.equal(created.record?.system, 'DEBUG');
});

test('create requires a developer name', async t => {
  const org = await debugLevelOrg(t, 'no-name@example.com');

  await assert.rejects(
    core.debugLevel.create({ targetOrg: 'no-name@example.com', record: { developerName: ' ' } }),
    /developer name is required/
  );
  assert.equal(org.salesforce.requests.length, 0);
});

test('only a preview reads the describe', async t => {
  const org = await debugLevelOrg(t, 'describe@example.com');
  const params = { targetOrg: 'describe@example.com' };

  await core.debugLevel.create({ ...params, record: { developerName: 'ALV_NEW' }, confirmed: true });
  await core.debugLevel.update({ ...params, id: LEVEL_ID, changes: { apexCode: 'FINEST' }, confirmed: true });
  assert.equal(org.describes(), 0);

  await core.debugLevel.create({ ...params, record: { developerName: 'ALV_NEW' } });
  await core.debugLevel.update({ ...params, id: LEVEL_ID, changes: { apexCode: 'FINEST' }, dryRun: true });
  assert.equal(org.describes(), 2);
});

test('a preview reports every bad value and lists the allowed ones', async t => {
  await debugLevelOrg(t, 'all-problems@example.com');

  await assert.rejects(
    core.debugLevel.create({
      targetOrg: 'all-problems@example.com',
      record: { developerName: 'ALV_NEW', language: 'Bogus', system: 'NOPE' }
    }),
    (error: Error) => {
      assert.match(
        error.message,
        /Master Language: bad value for restricted picklist field: Bogus\. Allowed values: en_US, de, pt_BR\./
      );
      assert.match(error.message, /System: bad value for restricted picklist field: NOPE\./);
      return true;
    }
  );
});
