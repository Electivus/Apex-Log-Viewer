'use strict';

const path = require('node:path');
const { metadataProject, validatedDeploy, verifyPreauthorization } = require('./devhub-identity-app');
const { RUNTIME_PERMISSION_SET, readRuntimeSource, verifyRuntimeGrants } = require('./devhub-identity-runtime-grants');

const ADMINISTRATIVE_PERMISSIONS = [
  'PermissionsModifyAllData',
  'PermissionsModifyMetadata',
  'PermissionsCustomizeApplication',
  'PermissionsAuthorApex',
  'PermissionsManageUsers',
  'PermissionsManageProfilesPermissionsets',
  'PermissionsManageRoles',
  'PermissionsViewAllData'
];

async function auditRuntime(query, user, { state, sf, target, requireRuntime = false }) {
  const assignments = await query(
    `SELECT Id, AssigneeId, PermissionSetId, PermissionSetGroupId, PermissionSet.Name, PermissionSet.IsOwnedByProfile, PermissionSet.ProfileId, ${ADMINISTRATIVE_PERMISSIONS.map(
      name => `PermissionSet.${name}`
    ).join(', ')} FROM PermissionSetAssignment WHERE AssigneeId = '${user.Id}'`
  );
  if (
    assignments.some(assignment => ADMINISTRATIVE_PERMISSIONS.some(name => assignment.PermissionSet?.[name] === true))
  ) {
    throw new Error(
      "Runtime identity has administrative grants; preserve unrelated assignments and obtain the owner's decision."
    );
  }
  const profiles = await query(
    `SELECT Id, Name, ${ADMINISTRATIVE_PERMISSIONS.join(', ')} FROM Profile WHERE Id = '${user.ProfileId}'`
  );
  const profile = profiles.find(item => item.Id === user.ProfileId);
  if (
    !profile ||
    ADMINISTRATIVE_PERMISSIONS.some(name => profile[name] !== false) ||
    assignments.some(assignment => ADMINISTRATIVE_PERMISSIONS.some(name => assignment.PermissionSet?.[name] !== false))
  ) {
    throw new Error('Runtime administrative grants are present or incompletely reported; do not proceed.');
  }
  const verified = new Set();
  let runtimeAssigned = false;
  let runtimePermissionSetId;
  const unrecognized = () =>
    new Error('Unrecognized or unverified runtime permission-set assignment; preserve access and reconcile ownership.');
  if (state.userId !== user.Id) throw unrecognized();
  for (const assignment of assignments) {
    if (
      !assignment.Id ||
      !assignment.PermissionSetId ||
      assignment.AssigneeId !== user.Id ||
      assignment.PermissionSetGroupId !== null ||
      verified.has(assignment.PermissionSetId)
    )
      throw unrecognized();
    const name = assignment.PermissionSet?.Name;
    let permissionSetId;
    if (name === RUNTIME_PERMISSION_SET) {
      const sets = await query(
        `SELECT Id, Name, IsOwnedByProfile, Type, NamespacePrefix FROM PermissionSet WHERE Name = '${RUNTIME_PERMISSION_SET}'`
      );
      if (
        sets.length !== 1 ||
        sets[0].Name !== name ||
        sets[0].IsOwnedByProfile !== false ||
        sets[0].Type !== 'Regular' ||
        sets[0].NamespacePrefix !== null ||
        (state.runtime && state.runtime.permissionSetId !== sets[0].Id) ||
        (state.runtimeAssignmentId && state.runtimeAssignmentId !== assignment.Id)
      )
        throw unrecognized();
      permissionSetId = sets[0].Id;
      runtimePermissionSetId = permissionSetId;
      runtimeAssigned = true;
    } else if (assignment.PermissionSet?.IsOwnedByProfile === true) {
      // Salesforce exposes the user's profile through its own assignment too.
      // Bind this generated set to the already verified minimum profile by ID.
      const sets = await query(
        `SELECT Id, Name, IsOwnedByProfile, ProfileId, Type, NamespacePrefix FROM PermissionSet WHERE ProfileId = '${user.ProfileId}'`
      );
      if (
        sets.length !== 1 ||
        sets[0].Name !== name ||
        sets[0].IsOwnedByProfile !== true ||
        sets[0].ProfileId !== user.ProfileId ||
        assignment.PermissionSet.ProfileId !== user.ProfileId ||
        sets[0].Type !== 'Profile' ||
        sets[0].NamespacePrefix !== null
      )
        throw unrecognized();
      permissionSetId = sets[0].Id;
    } else {
      const apps = Object.entries(state.apps || {}).filter(
        ([mode, app]) =>
          ['temporary', 'permanent'].includes(mode) &&
          app.preauthorization === name &&
          app.id &&
          app.name ===
            `ALV_DevHub_${state.owner.replaceAll('-', '').slice(0, 16)}_${mode === 'temporary' ? 'Test' : 'CI'}` &&
          app.marker === `alv-devhub:${state.owner}:${mode}` &&
          name === `${app.name}_Access` &&
          (!app.assignmentId || app.assignmentId === assignment.Id)
      );
      if (apps.length !== 1) throw unrecognized();
      permissionSetId = await verifyPreauthorization(sf, target, query, apps[0][1]);
    }
    if (!permissionSetId || assignment.PermissionSetId !== permissionSetId) throw unrecognized();
    verified.add(permissionSetId);
  }
  if (requireRuntime && !runtimeAssigned) throw new Error('Verified runtime permission-set assignment is missing.');
  if (runtimeAssigned) await verifyRuntimeGrants(sf, target, query, runtimePermissionSetId);
  return assignments;
}

