const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { realpath } = require('node:fs/promises');
const path = require('node:path');
const { main } = require('./devhub-identity');
const {
  baseArgs,
  stateDirectory,
  provisioningFixture,
  preparedAppFixture,
  addRuntimeAssignment,
  addRuntimeGrantInventory
} = require('./devhub-identity-fixtures');

test('app setup refuses an incomplete or unknown preauthorization grant inventory', async t => {
  const { fixture, args } = await preparedAppFixture(t);
  const invoke = fixture.sf;
  fixture.sf = async (command, options) => {
    const result = await invoke(command, options);
    if (
      command[0] === 'data' &&
      command.includes('--query') &&
      command[command.indexOf('--query') + 1].includes(' FROM ObjectPermissions ')
    ) {
      return { ...result, done: false };
    }
    return result;
  };
  await assert.rejects(main(args, fixture), /Incomplete Salesforce inventory/);
  fixture.sf = invoke;
  fixture.permissionChildren.push(['NewGrantCategory', 'ParentId']);
  fixture.records.NewGrantCategory = [{ Id: 'new-grant' }];
  await assert.rejects(main(args, fixture), /preauthorization.*grant/i);
  fixture.permissionChildren = fixture.permissionChildren.filter(([object]) => object !== 'FieldPermissions');
  await assert.rejects(main(args, fixture), /preauthorization.*inventory/i);
});

test('app reruns reject enabled or unverified alternate OAuth flows from effective metadata', async t => {
  const { fixture, directory, args, first, deployments } = await preparedAppFixture(t);
  const invoke = fixture.sf;
  const initialDeployments = deployments();
  for (const flow of ['isClientCredentialsFlowEnabled', 'isGuestCodeCredFlowEnabled', 'isTokenExchangeFlowEnabled']) {
    for (const replacement of [`<${flow}>true</${flow}>`, '']) {
      fixture.sf = async (command, options) => {
        const result = await invoke(command, options);
        if (command[0] === 'project' && command[1] === 'retrieve') {
          const file = path.join(
            directory,
            'app-temporary',
            'retrieved',
            'force-app',
            'main',
            'default',
            'extlClntAppOauthPolicies',
            `${first.name}_oauthPlcy.ecaOauthPlcy-meta.xml`
          );
          writeFileSync(file, readFileSync(file, 'utf8').replace(`<${flow}>false</${flow}>`, replacement));
        }
        return result;
      };
      await assert.rejects(main(args, fixture), /Effective ECA/);
    }
  }
  assert.equal(deployments(), initialDeployments, 'Drift must be reported without silently rewriting active policy');
});

test('app reruns reject changed or missing effective global OAuth controls without redeploying', async t => {
  const { fixture, directory, args, first, deployments } = await preparedAppFixture(t);
  const invoke = fixture.sf;
  const initialDeployments = deployments();
  for (const [field, intended, changed] of [
    ['callbackUrl', 'http://localhost:1717/OauthRedirect', 'https://untrusted.example.test/callback'],
    ['isConsumerSecretOptional', 'false', 'true'],
    ['isIntrospectAllTokens', 'false', 'true'],
    ['isPkceRequired', 'true', 'false'],
    ['isSecretRequiredForRefreshToken', 'true', 'false'],
    ['shouldRotateConsumerKey', 'false', 'true'],
    ['shouldRotateConsumerSecret', 'false', 'true'],
    ['callbackUrl', 'http://localhost:1717/OauthRedirect', undefined]
  ]) {
    fixture.sf = async (command, options) => {
      const result = await invoke(command, options);
      if (command[0] === 'project' && command[1] === 'retrieve') {
        const file = path.join(
          directory,
          'app-temporary',
          'retrieved',
          'force-app',
          'main',
          'default',
          'extlClntAppGlobalOauthSets',
          `${first.name}_global.ecaGlblOauth-meta.xml`
        );
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace(
            `<${field}>${intended}</${field}>`,
            changed === undefined ? '' : `<${field}>${changed}</${field}>`
          )
        );
      }
      return result;
    };
    await assert.rejects(main(args, fixture), /Effective ECA/);
  }
  assert.equal(deployments(), initialDeployments);
});

