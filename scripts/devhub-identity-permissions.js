'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { metadataProject, validatedDeploy, xmlValue } = require('./devhub-identity-app');

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

async function auditRuntime(query, user) {
  const assignments = await query(
    `SELECT Id, PermissionSetId, PermissionSet.Name, ${ADMINISTRATIVE_PERMISSIONS.map(
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
  return assignments;
}

async function grantRuntime({ values, state, directory, query, user, sf, save }) {
  const assignments = await auditRuntime(query, user);
  const permissionName = 'ALV_ScratchOrgPoolService';
  const project = path.join(directory, 'runtime-permissions');
  const source = await fs.readFile(
    path.join(
      __dirname,
      '..',
      'force-app',
      'main',
      'default',
      'permissionsets',
      `${permissionName}.permissionset-meta.xml`
    ),
    'utf8'
  );
  await metadataProject(project, { [`permissionsets/${permissionName}.permissionset-meta.xml`]: source });
  state.runtimeDeployment = await validatedDeploy(sf, values['target-org'], project);
  await save();
  const permissionSets = await query(
    `SELECT Id, Name, IsOwnedByProfile, ${ADMINISTRATIVE_PERMISSIONS.join(', ')} FROM PermissionSet WHERE Name = '${permissionName}'`
  );
  const matching = permissionSets.filter(item => item.Name === permissionName);
  if (
    matching.length !== 1 ||
    matching[0].IsOwnedByProfile !== false ||
    ADMINISTRATIVE_PERMISSIONS.some(name => matching[0][name] !== false)
  ) {
    throw new Error('Runtime permission set has unexpected administrative grants or is not uniquely available.');
  }
  const permissionSetId = matching[0].Id;
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
  await auditRuntime(query, user);
  const objects = await query(
    `SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId = '${permissionSetId}'`
  );
  const scratch = objects.find(item => item.SobjectType === 'ScratchOrgInfo');
  if (scratch?.PermissionsCreate !== true) {
    throw new Error('ScratchOrgInfo creation permission is missing after deployment; runtime proof cannot proceed.');
  }
  const permissionMap = {
    allowRead: 'PermissionsRead',
    allowCreate: 'PermissionsCreate',
    allowEdit: 'PermissionsEdit',
    allowDelete: 'PermissionsDelete',
    viewAllRecords: 'PermissionsViewAllRecords',
    modifyAllRecords: 'PermissionsModifyAllRecords'
  };
  for (const block of source.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/g)) {
    const name = xmlValue(block[1], 'object');
    const actual = objects.find(item => item.SobjectType === name);
    if (
      !actual ||
      Object.entries(permissionMap).some(
        ([xmlName, apiName]) => actual[apiName] !== (xmlValue(block[1], xmlName) === 'true')
      )
    ) {
      throw new Error(`Runtime object grants differ for ${name}; stop before proof.`);
    }
  }
  const fields = await query(
    `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = '${permissionSetId}'`
  );
  for (const block of source.matchAll(/<fieldPermissions>([\s\S]*?)<\/fieldPermissions>/g)) {
    const name = xmlValue(block[1], 'field');
    const actual = fields.find(item => item.Field === name);
    if (actual?.PermissionsRead !== true || actual?.PermissionsEdit !== true) {
      throw new Error(`Runtime field access is missing for ${name}; stop before proof.`);
    }
  }
  const classes = await query(
    "SELECT Id, Name FROM ApexClass WHERE Name IN ('ALVScratchPoolRest','ALVScratchPoolService') AND NamespacePrefix = null",
    true
  );
  const access = await query(
    `SELECT SetupEntityId FROM SetupEntityAccess WHERE ParentId = '${permissionSetId}' AND SetupEntityType = 'ApexClass'`
  );
  if (classes.length !== 2 || classes.some(item => !access.some(grant => grant.SetupEntityId === item.Id))) {
    throw new Error('Runtime pool Apex class access is missing; stop before proof.');
  }
  state.runtime = {
    permissionSetId,
    objects,
    fieldCount: fields.length,
    classes: classes.map(item => item.Name),
    verifiedAt: new Date().toISOString()
  };
  await save();
  return { status: 'runtime-ready', permissionSetId, userId: user.Id, objects };
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
  await auditRuntime(query, user);
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
  const assignments = await query(
    `SELECT Id, PermissionSetId, PermissionSet.Name FROM PermissionSetAssignment WHERE AssigneeId = '${user.Id}'`
  );
  for (const assignment of assignments.filter(item => item.PermissionSet?.Name === 'ALV_ScratchOrgPoolService')) {
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
