'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { lifecycleInputs, readCertificate, secureDirectory } = require('./devhub-identity-credentials');
const {
  verifyProofApp,
  metadataProject,
  validatedDeploy,
  xml,
  GLOBAL_OAUTH_CONTROLS
} = require('./devhub-identity-app');
const { auditRuntime } = require('./devhub-identity-permissions');
const { assertKnownProofPhases, isolatedEnv } = require('./devhub-identity-proof');
const { githubStore } = require('./devhub-identity-store');

async function rotationInputs(values) {
  const lifecycle = lifecycleInputs(values, true);
  githubStore(lifecycle);
  if (lifecycle.mode !== 'permanent' || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(values['expected-fingerprint'] || ''))
    throw new Error('Rotation requires permanent policy and the explicit current SHA-256 --expected-fingerprint.');
  const certificate = await readCertificate(values['certificate-file'], values['private-key-file'], lifecycle);
  if (certificate.fingerprint === values['expected-fingerprint'])
    throw new Error('Replacement certificate must differ from the current certificate.');
  return { lifecycle, certificate };
}

async function privateInputs(app, user) {
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
  return inputs;
}

async function copyMaterial(root, name, material) {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const result = {
    ...material,
    certificateFile: path.join(directory, 'certificate.pem'),
    privateKeyFile: path.join(directory, 'private-key.pem')
  };
  for (const field of ['certificateFile', 'privateKeyFile']) {
    const bytes = await fs.readFile(material[field]);
    try {
      await fs.writeFile(result[field], bytes, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST' || !(await fs.readFile(result[field])).equals(bytes))
        throw new Error('Rotation material conflicts with the retained copy; preserve state for recovery.');
    }
  }
  const pair = await readCertificate(result.certificateFile, result.privateKeyFile, result.lifecycle);
  if (pair.fingerprint !== result.fingerprint)
    throw new Error('Copied rotation material differs from its recorded fingerprint.');
  return result;
}

async function rotationMetadata(root, app, certificate) {
  await metadataProject(root, {
    [`extlClntAppGlobalOauthSets/${app.name}_global.ecaGlblOauth-meta.xml`]: xml('ExtlClntAppGlobalOauthSettings', {
      ...GLOBAL_OAUTH_CONTROLS,
      certificate: certificate.pem,
      externalClientApplication: app.name,
      label: `${app.name} Global OAuth`
    })
  });
}

async function prepareRotation({ values, state, directory, user, query, sf, gh, save }) {
  const { lifecycle, certificate } = await rotationInputs(values);
  const app = state.apps?.permanent;
  if (
    !app?.configured ||
    app.revoked ||
    app.fingerprint !== values['expected-fingerprint'] ||
    app.lifecycle.storagePolicy !== lifecycle.storagePolicy
  )
    throw new Error('Active owned app, fingerprint or approved store differs; no rotation may start.');
  assertKnownProofPhases(state);
  if (
    [...(state.proofHistory || []), ...(state.proof ? [state.proof] : [])].some(
      proof => !proof.cleanup?.scratchDeleted || !proof.cleanup?.poolDeleted
    )
  )
    throw new Error('Recover outstanding proof resources before rotation.');
  const previous = await readCertificate(app.certificateFile, app.privateKeyFile, app.lifecycle);
  if (previous.fingerprint !== app.fingerprint)
    throw new Error('Current private recovery material differs from the recorded app.');
  const inputs = await privateInputs(app, user);
  const store = githubStore(lifecycle, gh);
  const inventory = await store.inspect();
  await auditRuntime(query, user, { state, sf, target: values['target-org'], requireRuntime: true });
  await verifyProofApp({
    sf,
    query,
    target: values['target-org'],
    directory,
    state,
    mode: 'permanent',
    user,
    clientId: inputs.clientId
  });
  if (state.rotation && ['applied', 'rolled-back'].includes(state.rotation.phase)) {
    (state.rotationHistory ||= []).push(state.rotation);
    delete state.rotation;
  }
  if (
    state.rotation &&
    (!['preparing', 'prepared'].includes(state.rotation.phase) ||
      state.rotation.candidate.fingerprint !== certificate.fingerprint ||
      JSON.stringify(state.rotation.candidate.lifecycle) !== JSON.stringify(lifecycle))
  )
    throw new Error('A recorded rotation must be reconciled before another replacement.');
  const rotation = (state.rotation ||= {
    id: randomUUID(),
    owner: state.owner,
    appId: app.id,
    phase: 'preparing',
    startedAt: new Date().toISOString(),
    previous: {
      lifecycle: app.lifecycle,
      fingerprint: app.fingerprint,
      validFrom: app.validFrom,
      validTo: app.validTo,
      certificateFile: app.certificateFile,
      privateKeyFile: app.privateKeyFile
    },
    candidate: {
      lifecycle,
      fingerprint: certificate.fingerprint,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      certificateFile: path.resolve(values['certificate-file']),
      privateKeyFile: path.resolve(values['private-key-file'])
    }
  });
  await save();
  const root = path.join(directory, `rotation-${rotation.id}`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await secureDirectory(root);
  rotation.previous = await copyMaterial(root, 'previous', rotation.previous);
  rotation.candidate = await copyMaterial(root, 'candidate', rotation.candidate);
  const metadataDirectory = path.join(root, 'candidate-metadata');
  await rotationMetadata(metadataDirectory, app, certificate);
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
    { cwd: metadataDirectory }
  );
  if (validation.success !== true || validation.status !== 'Succeeded' || validation.checkOnly !== true)
    throw new Error('Replacement certificate metadata validation failed; active app and store were not changed.');
  rotation.validationId = validation.id;
  rotation.storeInventory = inventory;
  rotation.phase = 'prepared';
  await save();
  return {
    status: 'rotation-prepared',
    rotationId: rotation.id,
    fingerprint: rotation.candidate.fingerprint,
    validTo: rotation.candidate.validTo,
    rollbackAvailable: true,
    activeAppChanged: false,
    secretChanged: false
  };
}

async function cleanupJwtAttempt(attempt, root, save) {
  if (
    typeof attempt.directory !== 'string' ||
    path.dirname(path.resolve(attempt.directory)) !== root ||
    !/^jwt-check-[a-zA-Z0-9]{6}$/.test(path.basename(attempt.directory))
  )
    throw new Error('Rotation JWT cleanup path is outside its owned operation; preserve state.');
  try {
    // Node's bounded native retry handles transient Windows file locks. Force
    // only makes an already-absent owned home idempotent; permission errors remain failures.
    await fs.rm(attempt.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    attempt.cleanup = true;
    attempt.cleanedAt = new Date().toISOString();
  } catch (error) {
    attempt.cleanup = false;
    attempt.cleanupErrorCode = ['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(error.code)
      ? error.code
      : 'UNKNOWN';
    throw new Error(
      `Rotation JWT verification state cleanup failed (${attempt.cleanupErrorCode}); retained private directory: ${attempt.directory}`
    );
  } finally {
    await save();
  }
}

async function freshJwt({ sf, state, user, rotation, inputs, material, root, save }) {
  const directory = await fs.mkdtemp(path.join(root, 'jwt-check-'));
  const attempt = { directory, fingerprint: material.fingerprint, startedAt: new Date().toISOString(), cleanup: false };
  (rotation.loginAttempts ||= []).push(attempt);
  await save();
  let failure;
  try {
    await secureDirectory(directory);
    const options = { cwd: directory, env: isolatedEnv(directory) };
    const orgs = await sf(['org', 'list'], options);
    if (
      !Array.isArray(orgs.nonScratchOrgs) ||
      !Array.isArray(orgs.scratchOrgs) ||
      orgs.nonScratchOrgs.length ||
      orgs.scratchOrgs.length
    )
      throw new Error('Rotation verification requires empty CLI state.');
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
        material.privateKeyFile
      ],
      options
    );
    if (login.username !== user.Username || login.orgId !== state.org)
      throw new Error('Fresh rotation JWT did not confirm the intended dedicated identity and Dev Hub.');
    const result = await sf(
      [
        'data',
        'query',
        '--target-org',
        user.Username,
        '--query',
        `SELECT Id, Username FROM User WHERE Username = '${user.Username}'`
      ],
      options
    );
    if (
      result.done !== true ||
      result.records?.length !== 1 ||
      result.records[0].Id !== user.Id ||
      result.records[0].Username !== user.Username
    )
      throw new Error('Fresh rotation API session did not confirm the dedicated user.');
    attempt.verifiedAt = new Date().toISOString();
  } catch (error) {
    failure = error;
    attempt.failure = error.message;
  }
  try {
    await cleanupJwtAttempt(attempt, root, save);
  } catch (error) {
    failure = failure ? new Error(`${failure.message} ${error.message}`) : error;
  }
  if (failure) throw failure;
}

async function applyRotation({ values, state, directory, user, query, sf, gh, command, save }) {
  const rotation = state.rotation;
  const direction = command === 'apply-rotation' ? 'forward' : values['recovery-direction'];
  const app = state.apps?.permanent;
  const phases = [
    'prepared',
    'app-update-pending',
    'app-updated',
    'store-update-pending',
    'store-updated',
    'applied',
    'rolled-back'
  ];
  if (
    !rotation ||
    rotation.id !== values['rotation-id'] ||
    !/^[0-9a-f-]{36}$/.test(rotation.id) ||
    rotation.owner !== state.owner ||
    rotation.appId !== app?.id ||
    !app.configured ||
    app.revoked ||
    !phases.includes(rotation.phase) ||
    !['forward', 'rollback'].includes(direction)
  )
    throw new Error(
      'Rotation identity, phase or recovery direction is invalid; preserve state and reconcile before mutation.'
    );
  const material = direction === 'forward' ? rotation.candidate : rotation.previous;
  const root = path.join(directory, `rotation-${rotation.id}`);
  if (
    material.privateKeyFile !==
      path.join(root, direction === 'forward' ? 'candidate' : 'previous', 'private-key.pem') ||
    material.certificateFile !== path.join(root, direction === 'forward' ? 'candidate' : 'previous', 'certificate.pem')
  )
    throw new Error('Rotation recovery material is outside its recorded owned directory.');
  let certificate;
  try {
    certificate = await readCertificate(material.certificateFile, material.privateKeyFile, material.lifecycle);
  } catch {
    throw new Error(
      `Valid ${direction} certificate/private-key material is unavailable. GitHub Secrets cannot return old keys; preserve state and select an available recovery direction.`
    );
  }
  if (certificate.fingerprint !== material.fingerprint)
    throw new Error('Rotation recovery fingerprint differs from its recorded material.');
  if (rotation.loginAttempts !== undefined && !Array.isArray(rotation.loginAttempts))
    throw new Error('Rotation JWT verification history is invalid; preserve state.');
  for (const attempt of rotation.loginAttempts || []) {
    if (!attempt || ![rotation.previous.fingerprint, rotation.candidate.fingerprint].includes(attempt.fingerprint))
      throw new Error('Rotation JWT verification ownership is invalid; preserve state.');
    if (attempt.cleanup !== true) await cleanupJwtAttempt(attempt, root, save);
  }
  const inputs = await privateInputs(app, user);
  const store = githubStore(material.lifecycle, gh);
  await store.inspect();
  assertKnownProofPhases(state);
  await auditRuntime(query, user, { state, sf, target: values['target-org'], requireRuntime: true });
  const audit = () =>
    verifyProofApp({
      sf,
      query,
      target: values['target-org'],
      directory,
      state,
      mode: 'permanent',
      user,
      clientId: inputs.clientId,
      acceptedFingerprints: [rotation.previous.fingerprint, rotation.candidate.fingerprint]
    });
  const current = await audit();
  const status = direction === 'forward' ? 'rotation-applied' : 'rotation-rolled-back';
  const finalPhase = direction === 'forward' ? 'applied' : 'rolled-back';
  if (rotation.phase === finalPhase) {
    if (current.fingerprint !== material.fingerprint || app.fingerprint !== material.fingerprint)
      throw new Error('Completed rotation differs from the active certificate; explicit recovery is required.');
    return { status, rotationId: rotation.id, fingerprint: app.fingerprint, ciVerified: false };
  }
  if (current.fingerprint !== material.fingerprint) {
    if (rotation.phase === 'prepared' && direction === 'forward')
      await freshJwt({ sf, state, user, rotation, inputs, material: rotation.previous, root, save });
    const metadataDirectory = path.join(root, `${direction}-metadata`);
    await rotationMetadata(metadataDirectory, app, certificate);
    rotation.direction = direction;
    rotation.phase = 'app-update-pending';
    await save();
    rotation.deployment = await validatedDeploy(sf, values['target-org'], metadataDirectory);
    const updated = await audit();
    if (updated.fingerprint !== material.fingerprint)
      throw new Error('Replacement certificate was not observed; preserve state for recovery.');
  }
  rotation.phase = 'app-updated';
  rotation.direction = direction;
  await save();
  await freshJwt({ sf, state, user, rotation, inputs, material, root, save });
  rotation.phase = 'store-update-pending';
  await save();
  await store.replacePrivateKey(await fs.readFile(material.privateKeyFile, 'utf8'));
  rotation.storeWrittenAt = new Date().toISOString();
  rotation.phase = 'store-updated';
  await save();
  const inputsFile = path.join(root, `${direction}-jwt-inputs.json`);
  await fs.writeFile(inputsFile, JSON.stringify({ ...inputs, privateKeyFile: material.privateKeyFile }), {
    mode: 0o600
  });
  Object.assign(app, material, { inputsFile });
  rotation.phase = finalPhase;
  rotation.completedAt = new Date().toISOString();
  await save();
  return {
    status,
    rotationId: rotation.id,
    fingerprint: app.fingerprint,
    validTo: app.validTo,
    ciVerified: false,
    storeWrittenAt: rotation.storeWrittenAt,
    recoveryDirectory: root
  };
}

module.exports = { rotationInputs, prepareRotation, applyRotation };