test('app revocation disables only the owned ECA and confirms the effective policy before recording teardown', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const app = state.apps.temporary;
  const invoke = fixture.sf;
  let disabled = false,
    validated = false;
  fixture.sf = async (args, options) => {
    if (args[0] === 'project') {
      if (args[1] === 'deploy') {
        const file = path.join(
          options.cwd,
          'force-app',
          'main',
          'default',
          'extlClntAppPolicies',
          `${app.name}_plcy.ecaPlcy-meta.xml`
        );
        assert.match(readFileSync(file, 'utf8'), /<isEnabled>false<\/isEnabled>/);
        if (args.includes('--dry-run')) validated = true;
        else {
          assert.ok(validated);
          disabled = true;
        }
        return { success: true, status: 'Succeeded', checkOnly: args.includes('--dry-run'), id: '0Afrevoke' };
      }
      assert.ok(disabled);
      const file = path.join(
        options.cwd,
        'force-app',
        'main',
        'default',
        'extlClntAppPolicies',
        `${app.name}_plcy.ecaPlcy-meta.xml`
      );
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        '<ExtlClntAppConfigurablePolicies><isEnabled>false</isEnabled></ExtlClntAppConfigurablePolicies>'
      );
      return { success: true };
    }
    if (args[0] === 'org' && args[1] === 'login')
      throw Object.assign(new Error('invalid_client hidden-token'), { code: 'INVALID_CLIENT' });
    return invoke(args, options);
  };
  const result = await main(
    ['revoke-app', ...baseArgs.slice(1), '--state-dir', directory, '--credential-mode', 'temporary'],
    fixture
  );
  assert.equal(result.status, 'app-disabled');
  assert.equal(result.jwtRejection, 'INVALID_CLIENT');
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).apps.temporary.revoked, true);
  assert.equal(fixture.records.User[0].IsActive, true);
  assert.doesNotMatch(JSON.stringify(result), /hidden-token/);
});

test('cleanup-proof rejects an unknown persisted phase even when authenticated inventories are empty', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const id = require('node:crypto').randomUUID();
  state.proof = {
    id,
    appMode: 'temporary',
    phase: 'unknown-after-write',
    remoteResourcesAttempted: true,
    directory: path.join(await realpath(directory), `proof-${id}`),
    poolKey: `alv-identity-${id}`,
    slotKey: `alv-identity-${id}-01`
  };
  writeFileSync(stateFile, JSON.stringify(state));
  const persisted = readFileSync(stateFile);
  const invoke = fixture.sf;
  let reconciliationCalls = 0;
  fixture.sf = async (args, options) => {
    if (!options?.env) return invoke(args, options);
    reconciliationCalls++;
    assert.equal(args.slice(0, 2).join(' '), 'data query');
    return { records: [], done: true };
  };
  await assert.rejects(
    main(['cleanup-proof', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /Unknown or missing proof phase/
  );
  assert.equal(reconciliationCalls, 0, 'Unknown phases must stop before authenticated reconciliation');
  assert.ok(readFileSync(stateFile).equals(persisted), 'Rejected proof phase preserves identity state');
});

test('unknown current and historical phases cannot release proof, revocation or private-cleanup gates', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, baseline);
  const id = require('node:crypto').randomUUID();
  const proof = {
    id,
    appMode: 'temporary',
    phase: 'cleanup',
    remoteResourcesAttempted: true,
    directory: path.join(await realpath(directory), `proof-${id}`),
    poolKey: `alv-identity-${id}`,
    slotKey: `alv-identity-${id}-01`,
    cleanup: { scratchDeleted: true, poolDeleted: true, localDirectoryDeleted: true }
  };
  const privateInputs = readFileSync(baseline.apps.temporary.inputsFile);
  const privateKey = readFileSync(baseline.apps.temporary.privateKeyFile);
  const invoke = fixture.sf;
  let sideEffects = 0;
  fixture.sf = async (args, options) => {
    if (options?.env || args[0] === 'project' || ['create', 'update', 'delete'].includes(args[1])) {
      sideEffects++;
      throw new Error('Unknown phase reached a forbidden operation');
    }
    return invoke(args, options);
  };
  for (const [label, phase, historical] of [
    ['unknown', 'unknown-after-write', false],
    ['absent', undefined, false],
    ['null', null, false],
    ['number', 7, false],
    ['object', {}, false],
    ['historical', 'future-workflow-phase', true]
  ]) {
    await t.test(label, async () => {
      for (const command of ['cleanup-proof', 'prove', 'revoke-app', 'cleanup-app-files']) {
        const state = structuredClone(baseline);
        const unknown = { ...proof, phase };
        state.proof = historical ? { ...proof } : unknown;
        if (historical)
          state.proofHistory = [
            { ...proof, phase: 'login', remoteResourcesAttempted: false, cleanup: undefined },
            unknown
          ];
        state.apps.temporary.revoked = command === 'cleanup-app-files';
        writeFileSync(stateFile, JSON.stringify(state));
        const persisted = readFileSync(stateFile);
        await assert.rejects(
          main(
            [
              command,
              ...baseArgs.slice(1),
              '--state-dir',
              directory,
              '--credential-mode',
              'temporary',
              '--pool-mode',
              'definition'
            ],
            fixture
          ),
          /Unknown or missing proof phase/
        );
        assert.equal(sideEffects, 0);
        assert.ok(readFileSync(stateFile).equals(persisted), 'Validate all phases before changing any ledger entry');
        assert.ok(readFileSync(state.apps.temporary.inputsFile).equals(privateInputs), 'Private inputs are preserved');
        assert.ok(readFileSync(state.apps.temporary.privateKeyFile).equals(privateKey), 'Private key is preserved');
      }
    });
  }
});

