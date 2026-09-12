'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { durablePath, privateFile } = require('./devhub-operator-state');
const { secureDirectory } = require('./devhub-identity-credentials');
const { rotationInputs, copyMaterial, rotationMetadata, applyRotation } = require('./devhub-identity-rotation');
const { verifyApp, verifyPreauthorization } = require('./devhub-identity-app');
const { auditRuntime } = require('./devhub-identity-permissions');
const { githubStore } = require('./devhub-identity-store');
const CONTACT = 'apex-log-viewer-ci@electivus.com';
const digest = value => createHash('sha256').update(value).digest('hex');

async function mustBeAbsent(file) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Existing identity or recovery material must be reconciled; do not overwrite or claim it was lost.');
}

async function locked(directory, action) {
  let lock;
  try {
    lock = await fs.open(path.join(directory, 'operation.lock'), 'wx', 0o600);
  } catch {
    throw new Error('Operator state is locked; reconcile the prior operation before recovery.');
  }
  try {
    return await action();
  } finally {
    await lock.close();
    await fs.unlink(path.join(directory, 'operation.lock'));
  }
}

async function observe({ values, inventory, query, sf, directory, lifecycle, fingerprints }) {
  const users = inventory.users.filter(item => item.Username === CONTACT);
  const user = users[0];
  const owner = /^alv-devhub:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(
    user?.FederationIdentifier || ''
  )?.[1];
  const candidate = inventory.candidates.integration;
  if (
    users.length !== 1 ||
    inventory.users.length !== 1 ||
    !owner ||
    user.Email !== CONTACT ||
    !user.Id ||
    user.IsActive !== true ||
    !candidate?.profileId ||
    user.ProfileId !== candidate.profileId
  )
    throw new Error('Lost-material recovery cannot prove the current dedicated user ownership and minimum profile.');
  const name = `ALV_DevHub_${owner.replaceAll('-', '').slice(0, 16)}_CI`;
  const marker = `alv-devhub:${owner}:permanent`;
  const apps = inventory.apps.filter(item => item.DeveloperName === name);
  if (
    name !== values['expected-app-name'] ||
    apps.length !== 1 ||
    !apps[0].Id ||
    apps[0].Description !== marker ||
    apps[0].ContactEmail !== CONTACT
  )
    throw new Error('Lost-material recovery cannot prove the expected ECA ownership; no app will be adopted.');
  const app = { id: apps[0].Id, name, marker, preauthorization: `${name}_Access`, lifecycle };
  const permissionSetId = await verifyPreauthorization(sf, values['target-org'], query, app);
  const assignees = await query(
    `SELECT Id, AssigneeId, PermissionSetId, PermissionSetGroupId FROM PermissionSetAssignment WHERE PermissionSetId = '${permissionSetId}'`
  );
  if (
    assignees.length !== 1 ||
    !assignees[0].Id ||
    assignees[0].AssigneeId !== user.Id ||
    assignees[0].PermissionSetId !== permissionSetId ||
    assignees[0].PermissionSetGroupId !== null
  )
    throw new Error('Current ECA preauthorization is not exclusive to the dedicated user.');
  app.assignmentId = assignees[0].Id;
  const licenses = await query(
    `SELECT Id, PermissionSetLicenseId FROM PermissionSetLicenseAssign WHERE AssigneeId = '${user.Id}'`
  );
  if (
    licenses.length !== 1 ||
    !licenses[0].Id ||
    licenses[0].PermissionSetLicenseId !== candidate.permissionSetLicenseId
  )
    throw new Error('Current Integration permission-set license cannot be reconciled uniquely.');
  // These fields describe a current read, never a reconstructed provisioning
  // history. Only apply after plan approval may create a new recovery journal.
  const state = {
    version: 1,
    org: inventory.org,
    contact: CONTACT,
    username: user.Username,
    userId: user.Id,
    owner,
    license: 'integration',
    permissionSetLicenseAssignmentId: licenses[0].Id,
    apps: { permanent: app }
  };
  const assignments = await auditRuntime(query, user, {
    state,
    sf,
    target: values['target-org'],
    requireRuntime: true
  });
  const metadataDirectory = await fs.mkdtemp(path.join(directory, 'recovery-audit-'));
  const effective = await verifyApp(sf, values['target-org'], metadataDirectory, app, fingerprints);
  Object.assign(app, {
    configured: true,
    fingerprint: effective.fingerprint,
    validFrom: effective.validFrom,
    validTo: effective.validTo
  });
  const runtime = assignments.find(item => item.PermissionSet.Name === 'ALV_ScratchOrgPoolService');
  state.runtime = { permissionSetId: runtime.PermissionSetId };
  state.runtimeAssignmentId = runtime.Id;
  const assignmentIds = assignments.map(item => `${item.Id}:${item.PermissionSetId}`).sort();
  return {
    state,
    user,
    clientId: effective.clientId,
    metadataDirectory,
    binding: {
      org: state.org,
      owner,
      userId: user.Id,
      username: user.Username,
      profileId: user.ProfileId,
      appId: app.id,
      appName: name,
      preauthorization: permissionSetId,
      assignmentIds,
      licenseAssignmentId: licenses[0].Id,
      clientId: effective.clientId
    }
  };
}

