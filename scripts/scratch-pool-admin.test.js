const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const { existsSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { main } = require('./scratch-pool-admin');

const {
  bootstrapPool,
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

test('pool commands reject missing CI JWT before reading or mutating the pool', async t => {
  t.mock.property(process, 'env', {
    ...process.env,
    CI: 'true',
    SF_DEVHUB_ALIAS: 'CachedDevHub',
    SF_DEVHUB_AUTH_URL: 'force://legacy-credential'
  });
  for (const name of ['SF_DEVHUB_CLIENT_ID', 'SF_DEVHUB_USERNAME', 'SF_DEVHUB_LOGIN_URL',
    'SF_DEVHUB_PRIVATE_KEY', 'SF_DEVHUB_PRIVATE_KEY_FILE']) delete process.env[name];
  for (const command of ['bootstrap', 'list', 'reconcile', 'prewarm', 'disable-slot', 'reset-slot']) {
    await assert.rejects(
      main([command, '--pool-key', 'isolated', '--slot-key', 'slot-01', '--target-org', 'CachedDevHub'], {
        spawnImpl: () => { throw new Error('Must not invoke Salesforce before configuration is valid'); },
        fetchImpl: () => { throw new Error('Must not access the pool before configuration is valid'); }
      }),
      /CI requires complete Dev Hub JWT configuration/
    );
  }
});

function poolSalesforce(t) {
  const privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  }).privateKey;
  t.mock.property(process, 'env', {
    ...process.env, CI: 'true', SF_DEVHUB_CLIENT_ID: 'fixture-client',
    SF_DEVHUB_USERNAME: 'operator@example.com', SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
    SF_DEVHUB_PRIVATE_KEY: privateKey, SF_CLI_BIN_PATH: 'C:/fixture path/sf.cmd',
    NODE_EXTRA_CA_CERTS: 'C:/approved-corporate-ca.pem'
  });
  delete process.env.SF_DEVHUB_PRIVATE_KEY_FILE;
  t.mock.method(console, 'log', () => {});
  const pool = { Id: 'pool-id', PoolKey__c: 'isolated', TargetSize__c: 1,
    ScratchDurationDays__c: 1, SeedVersion__c: 'seed-v1' };
  const slot = { Id: 'slot-id', SlotKey__c: 'slot-01', ScratchAlias__c: 'ISOLATED_01',
    Pool__c: pool.Id, Pool__r: pool, LeaseState__c: 'available', HealthState__c: 'needs_recreate',
    LastModifiedDate: '2026-09-01T00:00:00.000Z' };
  const authUrl = 'force://PlatformCLI::fixture-refresh@scratch.example.com';
  const state = { pool, slot, authUrl, created: false, imported: false, deleted: false,
    keyFiles: [], cliCalls: [], requests: [], failures: [], homes: new Map() };
  t.after(() => {
    for (const key of state.keyFiles) {
      const directory = path.resolve(path.dirname(key));
      assert.equal(path.dirname(directory), path.resolve(tmpdir()));
      assert.equal(path.basename(directory).startsWith('alv-devhub-jwt-'), true);
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const homeField = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const check = action => {
    try { return action(); } catch (error) { state.failures.push(error); throw error; }
  };
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      try {
        const result = check(() => {
          const env = options.env;
          const home = env[homeField];
          state.cliCalls.push({ file, args, env });
          assert.equal(env.SF_DEVHUB_PRIVATE_KEY, undefined);
          assert.equal(env.NODE_EXTRA_CA_CERTS, 'C:/approved-corporate-ca.pem');
          const command = args.slice(0, 3).join(' ');
          if (command === 'org login jwt') {
            assert.equal(env.SF_SCRATCH_SIGNUP_CONNECTED_APP, undefined);
            const key = args[args.indexOf('--jwt-key-file') + 1];
            assert.equal(readFileSync(key, 'utf8'), privateKey.trim());
            state.keyFiles.push(key);
            state.homes.set(home, key);
            return { username: 'operator@example.com' };
          }
          if (command === 'org login sfdx-url') {
            assert.equal(readFileSync(args[args.indexOf('--sfdx-url-file') + 1], 'utf8'), authUrl);
            state.imported = true;
            return { username: 'scratch@example.com' };
          }
          if (args[1] !== 'logout') assert.equal(existsSync(state.homes.get(home)), true);
          if (command === 'org create scratch') {
            assert.equal(env.SF_SCRATCH_SIGNUP_CONNECTED_APP, 'PlatformCLI');
            assert.equal(env.SF_SCRATCH_SIGNUP_CALLBACK_URL, 'http://localhost:1717/OauthRedirect');
            assert.equal(args[args.indexOf('--target-dev-hub') + 1], 'operator@example.com');
            if (state.signupError) throw new Error(state.signupError);
            state.created = true;
            return { username: 'scratch@example.com' };
          }
          if (args[0] === 'org' && args[1] === 'display') {
            return { username: args.includes('operator@example.com') ? 'operator@example.com' : 'scratch@example.com',
              instanceUrl: 'https://devhub.example.com', apiVersion: '66.0' };
          }
          if (command === 'org auth show-access-token') return { accessToken: 'fixture-access-token' };
          if (command === 'org auth show-sfdx-auth-url') {
            return { sfdxAuthUrl: state.exportValue ?? (env.SF_TEMP_SHOW_SECRETS === 'true' ? authUrl : '[REDACTED]') };
          }
          if (args[0] === 'data' && args[1] === 'query') {
            const query = args[args.indexOf('--query') + 1];
            if (query.includes('FROM ALV_ScratchOrgPool__c')) return { done: true, records: [pool] };
            if (query.includes('FROM ALV_ScratchOrgPoolSlot__c')) return { done: true, records: [{ ...slot }] };
            if (query.includes('FROM ScratchOrgInfo') && state.latestQueryResponse) return state.latestQueryResponse;
            if (query.includes('FROM ScratchOrgInfo'))
              return {
                done: true,
                records:
                  state.created && !state.deleted
                    ? [
                        {
                          Id: 'info-id',
                          SignupUsername: 'scratch@example.com',
                          ScratchOrg: 'scratch-id',
                          Status: 'Active'
                        }
                      ]
                    : state.historicalInfo
                      ? [state.historicalInfo]
                      : []
              };
            if (query.includes('FROM ActiveScratchOrg'))
              return {
                done: true,
                records:
                  state.created && !state.deleted
                    ? [{ Id: 'active-id', SignupUsername: 'scratch@example.com', ScratchOrg: 'scratch-id' }]
                    : []
              };
            if (query.includes('FROM DebugLevel')) return { done: true, records: [{ Id: 'debug-id' }] };
          }
          if (args[1] === 'logout' && state.logoutError) throw new Error(state.logoutError);
          if (args[1] === 'logout' || args[0] === 'alias') return {};
          throw new Error('Unexpected CLI operation');
        });
        child.stdout.emit('data', JSON.stringify({ status: 0, result }));
        child.emit('close', 0);
      } catch (error) {
        if (state.cliWarning) {
          child.stdout.emit('data', JSON.stringify({ status: 1, name: error.message.split(':')[0], message: error.message }));
          child.stderr.emit('data', state.cliWarning);
        } else child.stderr.emit('data', error.message);
        child.emit('close', 1);
      }
    });
    return child;
  };
  const fetchImpl = async (url, options) => check(() => {
    assert.equal(state.keyFiles.some(key => existsSync(key)), true);
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.requests.push({ url, ...options, body });
    if (options.method === 'PATCH') {
      if (body.LeaseState__c === 'provisioning') {
        assert.equal(options.headers['If-Unmodified-Since'], 'Tue, 01 Sep 2026 00:00:00 GMT');
      }
      Object.assign(url.endsWith('/pool-id') ? pool : slot, body);
    } else if (options.method === 'DELETE') state.deleted = true;
    return { ok: true, status: 204, text: async () => '' };
  });
  return { state, dependencies: { spawnImpl, fetchImpl } };
}