test('cleanup-proof recovers persisted pre-resource interruptions without directories or authentication', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, baseline);
  const invoke = fixture.sf;
  const proofArgs = [
    'prove',
    ...baseArgs.slice(1),
    '--state-dir',
    directory,
    '--credential-mode',
    'temporary',
    '--pool-mode',
    'definition'
  ];
  for (const [phase, marker, preparedHomes] of [
    ['initializing', false, -1],
    ['initializing', false, 0],
    ['initializing', false, 1],
    ['login', false, 2],
    ['login', undefined, -1],
    ['pool-create', false, 2]
  ]) {
    const id = require('node:crypto').randomUUID();
    const proof = {
      id,
      phase,
      appMode: 'temporary',
      directory: path.join(await realpath(directory), `proof-${id}`),
      poolKey: `alv-identity-${id}`,
      slotKey: `alv-identity-${id}-01`,
      ...(marker === undefined ? {} : { remoteResourcesAttempted: marker })
    };
    if (preparedHomes >= 0) mkdirSync(proof.directory);
    for (const home of ['home-a', 'home-b'].slice(0, Math.max(0, preparedHomes)))
      mkdirSync(path.join(proof.directory, home));
    writeFileSync(stateFile, JSON.stringify({ ...baseline, proof }));
    let runtimeCommands = 0;
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      runtimeCommands += 1;
      throw new Error('No runtime authentication exists at this interrupted boundary');
    };
    const result = await main(['cleanup-proof', ...proofArgs.slice(1)], fixture);
    assert.equal(result.proofs[0].cleanup.scratchDeleted, true);
    assert.equal(result.proofs[0].cleanup.poolDeleted, true);
    assert.equal(result.proofs[0].cleanup.remoteResourcesAttempted, false);
    assert.equal(runtimeCommands, 0, 'Known pre-resource intent needs no authenticated remote inventory');
    // Recovery releases the next proof gate; the fresh attempt reaches login.
    await assert.rejects(main(proofArgs, fixture), /Native proof failed at login/);
    assert.equal(runtimeCommands, 1);
    // Revocation is no longer blocked by a proof that never attempted resources.
    fixture.sf = async (args, options) => {
      if (args[0] === 'project' && args[1] === 'deploy') return { success: false };
      return invoke(args, options);
    };
    await assert.rejects(main(['revoke-app', ...proofArgs.slice(1)], fixture), /Metadata validation failed/);
  }
});

test('proof initialization failures enter recovery before any remote operation', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, state);
  writeFileSync(stateFile, JSON.stringify(state));
  const promises = require('node:fs/promises');
  const mkdir = promises.mkdir;
  const mocked = t.mock.method(promises, 'mkdir', async (target, options) => {
    const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
    if (target === proof?.directory) {
      assert.equal(proof.phase, 'initializing', 'Inject failure only after proof initialization intent is saved');
      throw Object.assign(new Error('Directory unavailable'), { code: 'EACCES' });
    }
    return mkdir(target, options);
  });
  await assert.rejects(
    main(
      [
        'prove',
        ...baseArgs.slice(1),
        '--state-dir',
        directory,
        '--credential-mode',
        'temporary',
        '--pool-mode',
        'definition'
      ],
      fixture
    ),
    /Native proof failed at initializing/
  );
  mocked.mock.restore();
  const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
  assert.equal(proof.remoteResourcesAttempted, false);
  assert.equal(proof.cleanup.scratchDeleted, true);
  assert.equal(proof.cleanup.poolDeleted, true);
});

test('cleanup-proof retains uncertain, attempted, incomplete and conflicting remote state', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  const invoke = fixture.sf;
  for (const [details, scenario, expected] of [
    [{ phase: 'initializing' }, 'missing-auth', /Salesforce CLI operation failed/],
    [{ phase: 'login', remoteResourcesAttempted: true }, 'missing-auth', /Salesforce CLI operation failed/],
    [{ phase: 'pool-create' }, 'missing-auth', /Salesforce CLI operation failed/],
    [
      { phase: 'login', remoteResourcesAttempted: false, poolId: 'uncertain-pool' },
      'missing-auth',
      /Salesforce CLI operation failed/
    ],
    [
      { phase: 'login', remoteResourcesAttempted: false, completedAt: '2026-09-07T00:00:00Z' },
      'missing-auth',
      /Salesforce CLI operation failed/
    ],
    [{ phase: 'pool-create', remoteResourcesAttempted: true }, 'incomplete', /inventory is incomplete/],
    [{ phase: 'scratch-create', remoteResourcesAttempted: true }, 'foreign-owner', /ownership conflict/],
    [{ phase: 'scratch-create', remoteResourcesAttempted: true }, 'pending', /still pending/]
  ]) {
    const id = require('node:crypto').randomUUID();
    const proof = {
      id,
      appMode: 'temporary',
      directory: path.join(await realpath(directory), `proof-${id}`),
      poolKey: `alv-identity-${id}`,
      slotKey: `alv-identity-${id}-01`,
      ...details
    };
    writeFileSync(stateFile, JSON.stringify({ ...baseline, proof }));
    let queries = 0;
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      assert.equal(args.slice(0, 2).join(' '), 'data query', 'Uncertain inventory must never permit deletion');
      queries += 1;
      if (scenario === 'missing-auth') throw new Error('No runtime authentication');
      if (scenario === 'incomplete') return { records: [], done: false };
      return {
        records: [
          { Id: 'signup', CreatedById: scenario === 'foreign-owner' ? 'another-user' : '005runtime', Status: 'New' }
        ]
      };
    };
    await assert.rejects(main(['cleanup-proof', ...baseArgs.slice(1), '--state-dir', directory], fixture), expected);
    assert.equal(queries, 1);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).proof.cleanup, undefined);
  }
});