async function grantRuntime({ values, state, directory, query, user, sf, save }) {
  const auditOptions = { state, sf, target: values['target-org'] };
  const assignments = await auditRuntime(query, user, auditOptions);
  const permissionName = RUNTIME_PERMISSION_SET;
  const project = path.join(directory, 'runtime-permissions');
  const source = await readRuntimeSource();
  await metadataProject(project, { [`permissionsets/${permissionName}.permissionset-meta.xml`]: source });
  state.runtimeDeployment = await validatedDeploy(sf, values['target-org'], project);
  await save();
  // Verify the deployed set before attaching it to the identity. On reruns the
  // initial audit above also rejects drift before attempting a deployment.
  const runtime = await verifyRuntimeGrants(sf, values['target-org'], query);
  const permissionSetId = runtime.permissionSetId;
  if (!assignments.some(assignment => assignment.PermissionSetId === permissionSetId)) {
    try {
      const result = await sf([
        'data',
        'create',
        'record',
        '--target-org',
        values['target-org'],
        '--sobject',
        'PermissionSetAssignment',
        '--values',
        `AssigneeId='${user.Id}' PermissionSetId='${permissionSetId}'`
      ]);
      if (!result.success || !result.id) throw new Error('Runtime permission assignment is unconfirmed.');
      state.runtimeAssignmentId = result.id;
      await save();
    } catch (error) {
      state.runtimeFailure = {
        phase: 'permission-set-assignment',
        code: error.code || 'UNCONFIRMED',
        license: state.license,
        at: new Date().toISOString(),
        licenseRestriction: error.licenseRestriction === true,
        affectedObjects: error.affectedObjects || []
      };
      if (state.license === 'integration' && error.licenseRestriction === true) {
        state.integrationFailure = state.runtimeFailure;
      }
      await save();
      throw new Error(
        `Runtime permission assignment failed (${state.runtimeFailure.code}); sanitized evidence is in identity.json.`
      );
    }
  }
  await auditRuntime(query, user, { ...auditOptions, requireRuntime: true });
  state.runtime = runtime;
  await save();
  return { status: 'runtime-ready', permissionSetId, userId: user.Id, objects: runtime.objects };
}

