'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { secureDirectory, readCertificate } = require('./devhub-identity-credentials');
const { auditRuntime } = require('./devhub-identity-permissions');

function isolatedEnv(directory) {
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, SF_STATE_FOLDER: '.sf' };
  for (const name of Object.keys(env)) {
    if (
      /^(?:SF|SFDX)_(?:DEVHUB|TARGET|DEFAULT|ACCESS_TOKEN|INSTANCE_URL|USERNAME|CLIENT_ID|CLIENT_SECRET|AUTH_URL|TEMP_SHOW_SECRETS|SCRATCH_SIGNUP|CONFIG_DIR)/.test(
        name
      )
    )
      delete env[name];
  }
  return env;
}

function usableAuthUrl(value) {
  return (
    typeof value === 'string' &&
    /^force:\/\/[^:\s]*:[^:\s]*:[^@\s]+@[a-zA-Z0-9.-]+\/?$/.test(value) &&
    !/redact|placeholder|<|\*{3}/i.test(value)
  );
}

function fields(values) {
  return Object.entries(values)
    .map(([name, value]) => `${name}='${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`)
    .join(' ');
}

async function cleanupProof({ state, proof, sf, options, user, save }) {
  const query = async soql => {
    const response = await sf(['data', 'query', '--target-org', 'alv-runtime', '--query', soql], options);
    if (!Array.isArray(response.records) || response.done === false)
      throw new Error('Cleanup inventory is incomplete.');
    return response.records;
  };
  const remove = async (object, id) => {
    const response = await sf(
      ['data', 'delete', 'record', '--target-org', 'alv-runtime', '--sobject', object, '--record-id', id],
      options
    );
    if (response.success !== true) throw new Error('Owned resource deletion is unconfirmed.');
  };
  // Reconcile a successful server write even when its CLI response was lost.
  const signups = await query(
    `SELECT Id, CreatedById, Status FROM ScratchOrgInfo WHERE alvPoolKey__c = '${proof.poolKey}' AND alvSlotKey__c = '${proof.slotKey}'`
  );
  if (signups.some(item => item.CreatedById !== user.Id))
    throw new Error('Scratch ownership conflict; cleanup stopped.');
  for (const signup of signups) {
    if (!['Active', 'Error', 'Deleted'].includes(signup.Status))
      throw new Error('Scratch signup is still pending; retain its state and retry cleanup when terminal.');
    const active = await query(
      `SELECT Id, OwnerId, ScratchOrgInfoId FROM ActiveScratchOrg WHERE ScratchOrgInfoId = '${signup.Id}'`
    );
    if (active.some(item => item.OwnerId !== user.Id))
      throw new Error('Active scratch owner differs; ask the existing owner to drain it.');
    for (const scratch of active) await remove('ActiveScratchOrg', scratch.Id);
    if ((await query(`SELECT Id FROM ActiveScratchOrg WHERE ScratchOrgInfoId = '${signup.Id}'`)).length) {
      throw new Error('Active scratch deletion is not yet confirmed; keep credentials for recovery.');
    }
  }
  const pools = await query(`SELECT Id, CreatedById FROM ALV_ScratchOrgPool__c WHERE PoolKey__c = '${proof.poolKey}'`);
  if (pools.length > 1 || pools.some(item => item.CreatedById !== user.Id))
    throw new Error('Test pool ownership conflict; cleanup stopped.');
  for (const pool of pools) {
    const slots = await query(
      `SELECT Id, CreatedById, SlotKey__c FROM ALV_ScratchOrgPoolSlot__c WHERE Pool__c = '${pool.Id}'`
    );
    if (slots.some(item => item.CreatedById !== user.Id || item.SlotKey__c !== proof.slotKey))
      throw new Error('Unexpected test slot; cleanup stopped.');
    for (const slot of slots) await remove('ALV_ScratchOrgPoolSlot__c', slot.Id);
    await remove('ALV_ScratchOrgPool__c', pool.Id);
  }
  if ((await query(`SELECT Id FROM ALV_ScratchOrgPool__c WHERE PoolKey__c = '${proof.poolKey}'`)).length) {
    throw new Error('Test pool deletion is not confirmed.');
  }
  proof.cleanup = {
    scratchDeleted: true,
    poolDeleted: true,
    retainedSignupIds: signups.map(item => item.Id),
    at: new Date().toISOString()
  };
  await save();
}