test('JWT prewarm persists usable scratch authorization through the existing pool contract', async t => {
  const { state, dependencies } = poolSalesforce(t);
  const result = await main(['prewarm', '--pool-key', 'isolated', '--limit', '1', '--json'], dependencies);
  assert.deepEqual(result.prewarmedSlotKeys, ['slot-01']);
  assert.equal(state.slot.ScratchAuthUrl__c, state.authUrl);
  assert.equal(state.slot.LeaseState__c, 'available');
  assert.equal(state.imported, true);
  assert.equal(state.keyFiles.every(key => !existsSync(key)), true);
  assert.equal(state.cliCalls.every(call => call.file === 'C:/fixture path/sf.cmd'), true);
  assert.equal(process.env.SF_TEMP_SHOW_SECRETS, undefined);
  assert.deepEqual(state.failures, []);
});

for (const source of ['stored', 'fallback', 'stale-stored']) {
  test(`prewarm replaces historical Deleted signup through ${source} metadata without its former owner`, async t => {
    const { state, dependencies } = poolSalesforce(t);
    state.historicalInfo = { Id: 'old-info', Status: 'Deleted' };
    state.slot.ScratchOrgInfoId__c =
      source === 'stored' ? 'old-info' : source === 'stale-stored' ? 'stale-info' : undefined;
    const request = dependencies.fetchImpl;
    dependencies.fetchImpl = async (url, options) => {
      if (url.includes('/sobjects/ScratchOrgInfo/stale-info')) {
        return { ok: false, status: 404, text: async () => '[{"errorCode":"NOT_FOUND"}]' };
      }
      if (options.method === 'DELETE') throw new Error('Historical signup must not be deleted again');
      if (url.includes('/sobjects/ScratchOrgInfo/old-info')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(state.historicalInfo) };
      }
      if (url.includes('/query')) {
        assert.match(decodeURIComponent(url), /FROM ActiveScratchOrg.*old-info/);
        return { ok: true, status: 200, text: async () => JSON.stringify({ done: true, records: [] }) };
      }
      return request(url, options);
    };
    const result = await main(['prewarm', '--pool-key', 'isolated', '--limit', '1', '--json'], dependencies);
    assert.deepEqual(result.prewarmedSlotKeys, ['slot-01']);
    assert.equal(state.slot.HealthState__c, 'healthy');
  });
}