async function prepare(context) {
  const { values, inventory, query, sf, gh } = context;
  const { lifecycle, certificate } = await rotationInputs(values);
  if (!values['state-dir'] || !values['lost-state-dir'] || !path.isAbsolute(values['lost-state-dir']))
    throw new Error('Explicit durable --state-dir and the missing original --lost-state-dir are required.');
  await mustBeAbsent(values['lost-state-dir']);
  const directory = await durablePath(values['state-dir'], { create: true });
  await secureDirectory(directory);
  return locked(directory, async () => {
    await mustBeAbsent(path.join(directory, 'identity.json'));
    await mustBeAbsent(path.join(directory, 'recovery-plan.json'));
    const observed = await observe({
      ...context,
      directory,
      lifecycle,
      fingerprints: [values['expected-fingerprint']]
    });
    const storeInventory = await githubStore(lifecycle, gh).inspect();
    const id = randomUUID();
    const root = path.join(directory, `rotation-${id}`);
    await fs.mkdir(root, { mode: 0o700 });
    await secureDirectory(root);
    const candidate = await copyMaterial(root, 'candidate', {
      lifecycle,
      fingerprint: certificate.fingerprint,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      certificateFile: path.resolve(values['certificate-file']),
      privateKeyFile: path.resolve(values['private-key-file'])
    });
    const metadata = path.join(root, 'forward-metadata');
    await rotationMetadata(metadata, observed.state.apps.permanent, certificate);
    const validation = await sf(
      [
        'project',
        'deploy',
        'start',
        '--target-org',
        values['target-org'],
        '--source-dir',
        'force-app',
        '--wait',
        '30',
        '--dry-run'
      ],
      { cwd: metadata }
    );
    if (validation.success !== true || validation.status !== 'Succeeded' || validation.checkOnly !== true)
      throw new Error('Recovery certificate validation failed; no active update was attempted.');
    const plan = {
      version: 1,
      kind: 'lost-material-forward-recovery',
      id,
      preparedAt: new Date().toISOString(),
      lostStateDirectory: path.resolve(values['lost-state-dir']),
      historicalJournalAvailable: false,
      previousPrivateKeyAvailable: false,
      rollbackAvailable: false,
      historicalPhases: 'unknown',
      outstandingHistoricalProofResources: 'unknown',
      lifecycle,
      binding: observed.binding,
      observedState: observed.state,
      previous: {
        fingerprint: observed.state.apps.permanent.fingerprint,
        validFrom: observed.state.apps.permanent.validFrom,
        validTo: observed.state.apps.permanent.validTo
      },
      candidate,
      storeInventory,
      validationId: validation.id,
      resourcesAtPreparation: { scratches: inventory.scratches, pools: inventory.pools }
    };
    const body = `${JSON.stringify(plan, null, 2)}\n`;
    await fs.writeFile(path.join(directory, 'recovery-plan.json'), body, { mode: 0o600, flag: 'wx' });
    return {
      status: 'lost-material-recovery-prepared',
      planSha256: digest(body),
      recoveryId: id,
      fingerprint: certificate.fingerprint,
      validTo: certificate.validTo,
      rollbackAvailable: false,
      historicalJournalAvailable: false,
      activeCredentialChanged: false,
      ciVerified: false
    };
  });
}