test('cleanup-proof distinguishes confirmed deletion from an unacknowledged delete and preserves retry ownership', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  const invoke = fixture.sf;
  for (const lostDeleteResponse of [false, true]) {
    const id = require('node:crypto').randomUUID();
    const proof = {
      id,
      appMode: 'temporary',
      phase: 'scratch-create',
      remoteResourcesAttempted: true,
      directory: path.join(await realpath(directory), `proof-${id}`),
      poolKey: `alv-identity-${id}`,
      slotKey: `alv-identity-${id}-01`
    };
    writeFileSync(stateFile, JSON.stringify({ ...baseline, proof }));
    let active = true,
      pool = true,
      signupStatus = 'Active',
      failPoolDelete = true;
    const deleted = [];
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      if (args[1] === 'delete') {
        const object = args[args.indexOf('--sobject') + 1];
        const record = args[args.indexOf('--record-id') + 1];
        if (object === 'ActiveScratchOrg') {
          assert.equal(record, 'own-active');
          active = false;
          deleted.push(record);
          if (lostDeleteResponse) throw new Error('Deletion response was lost');
          return { success: true };
        }
        assert.equal(object, 'ALV_ScratchOrgPool__c');
        assert.equal(record, 'own-pool');
        if (failPoolDelete) return { success: false };
        deleted.push(record);
        pool = false;
        return { success: true };
      }
      assert.equal(args.slice(0, 2).join(' '), 'data query');
      const soql = args[args.indexOf('--query') + 1];
      if (soql.includes('FROM ScratchOrgInfo '))
        return { records: [{ Id: 'own-signup', CreatedById: '005runtime', Status: signupStatus }] };
      if (soql.includes('FROM ActiveScratchOrg '))
        return { records: active ? [{ Id: 'own-active', OwnerId: '005runtime', ScratchOrgInfoId: 'own-signup' }] : [] };
      if (soql.includes('FROM ALV_ScratchOrgPool__c '))
        return { records: pool ? [{ Id: 'own-pool', CreatedById: '005runtime' }] : [] };
      return { records: [] };
    };
    const args = ['cleanup-proof', ...baseArgs.slice(1), '--state-dir', directory];
    await assert.rejects(
      main(args, fixture),
      lostDeleteResponse ? /Salesforce CLI operation failed/ : /deletion is unconfirmed/
    );
    const pending = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
    assert.equal(pending.cleanup, undefined);
    assert.equal(pending.scratchDeletionReceipts?.length || 0, lostDeleteResponse ? 0 : 1);
    await assert.rejects(
      main(['revoke-app', ...args.slice(1), '--credential-mode', 'temporary'], fixture),
      /Recover the owned scratch/
    );
    failPoolDelete = false;
    if (lostDeleteResponse) {
      await assert.rejects(main(args, fixture), /Active scratch is not yet observable/);
      assert.deepEqual(deleted, ['own-active']);
      signupStatus = 'Deleted';
    }
    const result = await main(args, fixture);
    assert.equal(result.proofs[0].cleanup.scratchDeleted, true);
    assert.equal(result.proofs[0].cleanup.poolDeleted, true);
    assert.deepEqual(deleted, ['own-active', 'own-pool'], 'Resume deletes only remaining owned resources');
  }
});