for (const scenario of [
  'active',
  'contradictory',
  'missing-status',
  'wrong-id',
  'denied',
  'incomplete',
  'missing-records',
  'missing-done'
]) {
  test(`prewarm preserves credentials when historical deletion proof is ${scenario}`, async t => {
    const { state, dependencies } = poolSalesforce(t);
    state.historicalInfo = { Id: 'old-info', Status: scenario === 'active' ? 'Active' : 'Deleted' };
    if (scenario === 'missing-status') delete state.historicalInfo.Status;
    // A stored ID must be inspected independently of the latest metadata.
    Object.assign(state.slot, { ScratchOrgInfoId__c: 'stored-info', ScratchAuthUrl__c: state.authUrl });
    const request = dependencies.fetchImpl;
    dependencies.fetchImpl = async (url, options) => {
      if (options.method === 'DELETE' || (scenario === 'denied' && url.includes('/sobjects/ScratchOrgInfo/'))) {
        return { ok: false, status: 403, text: async () => '[{"errorCode":"INSUFFICIENT_ACCESS"}]' };
      }
      if (url.includes('/sobjects/ScratchOrgInfo/stored-info')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ...state.historicalInfo,
              Id: scenario === 'wrong-id' ? 'different-info' : 'stored-info'
            })
        };
      }
      if (url.includes('/query')) {
        const active = {
          done: scenario !== 'incomplete',
          records: scenario === 'contradictory' ? [{ Id: 'live-id' }] : []
        };
        if (scenario === 'missing-records') delete active.records;
        if (scenario === 'missing-done') delete active.done;
        return { ok: true, status: 200, text: async () => JSON.stringify(active) };
      }
      return request(url, options);
    };
    await assert.rejects(
      main(['prewarm', '--pool-key', 'isolated'], dependencies),
      /incomplete ActiveScratchOrg|HTTP 403/
    );
    assert.equal(state.slot.ScratchAuthUrl__c, state.authUrl);
    assert.equal(state.slot.ScratchOrgInfoId__c, 'stored-info');
    assert.equal(state.slot.LeaseState__c, 'available');
    assert.equal(
      state.cliCalls.some(call => call.args.slice(0, 3).join(' ') === 'org create scratch'),
      false
    );
  });
}

