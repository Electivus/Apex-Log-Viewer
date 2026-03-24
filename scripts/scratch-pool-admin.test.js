const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  buildPoolScratchDefinition,
  buildSlotDescriptors,
  deleteExistingScratchForSlot,
  execFileAsync,
  isSlotEligibleForPrewarm,
  normalizePoolConfig,
  normalizePrewarmOptions,
  toRestRecordPayload,
  toScratchExpirationDateTimeValue,
  toSfValuesArgument
} = require('./scratch-pool-admin');

test('buildSlotDescriptors creates stable slot keys and aliases', () => {
  assert.deepEqual(
    buildSlotDescriptors({
      targetSize: 3,
      slotKeyPrefix: 'slot',
      scratchAliasPrefix: 'ALV_E2E_POOL'
    }),
    [
      { slotKey: 'slot-01', scratchAlias: 'ALV_E2E_POOL_01' },
      { slotKey: 'slot-02', scratchAlias: 'ALV_E2E_POOL_02' },
      { slotKey: 'slot-03', scratchAlias: 'ALV_E2E_POOL_03' }
    ]
  );
});

test('normalizePoolConfig applies defaults and respects explicit overrides', () => {
  const config = normalizePoolConfig([
    'bootstrap',
    '--pool-key',
    'alv-e2e',
    '--target-size',
    '5',
    '--scratch-duration-days',
    '21',
    '--lease-ttl-seconds',
    '1800',
    '--disabled'
  ]);

  assert.equal(config.poolKey, 'alv-e2e');
  assert.equal(config.targetSize, 5);
  assert.equal(config.scratchDurationDays, 21);
  assert.equal(config.leaseTtlSeconds, 1800);
  assert.equal(config.enabled, false);
  assert.equal(config.seedVersion, 'alv-e2e-baseline-v1');
  assert.equal(config.seedVersionSpecified, false);
});

test('normalizePrewarmOptions keeps limit optional and validates explicit limits', () => {
  assert.deepEqual(normalizePrewarmOptions(['prewarm', '--pool-key', 'alv-e2e']), {
    limit: undefined
  });

  assert.deepEqual(normalizePrewarmOptions(['prewarm', '--pool-key', 'alv-e2e', '--limit', '7']), {
    limit: 7
  });
});

test('isSlotEligibleForPrewarm accepts only available slots', () => {
  assert.equal(isSlotEligibleForPrewarm({ LeaseState__c: 'available' }), true);
  assert.equal(isSlotEligibleForPrewarm({ LeaseState__c: 'leased' }), false);
  assert.equal(isSlotEligibleForPrewarm({ LeaseState__c: 'provisioning' }), false);
  assert.equal(isSlotEligibleForPrewarm({ LeaseState__c: 'disabled' }), false);
  assert.equal(isSlotEligibleForPrewarm({ LeaseState__c: '' }), false);
});

test('buildPoolScratchDefinition stamps slot tracking metadata into the scratch definition', () => {
  assert.deepEqual(
    buildPoolScratchDefinition({
      poolKey: 'alv-e2e',
      slotKey: 'slot-07',
      definitionHash: 'hash-123',
      seedVersion: 'seed-v2'
    }),
    {
      orgName: 'apex-log-viewer-e2e',
      edition: 'Developer',
      hasSampleData: false,
      alvPoolKey__c: 'alv-e2e',
      alvSlotKey__c: 'slot-07',
      alvDefinitionHash__c: 'hash-123',
      alvSeedVersion__c: 'seed-v2'
    }
  );
});

test('toSfValuesArgument serializes strings, booleans, numbers, and nulls', () => {
  assert.equal(
    toSfValuesArgument({
      Name: 'Pool Alpha',
      Enabled__c: true,
      TargetSize__c: 3,
      SnapshotName__c: null,
      Note__c: "Owner's slot"
    }),
    "Name='Pool Alpha' Enabled__c=true TargetSize__c=3 SnapshotName__c=null Note__c='Owner\\'s slot'"
  );
});

test('toRestRecordPayload preserves nulls and drops only undefined fields', () => {
  assert.deepEqual(
    toRestRecordPayload({
      Name: 'Pool Alpha',
      Enabled__c: true,
      SnapshotName__c: null,
      DefinitionHash__c: undefined
    }),
    {
      Name: 'Pool Alpha',
      Enabled__c: true,
      SnapshotName__c: null
    }
  );
});

test('toScratchExpirationDateTimeValue converts date-only values to end-of-day UTC', () => {
  assert.equal(toScratchExpirationDateTimeValue('2026-04-21'), '2026-04-21T23:59:59.000Z');
  assert.equal(toScratchExpirationDateTimeValue('2026-04-21T12:34:56.000Z'), '2026-04-21T12:34:56.000Z');
  assert.equal(toScratchExpirationDateTimeValue(''), null);
});

test('execFileAsync honors timeoutMs and kills the child process', async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    killed = true;
    child.emit('close', null);
    return true;
  };

  await assert.rejects(
    execFileAsync('sf', ['org', 'list'], {
      spawnImpl: () => child,
      timeoutMs: 10
    }),
    /Command timed out after 10ms: sf org list/
  );

  assert.equal(killed, true);
});

test('deleteExistingScratchForSlot falls back to ScratchOrgInfo when ActiveScratchOrg delete is stale', async () => {
  const deletes = [];

  await deleteExistingScratchForSlot(
    'DevHub',
    'alv-e2e',
    {
      SlotKey__c: 'slot-01',
      ScratchOrgInfoId__c: '2SRxx0000000001',
      ActiveScratchOrgId__c: '00Dxx0000000001'
    },
    {
      callSalesforceRest: async (_targetOrg, method, resourcePath) => {
        deletes.push({ method, resourcePath });
        if (resourcePath.includes('/ActiveScratchOrg/')) {
          throw new Error('NOT_FOUND');
        }
      },
      isDeleteNotFoundError: error => String(error?.message || '').includes('NOT_FOUND')
    }
  );

  assert.deepEqual(deletes, [
    {
      method: 'DELETE',
      resourcePath: '/sobjects/ActiveScratchOrg/00Dxx0000000001'
    },
    {
      method: 'DELETE',
      resourcePath: '/sobjects/ScratchOrgInfo/2SRxx0000000001'
    }
  ]);
});