test('cleanup-proof accepts empty terminal signup cleanup and refuses incomplete or conflicting Active inventory', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  const invoke = fixture.sf;
  for (const scenario of [
    'Error',
    'Deleted',
    'New',
    'active-empty',
    'active-incomplete',
    'active-foreign-owner',
    'active-wrong-signup',
    'missing-signup-id'
  ]) {
    const id = require('node:crypto').randomUUID();
    const proof = {
      id,
      appMode: 'temporary',
      phase: 'scratch-create',
      remoteResourcesAttempted: true,
      directory: path.join(await realpath(directory), `proof-${id}`),
      poolKey: `alv-identity-${id}`,
      slotKey: `alv-identity-${id}-01`
    };
    writeFileSync(stateFile, JSON.stringify({ ...baseline, proof }));
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      assert.equal(args.slice(0, 2).join(' '), 'data query', 'Unconfirmed inventory must not permit deletion');
      const soql = args[args.indexOf('--query') + 1];
      if (soql.includes('FROM ScratchOrgInfo '))
        return {
          records: [
            {
              ...(scenario === 'missing-signup-id' ? {} : { Id: 'own-signup' }),
              CreatedById: '005runtime',
              Status: ['Error', 'Deleted', 'New'].includes(scenario) ? scenario : 'Active'
            }
          ]
        };
      if (soql.includes('FROM ActiveScratchOrg ')) {
        if (scenario === 'active-incomplete') return { records: [], done: false };
        if (['active-foreign-owner', 'active-wrong-signup'].includes(scenario))
          return {
            records: [
              {
                Id: 'visible-scratch',
                OwnerId: scenario === 'active-foreign-owner' ? 'other-user' : '005runtime',
                ScratchOrgInfoId: scenario === 'active-wrong-signup' ? 'other-signup' : 'own-signup'
              }
            ]
          };
      }
      return { records: [] };
    };
    const args = ['cleanup-proof', ...baseArgs.slice(1), '--state-dir', directory];
    if (['Error', 'Deleted'].includes(scenario))
      assert.equal((await main(args, fixture)).proofs[0].cleanup.scratchDeleted, true);
    else {
      await assert.rejects(
        main(args, fixture),
        /still pending|not yet observable|inventory is incomplete|owner differs/
      );
      assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).proof.cleanup, undefined);
    }
  }
});