for (const latestQueryResponse of [{}, { records: [] }, { done: false, records: [] }]) {
  test(`prewarm rejects incomplete fallback inventory: ${JSON.stringify(latestQueryResponse)}`, async t => {
    const { state, dependencies } = poolSalesforce(t);
    state.latestQueryResponse = latestQueryResponse;
    await assert.rejects(main(['prewarm', '--pool-key', 'isolated'], dependencies), /incomplete Salesforce query/);
    assert.equal(state.created, false);
    assert.equal(state.slot.LeaseState__c, 'available');
  });
}

test('prewarm failure releases its maintenance lease with recoverable secret-safe diagnostics', async t => {
  const { state, dependencies } = poolSalesforce(t);
  state.signupError = 'C-1016 force://PlatformCLI::private-refresh@scratch.example.com consumer-secret';
  await assert.rejects(main(['prewarm', '--pool-key', 'isolated'], dependencies), error => {
    assert.match(error.message, /C-1016/);
    assert.doesNotMatch(error.message, /private-refresh|consumer-secret/);
    return true;
  });
  assert.equal(state.slot.LeaseState__c, 'available');
  assert.equal(state.slot.LeaseToken__c, null);
  assert.equal(state.slot.HealthState__c, 'needs_recreate');
  assert.equal(state.slot.LastRunResult__c, 'prewarm_failed');
  assert.doesNotMatch(state.slot.LastError__c, /private-refresh|consumer-secret/);
  assert.equal(state.keyFiles.every(key => !existsSync(key)), true);
});

test('prewarm preserves an existing scratch credential when its owner must perform deletion', async t => {
  const { state, dependencies } = poolSalesforce(t);
  state.created = true;
  Object.assign(state.slot, { ScratchUsername__c: 'scratch@example.com',
    ScratchAuthUrl__c: state.authUrl, ScratchOrgInfoId__c: 'info-id', ActiveScratchOrgId__c: 'active-id' });
  const request = dependencies.fetchImpl;
  dependencies.fetchImpl = async (url, options) => options.method === 'DELETE'
    ? { ok: false, status: 403, text: async () => JSON.stringify([
      { errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'private-refresh consumer-secret' }
    ]) }
    : request(url, options);
  await assert.rejects(main(['prewarm', '--pool-key', 'isolated'], dependencies), error => {
    assert.match(error.message, /existing owner|administrator/);
    assert.doesNotMatch(error.message, /private-refresh|consumer-secret/);
    return true;
  });
  assert.equal(state.slot.ScratchAuthUrl__c, state.authUrl);
  assert.equal(state.slot.ScratchOrgInfoId__c, 'info-id');
  assert.equal(state.slot.LeaseState__c, 'available');
  assert.equal(state.slot.HealthState__c, 'needs_recreate');
  assert.equal(state.cliCalls.some(call => call.args[1] === 'logout'), false);
  assert.equal(state.cliCalls.some(call => call.args.slice(0, 3).join(' ') === 'org create scratch'), false);
});