async function useSalesforceFallback({ values, state, inventory, user, query, sf, save }) {
  if (
    !state.integrationFailure ||
    state.integrationFailure.license !== 'integration' ||
    state.integrationFailure.licenseRestriction !== true ||
    !state.integrationFailure.affectedObjects?.some(name => ['ScratchOrgInfo', 'ActiveScratchOrg'].includes(name))
  ) {
    throw new Error(
      'The Salesforce fallback requires recorded Integration incompatibility for the required scratch lifecycle.'
    );
  }
  const assignments = await auditRuntime(query, user, { state, sf, target: values['target-org'] });
  const candidate = inventory.candidates.salesforce;
  if (!candidate.profileId) throw new Error('The minimum Salesforce profile is unavailable.');
  if (state.license === 'salesforce' && !state.pendingTransition) {
    return {
      status: 'fallback-ready',
      userId: user.Id,
      profile: candidate.profile,
      compatibility: state.integrationFailure
    };
  }
  if (
    state.pendingTransition &&
    (state.pendingTransition.toProfile !== candidate.profileId ||
      state.pendingTransition.fromProfile !== inventory.candidates.integration.profileId)
  ) {
    throw new Error('The pending license transition no longer matches the live minimum profiles.');
  }
  const licenses = await query(
    "SELECT Id, Name, TotalLicenses, UsedLicenses FROM UserLicense WHERE Name = 'Salesforce'"
  );
  const currentLicense = licenses.find(item => item.Id === candidate.licenseId);
  if (
    user.ProfileId !== candidate.profileId &&
    (!currentLicense || currentLicense.TotalLicenses <= currentLicense.UsedLicenses)
  ) {
    throw new Error('Salesforce license capacity is exhausted; no profile/assignment changes were attempted.');
  }
  state.pendingTransition ||= {
    fromProfile: inventory.candidates.integration.profileId,
    toProfile: candidate.profileId,
    startedAt: new Date().toISOString()
  };
  await save();
  for (const assignment of assignments.filter(item => item.PermissionSet?.Name === RUNTIME_PERMISSION_SET)) {
    const result = await sf([
      'data',
      'delete',
      'record',
      '--target-org',
      values['target-org'],
      '--sobject',
      'PermissionSetAssignment',
      '--record-id',
      assignment.Id
    ]);
    if (!result.success)
      throw new Error('Runtime assignment removal is unconfirmed; resume the same license transition.');
  }
  const psls = await query(
    `SELECT Id, PermissionSetLicenseId FROM PermissionSetLicenseAssign WHERE AssigneeId = '${user.Id}'`
  );
  if (psls.some(item => item.PermissionSetLicenseId !== inventory.candidates.integration.permissionSetLicenseId)) {
    throw new Error('Unexpected permission set license on the owned user; no unrelated license will be removed.');
  }
  for (const assignment of psls) {
    const result = await sf([
      'data',
      'delete',
      'record',
      '--target-org',
      values['target-org'],
      '--sobject',
      'PermissionSetLicenseAssign',
      '--record-id',
      assignment.Id
    ]);
    if (!result.success) throw new Error('Integration PSL removal is unconfirmed; resume the same license transition.');
  }
  if (user.ProfileId !== candidate.profileId) {
    try {
      const result = await sf([
        'data',
        'update',
        'record',
        '--target-org',
        values['target-org'],
        '--sobject',
        'User',
        '--record-id',
        user.Id,
        '--values',
        `ProfileId='${candidate.profileId}'`
      ]);
      if (!result.success) throw new Error('Unconfirmed update');
    } catch {
      throw new Error(
        'The profile update is unconfirmed; rerun use-salesforce-fallback to reconcile the saved transition before another write.'
      );
    }
  }
  const currentUsers = await query(
    `SELECT Id, Username, Email, IsActive, ProfileId, FederationIdentifier FROM User WHERE Id = '${user.Id}'`
  );
  const current = currentUsers.find(item => item.Id === user.Id);
  if (
    !current ||
    current.ProfileId !== candidate.profileId ||
    current.FederationIdentifier !== `alv-devhub:${state.owner}`
  ) {
    throw new Error('Fallback user verification failed; preserve the pending transition for recovery.');
  }
  state.license = 'salesforce';
  state.fallback = {
    ...state.pendingTransition,
    completedAt: new Date().toISOString(),
    evidence: state.integrationFailure
  };
  delete state.pendingTransition;
  delete state.runtime;
  delete state.runtimeAssignmentId;
  delete state.permissionSetLicenseAssignmentId;
  await save();
  return {
    status: 'fallback-ready',
    userId: user.Id,
    profile: candidate.profile,
    compatibility: state.integrationFailure
  };
}

module.exports = { grantRuntime, auditRuntime, useSalesforceFallback, ADMINISTRATIVE_PERMISSIONS };