for (const scenario of [
  'success',
  'import-failure',
  'redacted-export',
  'maintenance-health-mismatch',
  'maintenance-health-missing',
  'cleanup-failure',
  'http-failure',
  'signup-not-visible',
  'active-signup-not-visible',
  'definition-write-failure'
]) {
  test(`native identity proof preserves isolation, lease lifecycle and ownership: ${scenario}`, async t => {
    const { fixture, directory } = await preparedAppFixture(t);
    const stateFile = path.join(directory, 'identity.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    addRuntimeAssignment(fixture, state);
    writeFileSync(stateFile, JSON.stringify(state));
    const invoke = fixture.sf;
    const removed = [];
    let firstHome,
      secondHome,
      ownPool,
      ownSlot,
      signedUp = false,
      active = true,
      scratchVisible = scenario !== 'active-signup-not-visible',
      signupObserved = false;
    const routes = [];
    let maintained = false;
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      const env = options.env;
      const command = args.slice(0, 3).join(' ');
      assert.equal(env.SF_DEVHUB_AUTH_URL, undefined);
      if (command !== 'org create scratch') assert.equal(env.SF_SCRATCH_SIGNUP_CONNECTED_APP, undefined);
      if (command !== 'org display --target-org') assert.equal(env.SF_TEMP_SHOW_SECRETS, undefined);
      if (command === 'org login jwt') {
        const intent = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
        assert.equal(intent.phase, 'login');
        assert.equal(intent.remoteResourcesAttempted, false);
        firstHome = env.USERPROFILE;
        assert.deepEqual(require('node:fs').readdirSync(firstHome), []);
        return { orgId: state.org, username: fixture.records.User[0].Username };
      }
      if (command === 'data create record') {
        assert.equal(
          JSON.parse(readFileSync(stateFile, 'utf8')).proof.remoteResourcesAttempted,
          true,
          'Persist uncertainty before the first remote write, including a lost CLI response'
        );
        const object = args[args.indexOf('--sobject') + 1];
        if (object === 'ALV_ScratchOrgPool__c') ownPool = 'own-pool';
        else ownSlot = 'own-slot';
        return { id: object === 'ALV_ScratchOrgPool__c' ? ownPool : ownSlot, success: true };
      }
      if (command === 'api request rest') {
        const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
        const route = args[3].split('/').at(-1);
        routes.push(route);
        const bodyArgument = args[args.indexOf('--body') + 1];
        assert.ok(bodyArgument.startsWith('@'), 'Salesforce CLI 2.150.6 requires @ to read a request body file');
        const payload = JSON.parse(readFileSync(bodyArgument.slice(1), 'utf8'));
        assert.equal(payload.poolKey, proof.poolKey);
        assert.doesNotMatch(args.join(' '), /private-refresh-token|private-lease-token/);
        if (scenario === 'definition-write-failure' && route === 'acquire') {
          mkdirSync(path.join(proof.directory, 'scratch.json'));
        }
        return {
          statusCode: scenario === 'http-failure' ? 503 : 200,
          headers: { 'content-type': 'application/json' },
          body: {
            ok: true,
            poolKey: proof.poolKey,
            slotKey: proof.slotKey,
            leaseToken: 'private-lease-token',
            needsCreate: route === 'acquire',
            provisioningMode: 'definition',
            scratchUsername: 'scratch@example.test',
            leaseState: route === 'release' ? 'available' : 'leased'
          }
        };
      }
      if (command === 'org create scratch') {
        assert.equal(env.USERPROFILE, firstHome);
        assert.equal(env.SF_SCRATCH_SIGNUP_CONNECTED_APP, 'PlatformCLI');
        assert.equal(env.SF_SCRATCH_SIGNUP_CALLBACK_URL, 'http://localhost:1717/OauthRedirect');
        signedUp = true;
        if (['signup-not-visible', 'active-signup-not-visible'].includes(scenario)) {
          signedUp = scenario === 'active-signup-not-visible';
          throw new Error('Lost asynchronous signup response');
        }
        return { orgId: '00D000000000003AAA', username: 'scratch@example.test' };
      }
      if (command === 'org display --target-org') {
        assert.equal(env.SF_TEMP_SHOW_SECRETS, 'true');
        return {
          sfdxAuthUrl:
            scenario === 'redacted-export'
              ? '<REDACTED>'
              : 'force://client::private-refresh-token@scratch.my.salesforce.com'
        };
      }
      if (command === 'org login sfdx-url') {
        secondHome = env.USERPROFILE;
        assert.notEqual(secondHome, firstHome);
        assert.deepEqual(require('node:fs').readdirSync(secondHome), []);
        const auth = readFileSync(args[args.indexOf('--sfdx-url-file') + 1], 'utf8');
        assert.match(auth, /private-refresh-token/);
        if (scenario === 'import-failure') throw new Error('Transport failure containing private-refresh-token');
        return { username: 'scratch@example.test' };
      }
      if (command === 'data update record') {
        maintained = true;
        return { success: true };
      }
      if (command === 'data delete record') {
        const object = args[args.indexOf('--sobject') + 1];
        const id = args[args.indexOf('--record-id') + 1];
        if (scenario === 'cleanup-failure')
          throw Object.assign(new Error('INSUFFICIENT_ACCESS_OR_READONLY private-refresh-token'), {
            code: 'INSUFFICIENT_ACCESS_OR_READONLY'
          });
        removed.push([object, id]);
        if (object === 'ActiveScratchOrg') active = false;
        if (object === 'ALV_ScratchOrgPool__c') ownPool = undefined;
        return { success: true };
      }
      if (args[0] === 'data' && args[1] === 'query') {
        const soql = args[args.indexOf('--query') + 1];
        const target = args[args.indexOf('--target-org') + 1];
        if (soql.includes(' FROM Organization')) {
          if (target === 'alv-runtime')
            throw Object.assign(new Error("sObject type 'Organization' is not supported."), { code: 'INVALID_TYPE' });
          return { records: [{ Id: '00D000000000003AAA' }] };
        }
        if (soql.includes(' FROM User ')) return { records: fixture.records.User };
        if (soql.includes(' FROM ScratchOrgInfo ')) {
          signupObserved = true;
          return { records: signedUp ? [{ Id: 'own-signup', CreatedById: '005runtime', Status: 'Active' }] : [] };
        }
        if (soql.includes(' FROM ActiveScratchOrg ')) {
          assert.ok(signupObserved, 'Reconcile the scratch ownership marker before deletion');
          return {
            records:
              active && scratchVisible
                ? [{ Id: 'own-scratch', OwnerId: '005runtime', ScratchOrgInfoId: 'own-signup' }]
                : []
          };
        }
        if (soql.includes(' FROM ALV_ScratchOrgPool__c '))
          return { records: ownPool ? [{ Id: ownPool, CreatedById: '005runtime' }] : [] };
        if (soql.includes(' FROM ALV_ScratchOrgPoolSlot__c ')) {
          if (soql.includes(' WHERE Id = '))
            return {
              records: [
                {
                  Id: ownSlot,
                  LeaseState__c: maintained ? 'disabled' : 'leased',
                  ...(scenario === 'maintenance-health-missing'
                    ? {}
                    : { HealthState__c: scenario === 'maintenance-health-mismatch' ? 'healthy' : 'needs_recreate' }),
                  ScratchAuthUrl__c: null
                }
              ]
            };
          const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
          return { records: [{ Id: ownSlot, CreatedById: '005runtime', SlotKey__c: proof.slotKey }] };
        }
      }
      assert.fail(`Unexpected native proof command: ${command}`);
    };
    const args = [
      'prove',
      ...baseArgs.slice(1),
      '--state-dir',
      directory,
      '--credential-mode',
      'temporary',
      '--pool-mode',
      'definition'
    ];
    if (scenario === 'success') {
      const result = await main(args, fixture);
      assert.equal(result.status, 'proof-passed');
      assert.doesNotMatch(JSON.stringify(result), /private-refresh-token|private-lease-token/);
      assert.deepEqual(routes, ['acquire', 'finalize', 'heartbeat', 'release']);
    } else {
      await assert.rejects(main(args, fixture), error => {
        assert.match(
          error.message,
          ['cleanup-failure', 'signup-not-visible', 'active-signup-not-visible'].includes(scenario)
            ? /cleanup\/recovery/
            : scenario === 'http-failure'
              ? /pool-acquire/
              : scenario === 'definition-write-failure'
                ? /scratch-prepare/
                : scenario.startsWith('maintenance-health-')
                  ? /pool-maintenance/
                  : /scratch-export-import/
        );
        assert.doesNotMatch(error.message, /private-refresh-token|private-lease-token/);
        return true;
      });
    }
    assert.ok(firstHome);
    assert.equal(
      Boolean(secondHome),
      ![
        'redacted-export',
        'http-failure',
        'signup-not-visible',
        'active-signup-not-visible',
        'definition-write-failure'
      ].includes(scenario)
    );
    assert.deepEqual(
      removed,
      ['cleanup-failure', 'signup-not-visible', 'active-signup-not-visible'].includes(scenario)
        ? []
        : ['http-failure', 'definition-write-failure'].includes(scenario)
          ? [
              ['ALV_ScratchOrgPoolSlot__c', 'own-slot'],
              ['ALV_ScratchOrgPool__c', 'own-pool']
            ]
          : [
              ['ActiveScratchOrg', 'own-scratch'],
              ['ALV_ScratchOrgPoolSlot__c', 'own-slot'],
              ['ALV_ScratchOrgPool__c', 'own-pool']
            ]
    );
    assert.equal(fixture.records.ActiveScratchOrg[0].Id, 'other-scratch');
    assert.equal(fixture.records.ALV_ScratchOrgPool__c[0].Id, 'shared-pool');
    const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
    if (['cleanup-failure', 'signup-not-visible', 'active-signup-not-visible'].includes(scenario)) {
      assert.equal(proof.cleanup, undefined);
      await assert.rejects(main(args, fixture), /prior proof needs recovery/);
      if (['signup-not-visible', 'active-signup-not-visible'].includes(scenario)) {
        await assert.rejects(main(['revoke-app', ...args.slice(1)], fixture), /Recover the owned scratch/);
        await assert.rejects(
          main(['cleanup-proof', ...args.slice(1)], fixture),
          /(?:signup|scratch).*not yet observable/
        );
        assert.deepEqual(removed, []);
        signedUp = true;
        scratchVisible = true;
        const recovered = await main(['cleanup-proof', ...args.slice(1)], fixture);
        assert.equal(recovered.proofs[0].cleanup.scratchDeleted, true);
        assert.equal(recovered.proofs[0].cleanup.poolDeleted, true);
        assert.deepEqual(removed, [
          ['ActiveScratchOrg', 'own-scratch'],
          ['ALV_ScratchOrgPoolSlot__c', 'own-slot'],
          ['ALV_ScratchOrgPool__c', 'own-pool']
        ]);
      }
    } else {
      assert.equal(proof.cleanup.scratchDeleted, true);
      assert.equal(proof.cleanup.poolDeleted, true);
    }
    assert.equal(Boolean(proof.completedAt), ['success', 'cleanup-failure'].includes(scenario));
  });
}