test('admin renews an expired REST token in its originating JWT home before retrying the conditional update', async t => {
  const { state, dependencies } = poolSalesforce(t);
  const request = dependencies.fetchImpl;
  let expired = false;
  dependencies.fetchImpl = async (url, options) => {
    if (!expired) {
      expired = true;
      return { ok: false, status: 401, text: async () => '[{"errorCode":"INVALID_SESSION_ID"}]' };
    }
    return request(url, options);
  };
  await main(['prewarm', '--pool-key', 'isolated'], dependencies);
  const tokenReads = state.cliCalls.filter(call => call.args.includes('show-access-token'));
  assert.equal(tokenReads.length, 2);
  const homeField = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  assert.equal(tokenReads.every(call => call.env[homeField] === path.dirname(state.keyFiles[0])), true);
  assert.equal(state.slot.HealthState__c, 'healthy');
  assert.equal(state.keyFiles.every(key => !existsSync(key)), true);
});

test('maintenance removes only the exact scratch authorization after confirmed remote deletion', async t => {
  const { state, dependencies } = poolSalesforce(t);
  state.created = true;
  Object.assign(state.slot, { SlotKey__c: 'slot-02', ScratchUsername__c: 'scratch@example.com',
    ScratchAuthUrl__c: state.authUrl, ScratchOrgInfoId__c: 'info-id', ActiveScratchOrgId__c: 'active-id' });
  const spawnImpl = dependencies.spawnImpl;
  dependencies.spawnImpl = (file, args, options) => {
    if (args[1] === 'logout') assert.equal(state.deleted, true);
    return spawnImpl(file, args, options);
  };
  const result = await main(['bootstrap', '--pool-key', 'isolated', '--target-size', '1'], dependencies);
  assert.deepEqual(result.disabledSlotKeys, ['slot-02']);
  const logouts = state.cliCalls.filter(call => call.args[1] === 'logout');
  assert.equal(logouts.length, 2);
  assert.equal(logouts.every(call => call.args[call.args.indexOf('--target-org') + 1] === 'scratch@example.com'), true);
  assert.equal(state.slot.ScratchAuthUrl__c, null);
});

test('list returns existing pool records without disclosing credentials or lease tokens', async t => {
  const { state, dependencies } = poolSalesforce(t);
  Object.assign(state.slot, { ScratchAuthUrl__c: state.authUrl, LeaseToken__c: 'private-lease-token' });
  const result = await main(['list', '--pool-key', 'isolated', '--json'], dependencies);
  assert.equal(result.slots[0].SlotKey__c, 'slot-01');
  assert.doesNotMatch(JSON.stringify(result), /fixture-refresh|private-lease-token/);
});

test('maintenance completes when the current CLI has no local auth for a remotely deleted scratch', async t => {
  const { state, dependencies } = poolSalesforce(t);
  state.created = true;
  state.logoutError = 'NoAuthFoundForTargetOrgError: No authenticated org found';
  state.cliWarning = 'Warning: NO_COLOR is ignored due to FORCE_COLOR';
  Object.assign(state.slot, { SlotKey__c: 'slot-02', ScratchUsername__c: 'scratch@example.com',
    ScratchAuthUrl__c: state.authUrl, ScratchOrgInfoId__c: 'info-id', ActiveScratchOrgId__c: 'active-id' });
  const result = await main(['bootstrap', '--pool-key', 'isolated', '--target-size', '1'], dependencies);
  assert.deepEqual(result.disabledSlotKeys, ['slot-02']);
  assert.equal(state.slot.ScratchAuthUrl__c, null);
  assert.equal(state.deleted, true);
});

test('prewarm loses a conditional lease race without creating or overwriting a scratch', async t => {
  const { state, dependencies } = poolSalesforce(t);
  dependencies.fetchImpl = async () => ({ ok: false, status: 412,
    text: async () => '[{"message":"private-lease-token"}]' });
  const result = await main(['prewarm', '--pool-key', 'isolated'], dependencies);
  assert.deepEqual(result.prewarmedSlotKeys, []);
  assert.equal(state.created, false);
  assert.equal(state.slot.LeaseState__c, 'available');
  assert.equal(state.keyFiles.every(key => !existsSync(key)), true);
});

