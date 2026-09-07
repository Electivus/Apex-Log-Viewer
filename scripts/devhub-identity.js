#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const CONTACT = 'apex-log-viewer-ci@electivus.com';
const { lifecycleInputs, createCertificate, secureDirectory } = require('./devhub-identity-credentials');
const { provisionApp } = require('./devhub-identity-app');
const { grantRuntime, useSalesforceFallback } = require('./devhub-identity-permissions');
const { nativeSf, safeFailure } = require('./devhub-identity-sf');
const { prove, recoverProof } = require('./devhub-identity-proof');
const { revokeApp, cleanupAppFiles } = require('./devhub-identity-teardown');

function soqlLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function sfValues(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key}='${soqlLiteral(value)}'`)
    .join(' ');
}

async function loadState(directory) {
  try {
    return JSON.parse(await fs.readFile(path.join(directory, 'identity.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Cannot read identity.json; preserve it for recovery.');
  }
}

async function saveState(directory, state) {
  const pending = path.join(directory, 'identity.pending.json');
  await fs.writeFile(pending, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(pending, path.join(directory, 'identity.json'));
}

async function main(argv = process.argv.slice(2), { sf: invoke = nativeSf } = {}) {
  const sf = async (...args) => {
    try {
      return await invoke(...args);
    } catch (error) {
      if (error.licenseRestriction === true && error.code === 'FIELD_INTEGRITY_EXCEPTION') {
        throw safeFailure({
          message: 'User license does not allow ' + (error.affectedObjects || []).join(' '),
          code: error.code
        });
      }
      throw safeFailure(error);
    }
  };
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'target-org': { type: 'string' },
      'expected-org-id': { type: 'string' },
      'state-dir': { type: 'string' },
      'credential-mode': { type: 'string' },
      'storage-policy': { type: 'string' },
      'certificate-days': { type: 'string' },
      'policy-reference': { type: 'string' },
      'certificate-file': { type: 'string' },
      'private-key-file': { type: 'string' },
      openssl: { type: 'string' },
      'pool-mode': { type: 'string' },
      'snapshot-name': { type: 'string' }
    }
  });
  if (
    positionals.length !== 1 ||
    ![
      'inspect',
      'provision-user',
      'provision-app',
      'create-certificate',
      'grant-runtime',
      'use-salesforce-fallback',
      'prove',
      'cleanup-proof',
      'revoke-app',
      'cleanup-app-files'
    ].includes(positionals[0])
  ) {
    throw new Error(
      'Use inspect, provision-user, create-certificate, provision-app, grant-runtime, use-salesforce-fallback, prove, cleanup-proof, revoke-app or cleanup-app-files.'
    );
  }
  if (positionals[0] === 'create-certificate') return createCertificate(values);
  if (positionals[0] === 'provision-app') {
    lifecycleInputs(values, true);
  }
  if (!values['target-org'] || !/^00D[a-zA-Z0-9]{15}$/.test(values['expected-org-id'] || '')) {
    throw new Error('Explicit --target-org and an 18-character --expected-org-id are required.');
  }
  const query = async (soql, tooling = false) => {
    const result = await sf([
      'data',
      'query',
      '--target-org',
      values['target-org'],
      '--query',
      soql,
      ...(tooling ? ['--use-tooling-api'] : [])
    ]);
    if (!Array.isArray(result.records) || result.done === false) {
      throw new Error('Incomplete Salesforce inventory; no mutation is allowed.');
    }
    return result.records.map(({ attributes, ...record }) => record);
  };
  const orgs = await query('SELECT Id, IsSandbox, OrganizationType FROM Organization');
  if (orgs?.length !== 1 || orgs[0].Id !== values['expected-org-id']) {
    throw new Error('Target org does not match --expected-org-id; no mutation was attempted.');
  }
  const licenses = await query(
    "SELECT Id, Name, TotalLicenses, UsedLicenses FROM UserLicense WHERE Name IN ('Salesforce Integration','Salesforce')"
  );
  const profiles = await query(
    "SELECT Id, Name, UserLicenseId, PermissionsApiEnabled, PermissionsApiUserOnly, PermissionsModifyAllData, PermissionsModifyMetadata, PermissionsManageUsers FROM Profile WHERE Name IN ('Minimum Access - API Only Integrations','Minimum Access - Salesforce')"
  );
  const psls = await query(
    "SELECT Id, MasterLabel, DeveloperName, TotalLicenses, UsedLicenses FROM PermissionSetLicense WHERE DeveloperName = 'SalesforceAPIIntegrationPsl'"
  );
  const users = await query(
    `SELECT Id, Username, Email, IsActive, ProfileId, FederationIdentifier FROM User WHERE Email = '${CONTACT}' OR Username = '${CONTACT}' OR FederationIdentifier LIKE 'alv-devhub:%'`
  );
  const apps = await query(
    "SELECT Id, DeveloperName, Description, ContactEmail FROM ExternalClientApplication WHERE DeveloperName LIKE 'ALV%'",
    true
  );
  const permissionSets = await query(
    "SELECT Id, Name, Label, Description, IsOwnedByProfile FROM PermissionSet WHERE Name LIKE 'ALV%'"
  );
  const scratches = await query('SELECT Id, OwnerId, ScratchOrgInfoId, ExpirationDate FROM ActiveScratchOrg');
  const pools = await query('SELECT Id, PoolKey__c, ProvisioningMode__c, TargetSize__c FROM ALV_ScratchOrgPool__c');
  const candidates = {};
  for (const [key, licenseName, profileName] of [
    ['integration', 'Salesforce Integration', 'Minimum Access - API Only Integrations'],
    ['salesforce', 'Salesforce', 'Minimum Access - Salesforce']
  ]) {
    const matchingLicenses = licenses.filter(item => item.Name === licenseName);
    const matchingProfiles = profiles.filter(item => item.Name === profileName);
    if (matchingLicenses.length !== 1 || matchingProfiles.length !== 1) {
      candidates[key] = { unavailable: 'Expected minimum license/profile not uniquely available.' };
      continue;
    }
    const license = matchingLicenses[0];
    const profile = matchingProfiles[0];
    if (
      profile.UserLicenseId !== license.Id ||
      profile.PermissionsModifyAllData !== false ||
      profile.PermissionsModifyMetadata !== false ||
      profile.PermissionsManageUsers !== false ||
      (key === 'integration' && (profile.PermissionsApiEnabled !== true || profile.PermissionsApiUserOnly !== true))
    ) {
      throw new Error('Minimum profile has unexpected license or administrative grants.');
    }
    candidates[key] = {
      licenseId: license.Id,
      profileId: profile.Id,
      profile: profile.Name,
      available: license.TotalLicenses - license.UsedLicenses
    };
    if (key === 'integration') {
      candidates[key].permissionSetLicenseId = psls.length === 1 ? psls[0].Id : null;
      candidates[key].permissionSetLicenseAvailable =
        psls.length === 1 ? psls[0].TotalLicenses - psls[0].UsedLicenses : 0;
    }
  }
  const inventory = { org: orgs[0].Id, contact: CONTACT, candidates, users, apps, permissionSets, scratches, pools };
  if (positionals[0] === 'inspect') {
    return inventory;
  }
  if (!values['state-dir']) {
    throw new Error('--state-dir is required to record ownership and resume safely.');
  }
  await fs.mkdir(path.resolve(values['state-dir']), { recursive: true, mode: 0o700 });
  const directory = await fs.realpath(values['state-dir']);
  const repo = await fs.realpath(path.resolve(__dirname, '..'));
  if (directory === repo || directory.startsWith(`${repo}${path.sep}`)) {
    throw new Error('--state-dir must be outside the repository.');
  }
  await secureDirectory(directory);
  let lock;
  try {
    lock = await fs.open(path.join(directory, 'operation.lock'), 'wx', 0o600);
  } catch {
    throw new Error('The state directory is locked; reconcile the previous operation before retrying.');
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    let state = await loadState(directory);
    if (
      state &&
      (state.org !== inventory.org ||
        state.version !== 1 ||
        !['integration', 'salesforce'].includes(state.license) ||
        state.contact !== CONTACT ||
        !/^[0-9a-f-]{36}$/.test(state.owner))
    ) {
      throw new Error('State ownership/org is invalid; no mutation is allowed.');
    }
    const owned = state ? users.filter(user => user.FederationIdentifier === `alv-devhub:${state.owner}`) : [];
    if (owned.length > 1 || (state?.userId && (owned.length !== 1 || owned[0].Id !== state.userId))) {
      throw new Error('Owned user cannot be reconciled uniquely; preserve state and inspect the org.');
    }
    if (users.some(user => user.Email === CONTACT && user.Id !== owned[0]?.Id)) {
      throw new Error('Another identity uses the purpose-specific contact; refusing to adopt or duplicate it.');
    }
    const candidate = candidates[state?.license || 'integration'];
    if (state?.pendingTransition && positionals[0] !== 'use-salesforce-fallback') {
      throw new Error('Resume the pending use-salesforce-fallback operation before any other mutation.');
    }
    if (
      !owned.length &&
      (!(candidate.available > 0) ||
        !candidate.permissionSetLicenseId ||
        !(candidate.permissionSetLicenseAvailable > 0))
    ) {
      throw new Error(
        'Integration license capacity or its minimum profile/permission set license is unavailable; no fallback was attempted.'
      );
    }
    if (!state) {
      state = {
        version: 1,
        org: inventory.org,
        owner: randomUUID(),
        license: 'integration',
        contact: CONTACT,
        username: CONTACT,
        createdAt: new Date().toISOString()
      };
      await saveState(directory, state);
    }
    let user = owned[0];
    const resumingProfile =
      state?.pendingTransition &&
      positionals[0] === 'use-salesforce-fallback' &&
      user?.ProfileId === state.pendingTransition.toProfile;
    if (
      user &&
      (user.Email !== CONTACT ||
        (user.ProfileId !== candidate.profileId && !resumingProfile) ||
        user.IsActive !== true ||
        !/^apex-log-viewer-ci(?:[+.-][a-zA-Z0-9-]+)?@electivus\.com$/.test(user.Username))
    ) {
      throw new Error('Owned user has unexpected contact, profile, username or activation; no mutation is allowed.');
    }
    if (positionals[0] === 'provision-app') {
      if (!user || !state.userId) throw new Error('Provision and reconcile the owned user before creating its app.');
      return await provisionApp({
        values,
        state,
        inventory,
        directory,
        user,
        query,
        sf,
        save: () => saveState(directory, state)
      });
    }
    if (positionals[0] === 'grant-runtime') {
      if (!user || !state.userId)
        throw new Error('Provision and reconcile the owned user before assigning runtime permissions.');
      return await grantRuntime({ values, state, directory, user, query, sf, save: () => saveState(directory, state) });
    }
    if (positionals[0] === 'use-salesforce-fallback') {
      if (!user || !state.userId)
        throw new Error('Provision and reconcile the owned user before changing its license.');
      return await useSalesforceFallback({
        values,
        state,
        inventory,
        user,
        query,
        sf,
        save: () => saveState(directory, state)
      });
    }
    if (['prove', 'cleanup-proof'].includes(positionals[0])) {
      if (!user || !state.userId) throw new Error('Provision and reconcile the owned user before native proof.');
      return await (positionals[0] === 'prove' ? prove : recoverProof)({
        values,
        state,
        directory,
        user,
        query,
        sf,
        save: () => saveState(directory, state)
      });
    }
    if (['revoke-app', 'cleanup-app-files'].includes(positionals[0])) {
      if (!user || !state.userId) throw new Error('Reconcile the owned user before teardown.');
      return await (positionals[0] === 'revoke-app' ? revokeApp : cleanupAppFiles)({
        values,
        state,
        inventory,
        directory,
        user,
        sf,
        save: () => saveState(directory, state)
      });
    }
    if (!user) {
      const fields = {
        Username: state.username,
        Email: CONTACT,
        LastName: 'Dev Hub Automation Identity',
        FirstName: 'Apex Log Viewer',
        Alias: 'alvci',
        CommunityNickname: `alvci-${state.owner.slice(0, 16)}`,
        TimeZoneSidKey: 'America/Bahia',
        LocaleSidKey: 'en_US',
        EmailEncodingKey: 'UTF-8',
        LanguageLocaleKey: 'en_US',
        ProfileId: candidate.profileId,
        IsActive: true,
        FederationIdentifier: `alv-devhub:${state.owner}`
      };
      let result;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (users.some(existing => existing.Username === state.username)) {
          state.username = `apex-log-viewer-ci+${randomUUID()}@electivus.com`;
          await saveState(directory, state);
        }
        fields.Username = state.username;
        try {
          result = await sf([
            'data',
            'create',
            'record',
            '--target-org',
            values['target-org'],
            '--sobject',
            'User',
            '--values',
            sfValues(fields)
          ]);
          break;
        } catch (error) {
          if (error.code !== 'DUPLICATE_USERNAME') throw error;
          state.username = `apex-log-viewer-ci+${randomUUID()}@electivus.com`;
          state.usernameCollisions = (state.usernameCollisions || 0) + 1;
          await saveState(directory, state);
        }
      }
      if (!result)
        throw new Error(
          'Username collisions exhausted the bounded attempts; a unique candidate is saved for recovery.'
        );
      if (!result.success || !result.id)
        throw new Error('User create was not confirmed; rerun to reconcile the ownership marker.');
      user = { Id: result.id, ...fields };
      state.userId = result.id;
      await saveState(directory, state);
    }
    if (!state.userId) {
      state.userId = user.Id;
      await saveState(directory, state);
    }
    if (state.license === 'integration') {
      const assignments = await query(
        `SELECT Id, PermissionSetLicenseId FROM PermissionSetLicenseAssign WHERE AssigneeId = '${soqlLiteral(user.Id)}'`
      );
      if (!assignments.some(assignment => assignment.PermissionSetLicenseId === candidate.permissionSetLicenseId)) {
        if (!(candidate.permissionSetLicenseAvailable > 0))
          throw new Error('Integration permission set license capacity is exhausted.');
        const result = await sf([
          'data',
          'create',
          'record',
          '--target-org',
          values['target-org'],
          '--sobject',
          'PermissionSetLicenseAssign',
          '--values',
          sfValues({ AssigneeId: user.Id, PermissionSetLicenseId: candidate.permissionSetLicenseId })
        ]);
        if (!result.success || !result.id)
          throw new Error('Permission set license assignment was not confirmed; rerun to reconcile.');
        state.permissionSetLicenseAssignmentId = result.id;
        await saveState(directory, state);
      }
    }
    return {
      status: 'user-ready',
      user,
      license: state.license,
      profile: candidate.profile,
      permissionSetLicenseId: candidate.permissionSetLicenseId,
      stateDirectory: directory
    };
  } finally {
    await lock.close();
    await fs.unlink(path.join(directory, 'operation.lock'));
  }
}

module.exports = { main };
if (require.main === module) {
  main()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