test('runtime setup rejects inherited metadata administration instead of using or removing unrelated grants', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [
    {
      Id: 'other-assignment',
      PermissionSetId: 'other-permission',
      PermissionSet: { Name: 'UnrelatedMetadataAdmin', PermissionsModifyMetadata: true }
    }
  ];
  await assert.rejects(
    main(['grant-runtime', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /Runtime identity has administrative grants/
  );
  assert.deepEqual(
    fixture.created.map(item => item.object),
    ['User', 'PermissionSetLicenseAssign']
  );
});

test('runtime setup requires actual ScratchOrgInfo creation permission after the scoped deployment', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [];
  fixture.records.PermissionSet = [
    {
      Id: '0PSruntime',
      Name: 'ALV_ScratchOrgPoolService',
      IsOwnedByProfile: false,
      Type: 'Regular',
      NamespacePrefix: null,
      ...Object.fromEntries(
        Object.entries(fixture.records.Profile[0]).filter(([name]) => name.startsWith('Permissions'))
      )
    }
  ];
  const grants = addRuntimeGrantInventory(fixture);
  grants.ObjectPermissions.find(item => item.SobjectType === 'ScratchOrgInfo').PermissionsCreate = false;
  await assert.rejects(
    main(['grant-runtime', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /Runtime object grants differ/
  );
  assert.deepEqual(fixture.records.PermissionSetAssignment, [], 'Incomplete grants must fail before assignment');
});

test('a concrete scratch-object license restriction is recorded privately for the explicit Salesforce fallback', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [];
  fixture.records.PermissionSet = [
    {
      Id: '0PSruntime',
      Name: 'ALV_ScratchOrgPoolService',
      IsOwnedByProfile: false,
      Type: 'Regular',
      NamespacePrefix: null,
      ...Object.fromEntries(
        Object.entries(fixture.records.Profile[0]).filter(([name]) => name.startsWith('Permissions'))
      )
    }
  ];
  addRuntimeGrantInventory(fixture);
  const invoke = fixture.sf;
  fixture.sf = async (args, options) => {
    if (args[0] === 'project')
      return { success: true, status: 'Succeeded', checkOnly: args.includes('--dry-run'), id: '0Afpermissions' };
    if (args[1] === 'create' && args.includes('PermissionSetAssignment'))
      throw Object.assign(
        new Error('FIELD_INTEGRITY_EXCEPTION: user license does not allow ScratchOrgInfo. private-token-value'),
        { code: 'FIELD_INTEGRITY_EXCEPTION' }
      );
    return invoke(args, options);
  };
  await assert.rejects(
    main(['grant-runtime', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /permission assignment failed/
  );
  const contents = readFileSync(path.join(directory, 'identity.json'), 'utf8');
  const failure = JSON.parse(contents).integrationFailure;
  assert.equal(failure.licenseRestriction, true);
  assert.deepEqual(failure.affectedObjects, ['ScratchOrgInfo']);
  assert.doesNotMatch(contents, /private-token-value/);
  assert.equal(
    fixture.records.User[0].ProfileId,
    '00eintegration',
    'Recording a restriction does not silently switch the user'
  );
});

test('runtime setup rejects missing pool field grants even when scratch creation is granted', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [];
  fixture.records.PermissionSet = [
    {
      Id: '0PSruntime',
      Name: 'ALV_ScratchOrgPoolService',
      IsOwnedByProfile: false,
      Type: 'Regular',
      NamespacePrefix: null,
      ...Object.fromEntries(
        Object.entries(fixture.records.Profile[0]).filter(([name]) => name.startsWith('Permissions'))
      )
    }
  ];
  const grants = addRuntimeGrantInventory(fixture);
  grants.FieldPermissions = [];
  await assert.rejects(
    main(['grant-runtime', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /Runtime field grants differ/
  );
  assert.deepEqual(fixture.records.PermissionSetAssignment, [], 'Incomplete grants must fail before assignment');
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8')).runtime, undefined);
});

test('a common trigger or infrastructure failure never qualifies for the Salesforce-license fallback', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.runtimeFailure = { code: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', license: 'integration' };
  writeFileSync(stateFile, JSON.stringify(state));
  await assert.rejects(
    main(['use-salesforce-fallback', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /recorded Integration incompatibility/
  );
  assert.deepEqual(
    fixture.created.map(item => item.object),
    ['User', 'PermissionSetLicenseAssign']
  );
});

test('remote failures expose only a recognized category, without secrets or misleading license fallback evidence', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  const invoke = fixture.sf;
  fixture.sf = async args => {
    if (args[1] === 'create')
      throw Object.assign(new Error('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY private-token-value'), {
        code: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY'
      });
    return invoke(args);
  };
  await assert.rejects(main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture), error => {
    assert.doesNotMatch(error.message, /private-token-value/);
    assert.match(error.message, /CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY/);
    assert.equal(error.licenseRestriction, false);
    return true;
  });
});

test('the native proof refuses cached identity or unconfigured app state before scratch or pool mutation', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  await assert.rejects(
    main(
      [
        'prove',
        ...baseArgs.slice(1),
        '--state-dir',
        directory,
        '--credential-mode',
        'temporary',
        '--pool-mode',
        'definition'
      ],
      fixture
    ),
    /configured owned app and verified runtime grants/
  );
  assert.deepEqual(
    fixture.created.map(item => item.object),
    ['User', 'PermissionSetLicenseAssign']
  );
});

test('the explicit supported fallback preserves the user and resumes an uncertain profile update without duplicating it', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [];
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.integrationFailure = {
    phase: 'permission-set-assignment',
    code: 'FIELD_INTEGRITY_EXCEPTION',
    license: 'integration',
    licenseRestriction: true,
    affectedObjects: ['ScratchOrgInfo']
  };
  writeFileSync(stateFile, JSON.stringify(state));
  const invoke = fixture.sf;
  let profileWrites = 0;
  fixture.sf = async args => {
    if (args[0] === 'data' && args[1] === 'delete') {
      assert.equal(args[args.indexOf('--sobject') + 1], 'PermissionSetLicenseAssign');
      assert.equal(args[args.indexOf('--record-id') + 1], '2LApsl');
      fixture.records.PermissionSetLicenseAssign = [];
      return { id: '2LApsl', success: true };
    }
    if (args[0] === 'data' && args[1] === 'update') {
      assert.equal(args[args.indexOf('--record-id') + 1], '005runtime');
      assert.equal(args[args.indexOf('--values') + 1], "ProfileId='00esalesforce'");
      fixture.records.User[0].ProfileId = '00esalesforce';
      profileWrites += 1;
      throw Object.assign(new Error('Uncertain network result'), { code: 'ETIMEDOUT' });
    }
    return invoke(args);
  };
  const args = ['use-salesforce-fallback', ...baseArgs.slice(1), '--state-dir', directory];
  await assert.rejects(main(args, fixture), /profile update is unconfirmed/);
  const result = await main(args, fixture);
  assert.equal(result.status, 'fallback-ready');
  assert.equal(result.userId, '005runtime');
  assert.equal(result.profile, 'Minimum Access - Salesforce');
  assert.equal(profileWrites, 1);
  assert.equal(fixture.records.User.length, 1);
  assert.equal(fixture.records.PermissionSetLicenseAssign.length, 0);
});
