import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Config } from '@oclif/core';

import DebugLevelCreate from '../src/commands/electivus/debug-level/create.ts';
import DebugLevelUpdate from '../src/commands/electivus/debug-level/update.ts';
import { core } from '../src/core.ts';
import { debugLevelOrg, EXISTING_LEVEL, LEVEL_ID } from '../../core/test/support/debugLevelDouble.ts';
import { isolateSalesforceHome } from '../../core/test/support/salesforceDouble.ts';

isolateSalesforceHome();

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await Config.load({ root: pluginRoot });

test.after(() => core.dispose());

const create = (org: string, ...argv: string[]) =>
  new DebugLevelCreate(['--target-org', org, '--json', ...argv], config).run();
const update = (org: string, ...argv: string[]) =>
  new DebugLevelUpdate(['--target-org', org, '--id', LEVEL_ID, '--json', ...argv], config).run();

test('create without --language creates the level in en_US', async t => {
  const org = await debugLevelOrg(t, 'create-no-language@example.com');

  const result = await create(
    'create-no-language@example.com',
    '--developer-name',
    'ALV_NEW',
    '--system',
    'FINE',
    '--yes'
  );

  assert.equal(result.dryRun, false);
  assert.equal(result.record?.language, 'en_US');
  assert.deepEqual(org.levels.get(String(result.id)), {
    Id: result.id,
    DeveloperName: 'ALV_NEW',
    MasterLabel: 'ALV_NEW',
    Language: 'en_US',
    Workflow: 'INFO',
    Validation: 'INFO',
    Callout: 'INFO',
    ApexCode: 'DEBUG',
    ApexProfiling: 'INFO',
    Visualforce: 'INFO',
    System: 'FINE',
    Database: 'INFO',
    Wave: 'INFO',
    Nba: 'INFO',
    DataAccess: 'INFO'
  });
});

test('create honors a passed --language', async t => {
  const org = await debugLevelOrg(t, 'create-language@example.com');

  const result = await create(
    'create-language@example.com',
    '--developer-name',
    'ALV_NEW',
    '--language',
    'pt_BR',
    '--yes'
  );

  assert.equal(org.levels.get(String(result.id))?.Language, 'pt_BR');
});

test('create preview without --language shows the record the real call sends and writes nothing', async t => {
  const org = await debugLevelOrg(t, 'create-preview@example.com');

  const preview = await create('create-preview@example.com', '--developer-name', 'ALV_NEW', '--system', 'FINE');
  const real = await create('create-preview@example.com', '--developer-name', 'ALV_NEW', '--system', 'FINE', '--yes');

  const { id: _id, ...sent } = real.record ?? {};
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.record, sent);
  assert.equal(org.writes().length, 1, 'only the real call writes');
});

test('update without --language or --developer-name changes only the passed field', async t => {
  const org = await debugLevelOrg(t, 'update-one-field@example.com');

  const result = await update('update-one-field@example.com', '--apex-code', 'FINEST', '--yes');

  assert.deepEqual(
    org.writes().map(write => write.body),
    [{ ApexCode: 'FINEST' }]
  );
  assert.deepEqual(org.levels.get(LEVEL_ID), { ...EXISTING_LEVEL, ApexCode: 'FINEST' });
  assert.equal(result.record?.apexCode, 'FINEST');
  assert.equal(result.record?.masterLabel, EXISTING_LEVEL.MasterLabel);
  assert.equal(result.record?.language, EXISTING_LEVEL.Language);
});

test('update with --language keeps every category and the label the user did not pass', async t => {
  const org = await debugLevelOrg(t, 'update-language@example.com');

  await update(
    'update-language@example.com',
    '--developer-name',
    'ALV_DEBUG',
    '--language',
    'en_US',
    '--apex-code',
    'FINEST',
    '--yes'
  );

  assert.deepEqual(org.levels.get(LEVEL_ID), {
    ...EXISTING_LEVEL,
    DeveloperName: 'ALV_DEBUG',
    Language: 'en_US',
    ApexCode: 'FINEST'
  });
});

test('update preview shows the level as it would be after the update and writes nothing', async t => {
  const org = await debugLevelOrg(t, 'update-preview@example.com');

  const preview = await update('update-preview@example.com', '--apex-code', 'FINEST');

  assert.equal(preview.dryRun, true);
  assert.equal(preview.record?.apexCode, 'FINEST');
  assert.equal(preview.record?.workflow, EXISTING_LEVEL.Workflow);
  assert.equal(preview.record?.masterLabel, EXISTING_LEVEL.MasterLabel);
  assert.deepEqual(org.writes(), []);
});

test('preview rejects a value Salesforce rejects, as the real call does', async t => {
  const org = await debugLevelOrg(t, 'preview-rejects@example.com');
  const cases = [
    { flags: ['--language', 'Bogus'], message: /Master Language: bad value for restricted picklist field: Bogus/ },
    { flags: ['--system', 'NOPE'], message: /System: bad value for restricted picklist field: NOPE/ }
  ];

  for (const { flags, message } of cases) {
    await assert.rejects(create('preview-rejects@example.com', '--developer-name', 'ALV_NEW', ...flags), message);
    await assert.rejects(
      create('preview-rejects@example.com', '--developer-name', 'ALV_NEW', ...flags, '--yes'),
      message
    );
    await assert.rejects(update('preview-rejects@example.com', ...flags), message);
    await assert.rejects(update('preview-rejects@example.com', ...flags, '--yes'), message);
  }
  assert.equal(org.levels.size, 1, 'no rejected value reached the org');
  assert.deepEqual(org.levels.get(LEVEL_ID), EXISTING_LEVEL);
});

test('preview accepts a value in any case, as the real call does', async t => {
  await debugLevelOrg(t, 'preview-case@example.com');

  const preview = await create(
    'preview-case@example.com',
    '--developer-name',
    'ALV_NEW',
    '--language',
    'EN_us',
    '--system',
    'fine'
  );
  const real = await create(
    'preview-case@example.com',
    '--developer-name',
    'ALV_NEW',
    '--language',
    'EN_us',
    '--system',
    'fine',
    '--yes'
  );

  assert.equal(preview.status, 'success');
  assert.equal(real.status, 'success');
});

test('update fails before any write when no field is passed', async t => {
  const org = await debugLevelOrg(t, 'update-nothing@example.com');

  await assert.rejects(update('update-nothing@example.com', '--yes'), /no fields to change/i);
  await assert.rejects(update('update-nothing@example.com'), /no fields to change/i);
  assert.deepEqual(org.writes(), []);
});

test('update fails on an unknown id in the preview too', async t => {
  await debugLevelOrg(t, 'update-unknown@example.com');
  const unknown = ['--target-org', 'update-unknown@example.com', '--id', '7dl000000000009AAA', '--apex-code', 'FINE'];

  await assert.rejects(new DebugLevelUpdate(unknown, config).run(), /was not found/);
  await assert.rejects(new DebugLevelUpdate([...unknown, '--yes'], config).run(), /was not found/);
});

test('create requires --developer-name', async t => {
  await debugLevelOrg(t, 'create-no-name@example.com');

  await assert.rejects(create('create-no-name@example.com', '--system', 'FINE'), /developer-name/);
});