async function prove({ values, state, directory, user, sf, query, save }) {
  const app = state.apps?.[values['credential-mode']];
  if (!app?.configured || app.revoked || !state.runtime) {
    throw new Error('Native proof requires a configured owned app and verified runtime grants.');
  }
  if (
    !['definition', 'snapshot'].includes(values['pool-mode']) ||
    (values['pool-mode'] === 'snapshot' && !/^[a-zA-Z0-9_-]+$/.test(values['snapshot-name'] || ''))
  ) {
    throw new Error(
      'Choose --pool-mode definition or snapshot with an explicit --snapshot-name; no mode fallback is allowed.'
    );
  }
  if (state.proof && (!state.proof.cleanup?.scratchDeleted || !state.proof.cleanup?.poolDeleted)) {
    throw new Error('A prior proof needs recovery. Run cleanup-proof before creating another test pool or scratch.');
  }
  await auditRuntime(query, user);
  const certificate = await readCertificate(app.certificateFile, app.privateKeyFile, app.lifecycle);
  if (certificate.fingerprint !== app.fingerprint) throw new Error('Proof certificate differs from the recorded app.');
  let inputs;
  try {
    inputs = JSON.parse(await fs.readFile(app.inputsFile, 'utf8'));
  } catch {
    throw new Error('Cannot read private JWT inputs; contents withheld.');
  }
  if (
    inputs.username !== user.Username ||
    inputs.privateKeyFile !== app.privateKeyFile ||
    !/^[a-zA-Z0-9._-]{12,512}$/.test(inputs.clientId) ||
    /redact|placeholder/i.test(inputs.clientId) ||
    inputs.loginUrl !== 'https://login.salesforce.com'
  )
    throw new Error('JWT inputs do not match the owned identity.');
  const proof = {
    id: randomUUID(),
    appMode: app.lifecycle.mode,
    license: state.license,
    poolMode: values['pool-mode'],
    startedAt: new Date().toISOString(),
    phase: 'login'
  };
  proof.poolKey = `alv-identity-${proof.id}`;
  proof.slotKey = `${proof.poolKey}-01`;
  proof.directory = path.join(directory, `proof-${proof.id}`);
  if (state.proof) (state.proofHistory ||= []).push(state.proof);
  state.proof = proof;
  await save();
  await fs.mkdir(proof.directory, { mode: 0o700 });
  await secureDirectory(proof.directory);
  const homeA = path.join(proof.directory, 'home-a');
  const homeB = path.join(proof.directory, 'home-b');
  await fs.mkdir(homeA);
  await fs.mkdir(homeB);
  const options = { cwd: proof.directory, env: isolatedEnv(homeA) };
  const otherOptions = { cwd: proof.directory, env: isolatedEnv(homeB) };
  const runtimeQuery = async (soql, target = 'alv-runtime', execution = options) => {
    const result = await sf(['data', 'query', '--target-org', target, '--query', soql], execution);
    if (!Array.isArray(result.records) || result.done === false)
      throw new Error('Runtime query returned incomplete records.');
    return result.records;
  };
  const phase = async value => {
    proof.phase = value;
    await save();
  };
  const create = async (object, data) => {
    const response = await sf(
      ['data', 'create', 'record', '--target-org', 'alv-runtime', '--sobject', object, '--values', fields(data)],
      options
    );
    if (!response.success || !response.id)
      throw new Error('Test record creation is unconfirmed; preserve state for recovery.');
    return response.id;
  };
  const rest = async (route, payload) => {
    const body = path.join(proof.directory, 'request.json');
    await fs.writeFile(body, JSON.stringify(payload), { mode: 0o600 });
    const response = await sf(
      [
        'api',
        'request',
        'rest',
        `/services/apexrest/alv/scratch-pool/v1/${route}`,
        '--target-org',
        'alv-runtime',
        '--method',
        'POST',
        '--body',
        `@${body}`
      ],
      options
    );
    const result = response.body;
    if (
      response.statusCode !== 200 ||
      result?.ok !== true ||
      result.poolKey !== proof.poolKey ||
      result.slotKey !== proof.slotKey
    ) {
      throw new Error('Pool REST response did not confirm the owned pool/slot; contents withheld.');
    }
    return result;
  };
  let loggedIn = false;
  let failure;
  try {
    const login = await sf(
      [
        'org',
        'login',
        'jwt',
        '--client-id',
        inputs.clientId,
        '--username',
        user.Username,
        '--instance-url',
        inputs.loginUrl,
        '--jwt-key-file',
        app.privateKeyFile,
        '--alias',
        'alv-runtime'
      ],
      options
    );
    if (login.username !== user.Username || login.orgId !== state.org)
      throw new Error('JWT did not confirm the dedicated identity and intended org.');
    const org = await runtimeQuery('SELECT Id FROM Organization');
    const runtimeUser = await runtimeQuery(`SELECT Id, Username FROM User WHERE Username = '${user.Username}'`);
    if (org.length !== 1 || org[0].Id !== state.org || runtimeUser.length !== 1 || runtimeUser[0].Id !== user.Id) {
      throw new Error('Runtime API did not confirm the dedicated identity and intended org.');
    }
    loggedIn = true;
    await phase('pool-create');
    if ((await runtimeQuery(`SELECT Id FROM ALV_ScratchOrgPool__c WHERE PoolKey__c = '${proof.poolKey}'`)).length)
      throw new Error('Test pool already exists; no adoption is allowed.');
    proof.poolId = await create('ALV_ScratchOrgPool__c', {
      PoolKey__c: proof.poolKey,
      Enabled__c: true,
      TargetSize__c: 1,
      ScratchDurationDays__c: 1,
      LeaseTtlSeconds__c: 1800,
      AcquireTimeoutSeconds__c: 600,
      MinRemainingMinutes__c: 0,
      ProvisioningMode__c: proof.poolMode,
      ...(proof.poolMode === 'snapshot' ? { SnapshotName__c: values['snapshot-name'] } : {}),
      DefinitionHash__c: proof.id,
      SeedVersion__c: 'identity-proof-v1'
    });
    await save();
    proof.slotId = await create('ALV_ScratchOrgPoolSlot__c', {
      Pool__c: proof.poolId,
      SlotKey__c: proof.slotKey,
      ScratchAlias__c: 'alv-proof-scratch',
      LeaseState__c: 'available',
      HealthState__c: 'needs_recreate'
    });
    await phase('pool-acquire');
    const lease = await rest('acquire', {
      poolKey: proof.poolKey,
      leaseOwner: proof.id,
      leaseTtlSeconds: 1800,
      minRemainingMinutes: 0,
      definitionHash: proof.id,
      seedVersion: 'identity-proof-v1'
    });
    if (!lease.leaseToken || lease.needsCreate !== true || lease.provisioningMode !== proof.poolMode)
      throw new Error('Fresh pool lease/mode was not confirmed.');
    const leaseInputs = {
      poolKey: proof.poolKey,
      slotKey: proof.slotKey,
      leaseToken: lease.leaseToken,
      leaseOwner: proof.id
    };
    await phase('scratch-create');
    const definition = path.join(proof.directory, 'scratch.json');
    await fs.writeFile(
      definition,
      JSON.stringify({
        orgName: proof.poolKey,
        ...(proof.poolMode === 'snapshot'
          ? { snapshot: values['snapshot-name'] }
          : { edition: 'Developer', hasSampleData: false }),
        alvPoolKey__c: proof.poolKey,
        alvSlotKey__c: proof.slotKey,
        alvDefinitionHash__c: proof.id,
        alvSeedVersion__c: 'identity-proof-v1'
      }),
      { mode: 0o600 }
    );
    const scratch = await sf(
      [
        'org',
        'create',
        'scratch',
        '--target-dev-hub',
        'alv-runtime',
        '--definition-file',
        definition,
        '--duration-days',
        '1',
        '--alias',
        'alv-proof-scratch',
        '--wait',
        '30'
      ],
      {
        ...options,
        env: {
          ...options.env,
          SF_SCRATCH_SIGNUP_CONNECTED_APP: 'PlatformCLI',
          SF_SCRATCH_SIGNUP_CALLBACK_URL: 'http://localhost:1717/OauthRedirect'
        }
      }
    );
    proof.scratchOrgId = scratch.orgId;
    if (
      !/^00D[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(scratch.orgId || '') ||
      !scratch.username ||
      scratch.username === user.Username
    )
      throw new Error('Scratch signup did not return an independent identity.');
    await phase('scratch-query');
    const first = await runtimeQuery('SELECT Id FROM Organization', 'alv-proof-scratch');
    if (first.length !== 1 || first[0].Id.slice(0, 15) !== scratch.orgId.slice(0, 15))
      throw new Error('Scratch API identity mismatch.');
    await phase('scratch-export-import');
    const exported = await sf(['org', 'display', '--target-org', 'alv-proof-scratch', '--verbose'], {
      ...options,
      env: { ...options.env, SF_TEMP_SHOW_SECRETS: 'true' }
    });
    if (!usableAuthUrl(exported.sfdxAuthUrl))
      throw new Error('Scratch export is malformed or redacted; no import was attempted.');
    const authFile = path.join(proof.directory, 'scratch.sfdxurl');
    await fs.writeFile(authFile, exported.sfdxAuthUrl, { mode: 0o600 });
    const imported = await sf(
      ['org', 'login', 'sfdx-url', '--sfdx-url-file', authFile, '--alias', 'alv-imported'],
      otherOptions
    );
    if (imported.username !== scratch.username) throw new Error('Independent scratch import identity mismatch.');
    const second = await runtimeQuery('SELECT Id FROM Organization', 'alv-imported', otherOptions);
    if (second.length !== 1 || second[0].Id !== first[0].Id)
      throw new Error('Independent scratch API query failed identity verification.');
    await phase('pool-finalize-heartbeat-release');
    const finalized = await rest('finalize', {
      ...leaseInputs,
      definitionHash: proof.id,
      seedVersion: 'identity-proof-v1',
      scratchAuthUrl: exported.sfdxAuthUrl
    });
    if (finalized.scratchUsername !== scratch.username || finalized.needsCreate !== false)
      throw new Error('Pool finalization did not bind the owned scratch.');
    const heartbeat = await rest('heartbeat', { ...leaseInputs, leaseTtlSeconds: 1800 });
    if (heartbeat.leaseState !== 'leased') throw new Error('Pool heartbeat did not preserve the lease.');
    const released = await rest('release', {
      ...leaseInputs,
      success: true,
      needsRecreate: true,
      lastRunResult: 'identity-proof'
    });
    if (released.leaseState !== 'available') throw new Error('Pool release did not free the owned slot.');
    await phase('pool-maintenance');
    const maintenance = await sf(
      [
        'data',
        'update',
        'record',
        '--target-org',
        'alv-runtime',
        '--sobject',
        'ALV_ScratchOrgPoolSlot__c',
        '--record-id',
        proof.slotId,
        '--values',
        fields({ LeaseState__c: 'disabled', HealthState__c: 'needs_recreate' })
      ],
      options
    );
    if (!maintenance.success) throw new Error('Pool maintenance update failed.');
    const maintained = await runtimeQuery(
      `SELECT Id, LeaseState__c, HealthState__c, ScratchAuthUrl__c FROM ALV_ScratchOrgPoolSlot__c WHERE Id = '${proof.slotId}'`
    );
    if (maintained.length !== 1 || maintained[0].LeaseState__c !== 'disabled' || maintained[0].ScratchAuthUrl__c)
      throw new Error('Pool maintenance result was not verified.');
    proof.completedAt = new Date().toISOString();
    await phase('cleanup');
  } catch (error) {
    failure = error;
    proof.failure = { phase: proof.phase, code: error.code || 'PROOF_ASSERTION_FAILED' };
    if (state.license === 'integration' && error.licenseRestriction === true) {
      state.integrationFailure = {
        ...proof.failure,
        license: 'integration',
        licenseRestriction: true,
        affectedObjects: error.affectedObjects
      };
    }
    await save();
  }
  try {
    if (loggedIn) await cleanupProof({ state, proof, sf, options, user, save });
    else {
      proof.cleanup = { scratchDeleted: true, poolDeleted: true };
      await save();
    }
  } catch (error) {
    proof.cleanupFailure = { code: error.code || 'CLEANUP_UNCONFIRMED', at: new Date().toISOString() };
    await save();
    throw new Error(
      `Native proof requires cleanup/recovery at phase ${proof.phase}; preserve ${proof.directory} and run cleanup-proof. Raw output withheld.`
    );
  }
  // Keep credentials until the app is disabled; cleanup-proof removes this owned
  // directory once all server resources are gone. This also permits inspection of
  // a failed native command without exposing sensitive files as artifacts.
  if (failure)
    throw new Error(
      `Native proof failed at ${proof.failure.phase} (${proof.failure.code}); owned scratch/pool cleanup passed. Private recovery directory: ${proof.directory}`
    );
  return {
    status: 'proof-passed',
    license: proof.license,
    poolMode: proof.poolMode,
    scratchOrgId: proof.scratchOrgId,
    cleanup: proof.cleanup,
    retainedPrivateDirectory: proof.directory
  };
}

async function recoverProof({ state, directory, user, sf, save }) {
  const proofs = [...(state.proofHistory || []), ...(state.proof ? [state.proof] : [])];
  if (!proofs.length) throw new Error('No owned proof is available for cleanup.');
  for (const proof of proofs) {
    if (
      !proof ||
      !/^[0-9a-f-]{36}$/.test(proof.id) ||
      proof.directory !== path.join(directory, `proof-${proof.id}`) ||
      proof.poolKey !== `alv-identity-${proof.id}` ||
      proof.slotKey !== `${proof.poolKey}-01`
    )
      throw new Error('No verifiable owned proof is available for cleanup.');
    if (!proof.cleanup?.scratchDeleted || !proof.cleanup?.poolDeleted) {
      await cleanupProof({
        state,
        proof,
        user,
        sf,
        save,
        options: { cwd: proof.directory, env: isolatedEnv(path.join(proof.directory, 'home-a')) }
      });
    }
    if (!state.apps?.[proof.appMode]?.revoked) continue;
    try {
      const real = await fs.realpath(proof.directory);
      if (real !== proof.directory) throw new Error('Unexpected proof directory target.');
      await fs.rm(real, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(
          `Private cleanup failed; retain the reported directory and do not retry through another mechanism: ${proof.directory}`
        );
    }
    proof.cleanup.localDirectoryDeleted = true;
    await save();
  }
  return {
    status: 'proof-cleanup-reconciled',
    proofs: proofs.map(proof => ({
      id: proof.id,
      cleanup: proof.cleanup,
      ...(!proof.cleanup.localDirectoryDeleted
        ? { retainedPrivateDirectory: proof.directory, nextStep: 'revoke-app then cleanup-proof' }
        : {})
    }))
  };
}

module.exports = { prove, recoverProof, isolatedEnv };