test('a redacted export preserves the only new scratch authorization for recovery', async t => {
  const { state, dependencies } = poolSalesforce(t);
  state.exportValue = '[REDACTED]';
  await assert.rejects(main(['prewarm', '--pool-key', 'isolated'], dependencies), error => {
    assert.match(error.message, /Credential cleanup deferred to preserve access/);
    assert.equal(error.message.includes(path.dirname(state.keyFiles[0])), true);
    return true;
  });
  assert.equal(state.created, true);
  assert.equal(state.imported, false);
  assert.equal(state.slot.ScratchAuthUrl__c, null);
  assert.equal(state.slot.HealthState__c, 'needs_recreate');
  assert.equal(existsSync(state.keyFiles[0]), true);
  assert.equal(state.cliCalls.some(call => call.args[1] === 'logout'), false);
});

test('reconcile identifies a stored redaction placeholder as requiring recreation', async t => {
  const { state, dependencies } = poolSalesforce(t);
  state.created = true;
  state.slot.ScratchAuthUrl__c = '[REDACTED]';
  const result = await main(['reconcile', '--pool-key', 'isolated'], dependencies);
  assert.equal(result.healthySlots, 0);
  assert.equal(result.needsRecreateSlots, 1);
  assert.equal(state.slot.HealthState__c, 'needs_recreate');
});

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

test('normalizePoolConfig defaults the pool to thirty logical slots', () => {
  const config = normalizePoolConfig(['bootstrap', '--pool-key', 'alv-e2e']);

  assert.equal(config.targetSize, 30);
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
        if (method === 'DELETE') deletes.push({ method, resourcePath });
        if (resourcePath.includes('/ActiveScratchOrg/')) {
          throw new Error('NOT_FOUND');
        }
      },
      getLatestScratchOrgInfo: async () => undefined,
      getActiveScratchOrgByInfoId: async () => undefined,
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

test('deleteExistingScratchForSlot retries cleanup with the latest scratch metadata when stored ids are stale', async () => {
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
        if (method === 'DELETE') deletes.push({ method, resourcePath });
        if (
          resourcePath === '/sobjects/ActiveScratchOrg/00Dxx0000000001' ||
          resourcePath === '/sobjects/ScratchOrgInfo/2SRxx0000000001'
        ) {
          throw new Error('NOT_FOUND');
        }
      },
      getLatestScratchOrgInfo: async () => ({ Id: '2SRxx0000000002' }),
      getActiveScratchOrgByInfoId: async (_targetOrg, scratchOrgInfoId) =>
        scratchOrgInfoId === '2SRxx0000000002' ? { Id: '00Dxx0000000002' } : undefined,
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
      resourcePath: '/sobjects/ActiveScratchOrg/00Dxx0000000002'
    },
    {
      method: 'DELETE',
      resourcePath: '/sobjects/ScratchOrgInfo/2SRxx0000000001'
    },
    {
      method: 'DELETE',
      resourcePath: '/sobjects/ScratchOrgInfo/2SRxx0000000002'
    }
  ]);
});

