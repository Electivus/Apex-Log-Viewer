'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { metadataProject, validatedDeploy, xml, xmlValue } = require('./devhub-identity-app');
const { isolatedEnv, assertKnownProofPhases } = require('./devhub-identity-proof');
const { secureDirectory } = require('./devhub-identity-credentials');

async function revokeApp({ values, state, inventory, directory, user, sf, save }) {
  assertKnownProofPhases(state);
  const mode = values['credential-mode'];
  const app = state.apps?.[mode];
  if (
    !['temporary', 'permanent'].includes(mode) ||
    !app?.id ||
    !inventory.apps.some(
      item =>
        item.Id === app.id &&
        item.DeveloperName === app.name &&
        item.Description === app.marker &&
        item.ContactEmail === state.contact
    )
  ) {
    throw new Error('App ownership cannot be verified; no app will be disabled.');
  }
  if (
    state.proof &&
    state.proof.appMode === mode &&
    (!state.proof.cleanup?.scratchDeleted || !state.proof.cleanup?.poolDeleted)
  ) {
    throw new Error('Recover the owned scratch/pool with cleanup-proof before revoking its only runtime access.');
  }
  const project = path.join(directory, `app-${mode}`, 'revoke');
  const relative = `extlClntAppPolicies/${app.name}_plcy.ecaPlcy-meta.xml`;
  await metadataProject(project, {
    [relative]: xml('ExtlClntAppConfigurablePolicies', {
      externalClientApplication: app.name,
      isEnabled: false,
      isOauthPluginEnabled: true,
      label: `${app.name} Policies`,
      startPage: 'None'
    })
  });
  app.revocationDeployment = await validatedDeploy(sf, values['target-org'], project);
  await save();
  const retrieved = path.join(directory, `app-${mode}`, 'revocation-check');
  await metadataProject(retrieved, {});
  const result = await sf(
    [
      'project',
      'retrieve',
      'start',
      '--target-org',
      values['target-org'],
      '--wait',
      '10',
      '--metadata',
      `ExtlClntAppConfigurablePolicies:${app.name}_plcy`
    ],
    { cwd: retrieved }
  );
  if (
    result.success !== true ||
    xmlValue(await fs.readFile(path.join(retrieved, 'force-app', 'main', 'default', relative), 'utf8'), 'isEnabled') !==
      'false'
  ) {
    throw new Error('App disablement was not confirmed; preserve the key and state for recovery.');
  }
  app.revoked = true;
  app.revokedAt = new Date().toISOString();
  await save();
  if (app.inputsFile) {
    const home = await fs.mkdtemp(path.join(directory, `revocation-${mode}-`));
    await secureDirectory(home);
    app.revocationHome = home;
    await save();
    let inputs;
    try {
      inputs = JSON.parse(await fs.readFile(app.inputsFile, 'utf8'));
    } catch {
      throw new Error('The app is disabled but JWT rejection could not be checked; private inputs unavailable.');
    }
    try {
      await sf(
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
          app.privateKeyFile
        ],
        { cwd: home, env: isolatedEnv(home) }
      );
    } catch (error) {
      app.jwtRejection = ['INVALID_CLIENT', 'INVALID_GRANT'].includes(error.code)
        ? error.code
        : 'UNVERIFIED_TRANSPORT_OR_CLI_FAILURE';
      await save();
    }
    if (!app.jwtRejection)
      throw new Error(
        'A fresh JWT login unexpectedly succeeded after disablement; retain state and credentials for investigation.'
      );
  }
  return {
    status: 'app-disabled',
    name: app.name,
    jwtRejection: app.jwtRejection || 'NOT_ATTEMPTED_NO_INPUTS',
    retainedUserId: user.Id,
    retainedAssignments: true,
    retainedPrivateAppDirectory: path.join(directory, `app-${mode}`)
  };
}

async function cleanupAppFiles({ values, state, directory, save }) {
  assertKnownProofPhases(state);
  const mode = values['credential-mode'];
  const app = state.apps?.[mode];
  if (mode !== 'temporary' || !app?.revoked)
    throw new Error(
      'Local app cleanup is limited to a revoked temporary app; permanent credentials require their separate lifecycle procedure.'
    );
  if (
    [...(state.proofHistory || []), ...(state.proof ? [state.proof] : [])].some(
      proof => proof.appMode === mode && !proof.cleanup?.localDirectoryDeleted
    )
  )
    throw new Error('Run cleanup-proof before removing temporary app files.');
  const credentialDirectory = path.join(directory, 'credentials-temporary');
  const ownedCredentials =
    app.privateKeyFile === path.join(credentialDirectory, 'private-key.pem') &&
    app.certificateFile === path.join(credentialDirectory, 'certificate.pem');
  if (ownedCredentials && !app.localFilesDeleted) {
    const cert = new X509Certificate(await fs.readFile(app.certificateFile));
    if (cert.fingerprint256 !== app.fingerprint) throw new Error('Credential fingerprint changed; cleanup stopped.');
  }
  const targets = [path.join(directory, 'app-temporary'), ...(ownedCredentials ? [credentialDirectory] : [])];
  if (app.revocationHome) {
    if (
      path.dirname(app.revocationHome) !== directory ||
      !path.basename(app.revocationHome).startsWith('revocation-temporary-')
    )
      throw new Error('Unexpected revocation directory.');
    targets.push(app.revocationHome);
  }
  for (const target of targets) {
    try {
      const actual = await fs.realpath(target);
      if (actual !== target || path.dirname(actual) !== directory) throw new Error('Unexpected cleanup target.');
      await fs.rm(actual, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(`Temporary app cleanup failed; do not retry through another mechanism: ${target}`);
    }
  }
  app.localFilesDeleted = true;
  await save();
  return {
    status: 'temporary-app-files-cleaned',
    retainedExternalCredentials: !ownedCredentials,
    retainedDisabledApp: app.name,
    retainedPreauthorization: app.preauthorization,
    retainedUserId: state.userId
  };
}

module.exports = { revokeApp, cleanupAppFiles };