async function apply(context) {
  const { values, sf, gh, query } = context;
  if (!/^[a-f0-9]{64}$/.test(values['approved-plan-sha256'] || '') || !values['policy-reference']?.trim())
    throw new Error('An approved plan SHA-256 and explicit active-operation policy reference are required.');
  const directory = await durablePath(values['state-dir']);
  await secureDirectory(directory);
  return locked(directory, async () => {
    const body = await fs.readFile(await privateFile(directory, path.join(directory, 'recovery-plan.json')), 'utf8');
    if (digest(body) !== values['approved-plan-sha256'])
      throw new Error('Recovery plan differs from the approved plan SHA-256; no active write is allowed.');
    const plan = JSON.parse(body);
    if (
      plan.version !== 1 ||
      plan.kind !== 'lost-material-forward-recovery' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(plan.id) ||
      plan.rollbackAvailable !== false ||
      plan.previousPrivateKeyAvailable !== false ||
      plan.historicalJournalAvailable !== false ||
      plan.historicalPhases !== 'unknown'
    )
      throw new Error('Recovery evidence must explicitly record the lost key, journal and unavailable rollback.');
    const observed = await observe({
      ...context,
      values: { ...values, 'expected-app-name': plan.binding.appName },
      directory,
      lifecycle: plan.lifecycle,
      fingerprints: [plan.previous.fingerprint, plan.candidate.fingerprint]
    });
    if (JSON.stringify(observed.binding) !== JSON.stringify(plan.binding))
      throw new Error('Live identity, client ID or assignments differ from the approved recovery plan.');
    let state;
    const journal = path.join(directory, 'identity.json');
    try {
      state = JSON.parse(await fs.readFile(await privateFile(directory, journal), 'utf8'));
    } catch (error) {
      // privateFile deliberately sanitizes missing paths. Check only this exact
      // journal before treating it as absent, never an unreadable existing file.
      await mustBeAbsent(journal);
    }
    const root = path.join(directory, `rotation-${plan.id}`);
    await privateFile(directory, plan.candidate.privateKeyFile);
    await privateFile(directory, plan.candidate.certificateFile);
    if (!state) {
      const inputsFile = path.join(root, 'recovered-jwt-inputs.json');
      const inputs = JSON.stringify({
        username: observed.state.username,
        clientId: observed.clientId,
        loginUrl: 'https://login.salesforce.com'
      });
      try {
        await fs.writeFile(inputsFile, inputs, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST' || (await fs.readFile(inputsFile, 'utf8')) !== inputs)
          throw new Error('Recovery input references conflict; preserve state.');
      }
      state = observed.state;
      state.apps.permanent.inputsFile = inputsFile;
      state.recoveredAt = new Date().toISOString();
      state.recovery = {
        kind: 'lost-material',
        planSha256: values['approved-plan-sha256'],
        approvalReference: values['policy-reference'],
        historicalJournalAvailable: false,
        previousPrivateKeyAvailable: false,
        rollbackAvailable: false,
        historicalPhases: 'unknown',
        outstandingHistoricalProofResources: 'unknown',
        lostStateDirectory: plan.lostStateDirectory
      };
      state.rotation = {
        id: plan.id,
        kind: 'lost-material',
        owner: state.owner,
        appId: state.apps.permanent.id,
        phase: 'prepared',
        startedAt: state.recoveredAt,
        previous: plan.previous,
        candidate: plan.candidate
      };
    }
    if (
      state.owner !== observed.state.owner ||
      state.userId !== observed.state.userId ||
      state.org !== observed.state.org ||
      state.recovery?.kind !== 'lost-material' ||
      state.recovery.planSha256 !== values['approved-plan-sha256'] ||
      state.rotation?.kind !== 'lost-material' ||
      state.rotation.id !== plan.id ||
      JSON.stringify(state.rotation.candidate) !== JSON.stringify(plan.candidate) ||
      JSON.stringify(state.rotation.previous) !== JSON.stringify(plan.previous) ||
      state.recovery.previousPrivateKeyAvailable !== false ||
      state.recovery.historicalJournalAvailable !== false ||
      state.recovery.historicalPhases !== 'unknown' ||
      state.recovery.rollbackAvailable !== false
    )
      throw new Error('Existing journal is not this approved recovery; no history may be overwritten.');
    const save = async () => {
      const pending = path.join(directory, 'identity.pending.json');
      await fs.writeFile(pending, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(pending, journal);
    };
    await save();
    const result = await applyRotation({
      values: { ...values, 'rotation-id': plan.id },
      state,
      directory,
      user: observed.user,
      query,
      sf,
      gh,
      command: 'apply-lost-material-recovery',
      save
    });
    return { ...result, rollbackAvailable: false, historicalJournalAvailable: false };
  });
}

module.exports = { prepare, apply };