test('deleteExistingScratchForSlot deduplicates stored and latest scratch ids', async () => {
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
        if (method === 'DELETE') deletes.push({ method, resourcePath });
      },
      getLatestScratchOrgInfo: async () => ({ Id: '2SRxx0000000001' }),
      getActiveScratchOrgByInfoId: async (_targetOrg, scratchOrgInfoId) =>
        scratchOrgInfoId === '2SRxx0000000001' ? { Id: '00Dxx0000000001' } : undefined,
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

test('bootstrapPool disables surplus slots and clears stored auth when target size shrinks', async () => {
  const config = normalizePoolConfig([
    'bootstrap',
    '--pool-key',
    'alv-e2e',
    '--target-size',
    '2'
  ]);

  const updates = [];
  const deletedSlots = [];
  const poolRecord = {
    Id: 'a00Pool',
    PoolKey__c: 'alv-e2e',
    DefinitionHash__c: 'hash-v1',
    SeedVersion__c: 'seed-v1'
  };
  const existingSlots = [
    { Id: 'slot1', SlotKey__c: 'slot-01', ScratchAlias__c: 'OLD_01', LeaseState__c: 'available' },
    { Id: 'slot2', SlotKey__c: 'slot-02', ScratchAlias__c: 'OLD_02', LeaseState__c: 'available' },
    {
      Id: 'slot3',
      SlotKey__c: 'slot-03',
      ScratchAlias__c: 'OLD_03',
      LeaseState__c: 'available',
      ScratchAuthUrl__c: 'force://slot03'
    },
    {
      Id: 'slot4',
      SlotKey__c: 'slot-04',
      ScratchAlias__c: 'OLD_04',
      LeaseState__c: 'available',
      ScratchAuthUrl__c: 'force://slot04'
    }
  ];

  const result = await bootstrapPool('DevHub', config, {
    getPoolByKey: async () => poolRecord,
    getSlotsByPoolId: async () => existingSlots,
    createRecord: async () => {
      throw new Error('createRecord should not be called when shrinking an existing pool.');
    },
    updateRecord: async (_targetOrg, objectName, recordId, values) => {
      updates.push({ objectName, recordId, values });
    },
    deleteExistingScratchForSlot: async (_targetOrg, _poolKey, slot) => {
      deletedSlots.push(slot.SlotKey__c);
    }
  });

  assert.deepEqual(result.disabledSlotKeys, ['slot-03', 'slot-04']);
  assert.deepEqual(deletedSlots, ['slot-03', 'slot-04']);

  const slot3Disable = updates.find(update => update.recordId === 'slot3');
  const slot4Disable = updates.find(update => update.recordId === 'slot4');
  assert.equal(slot3Disable?.values.LeaseState__c, 'disabled');
  assert.equal(slot3Disable?.values.ScratchAuthUrl__c, null);
  assert.equal(slot3Disable?.values.HealthState__c, 'needs_recreate');
  assert.equal(slot4Disable?.values.LeaseState__c, 'disabled');
  assert.equal(slot4Disable?.values.ScratchOrgId__c, null);
});

test('bootstrapPool re-enables desired slots when the target size grows again', async () => {
  const config = normalizePoolConfig([
    'bootstrap',
    '--pool-key',
    'alv-e2e',
    '--target-size',
    '3'
  ]);

  const updates = [];
  const poolRecord = {
    Id: 'a00Pool',
    PoolKey__c: 'alv-e2e',
    DefinitionHash__c: 'hash-v1',
    SeedVersion__c: 'seed-v1'
  };
  const existingSlots = [
    { Id: 'slot1', SlotKey__c: 'slot-01', ScratchAlias__c: 'OLD_01', LeaseState__c: 'available' },
    { Id: 'slot2', SlotKey__c: 'slot-02', ScratchAlias__c: 'OLD_02', LeaseState__c: 'available' },
    { Id: 'slot3', SlotKey__c: 'slot-03', ScratchAlias__c: 'OLD_03', LeaseState__c: 'disabled' }
  ];

  const result = await bootstrapPool('DevHub', config, {
    getPoolByKey: async () => poolRecord,
    getSlotsByPoolId: async () => existingSlots,
    createRecord: async () => {
      throw new Error('createRecord should not be called when re-enabling an existing slot.');
    },
    updateRecord: async (_targetOrg, objectName, recordId, values) => {
      updates.push({ objectName, recordId, values });
    },
    deleteExistingScratchForSlot: async () => {
      throw new Error('deleteExistingScratchForSlot should not run when a desired slot is re-enabled.');
    }
  });

  assert.deepEqual(result.disabledSlotKeys, []);

  const slot3Update = updates.find(update => update.recordId === 'slot3');
  assert.equal(slot3Update?.values.LeaseState__c, 'available');
  assert.equal(slot3Update?.values.HealthState__c, 'needs_recreate');
  assert.equal(
    slot3Update?.values.LastError__c,
    'Slot re-enabled after pool target size increased and must be recreated.'
  );
});
