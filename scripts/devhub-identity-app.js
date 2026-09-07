'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { lifecycleInputs, readCertificate, secureDirectory } = require('./devhub-identity-credentials');

const GLOBAL_OAUTH_CONTROLS = Object.freeze({
  callbackUrl: 'http://localhost:1717/OauthRedirect',
  isConsumerSecretOptional: false,
  isIntrospectAllTokens: false,
  isPkceRequired: true,
  isSecretRequiredForRefreshToken: true,
  shouldRotateConsumerKey: false,
  shouldRotateConsumerSecret: false
});

function xml(type, fields) {
  const escape = value =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="http://soap.sforce.com/2006/04/metadata">\n${Object.entries(
    fields
  )
    .map(([key, value]) => `    <${key}>${escape(value)}</${key}>`)
    .join('\n')}\n</${type}>\n`;
}

async function metadataProject(directory, files) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await secureDirectory(directory);
  await fs.mkdir(path.join(directory, 'force-app'), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(directory, 'sfdx-project.json'),
    JSON.stringify({
      packageDirectories: [{ path: 'force-app', default: true }],
      sourceApiVersion: '67.0'
    }),
    { mode: 0o600 }
  );
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(directory, 'force-app', 'main', 'default', relative);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, body, { mode: 0o600 });
  }
}

async function validatedDeploy(sf, target, directory) {
  const args = ['project', 'deploy', 'start', '--target-org', target, '--source-dir', 'force-app', '--wait', '30'];
  const check = await sf([...args, '--dry-run'], { cwd: directory });
  if (check.success !== true || check.status !== 'Succeeded' || check.checkOnly !== true) {
    throw new Error('Metadata validation failed; no deployment was attempted.');
  }
  const result = await sf(args, { cwd: directory });
  if (result.success !== true || result.status !== 'Succeeded' || result.checkOnly === true) {
    throw new Error('Metadata deployment was not confirmed; preserve state and reconcile the org.');
  }
  return { validationId: check.id, deploymentId: result.id };
}

function xmlValue(body, name) {
  const values = [...body.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))];
  if (values.length > 1) throw new Error('Retrieved metadata contains duplicate policy fields.');
  return (values[0]?.[1] || '')
    .trim()
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

async function verifyApp(sf, target, root, app) {
  await metadataProject(root, {});
  const retrieved = await sf(
    [
      'project',
      'retrieve',
      'start',
      '--target-org',
      target,
      '--wait',
      '10',
      '--metadata',
      `ExtlClntAppGlobalOauthSettings:${app.name}_global`,
      '--metadata',
      `ExtlClntAppOauthSettings:${app.name}_oauth`,
      '--metadata',
      `ExtlClntAppOauthConfigurablePolicies:${app.name}_oauthPlcy`,
      '--metadata',
      `ExtlClntAppConfigurablePolicies:${app.name}_plcy`
    ],
    { cwd: root }
  );
  if (retrieved.success !== true) throw new Error('App metadata retrieval failed; active policy is unverified.');
  const read = relative => fs.readFile(path.join(root, 'force-app', 'main', 'default', relative), 'utf8');
  const global = await read(`extlClntAppGlobalOauthSets/${app.name}_global.ecaGlblOauth-meta.xml`);
  const oauth = await read(`extlClntAppOauthSettings/${app.name}_oauth.ecaOauth-meta.xml`);
  const policy = await read(`extlClntAppOauthPolicies/${app.name}_oauthPlcy.ecaOauthPlcy-meta.xml`);
  const configuration = await read(`extlClntAppPolicies/${app.name}_plcy.ecaPlcy-meta.xml`);
  if (
    Object.entries(GLOBAL_OAUTH_CONTROLS).some(([field, value]) => xmlValue(global, field) !== String(value)) ||
    xmlValue(oauth, 'commaSeparatedOauthScopes')
      .split(',')
      .map(value => value.trim())
      .sort()
      .join(',') !== 'Api,RefreshToken' ||
    xmlValue(policy, 'commaSeparatedPermissionSet') !== app.preauthorization ||
    xmlValue(policy, 'commaSeparatedProfile') ||
    xmlValue(policy, 'ipRelaxationPolicyType') !== 'Enforce' ||
    xmlValue(policy, 'permittedUsersPolicyType') !== 'AdminApprovedPreAuthorized' ||
    xmlValue(policy, 'refreshTokenPolicyType') !== 'Zero' ||
    xmlValue(policy, 'sessionTimeoutInMinutes') !== '15' ||
    ['isClientCredentialsFlowEnabled', 'isGuestCodeCredFlowEnabled', 'isTokenExchangeFlowEnabled'].some(
      field => xmlValue(policy, field) !== 'false'
    ) ||
    xmlValue(configuration, 'isEnabled') !== 'true' ||
    xmlValue(configuration, 'isOauthPluginEnabled') !== 'true'
  ) {
    throw new Error(
      'Effective ECA scopes, preauthorization, OAuth flows, IP or token/session policy differs from the intended policy.'
    );
  }
  let certificate;
  try {
    const material = xmlValue(global, 'certificate');
    certificate = new X509Certificate(
      material.includes('BEGIN CERTIFICATE') ? material : Buffer.from(material, 'base64')
    );
  } catch {
    throw new Error('Cannot verify the active ECA certificate; metadata contents withheld.');
  }
  if (certificate.fingerprint256 !== app.fingerprint)
    throw new Error('The active ECA certificate differs from the owned certificate.');
  const clientId = xmlValue(global, 'consumerKey');
  if (!/^[a-zA-Z0-9._-]{12,512}$/.test(clientId) || /redact|placeholder/i.test(clientId)) {
    throw new Error('Salesforce did not return a usable ECA consumer key; metadata contents withheld.');
  }
  return clientId;
}

async function verifyPreauthorization(sf, target, query, app) {
  const description = await sf(['sobject', 'describe', '--target-org', target, '--sobject', 'PermissionSet']);
  const identifier = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(value);
  const permissionFields = description.fields?.filter(field => field.name?.startsWith('Permissions'));
  const children = description.childRelationships;
  if (
    !permissionFields?.length ||
    permissionFields.some(field => !identifier(field.name) || field.type !== 'boolean') ||
    !Array.isArray(children) ||
    children.some(child => !identifier(child.childSObject) || !identifier(child.field)) ||
    ['ObjectPermissions', 'FieldPermissions', 'SetupEntityAccess'].some(
      object => !children.some(child => child.childSObject === object && child.field === 'ParentId')
    )
  )
    throw new Error('Cannot verify the complete preauthorization grant inventory.');
  const permissions = await query(
    `SELECT FIELDS(ALL) FROM PermissionSet WHERE Name = '${app.preauthorization}' LIMIT 2`
  );
  const permission = permissions[0];
  if (
    permissions.length !== 1 ||
    permission.Name !== app.preauthorization ||
    permission.Description !== app.marker ||
    permission.IsOwnedByProfile !== false ||
    permission.HasActivationRequired !== false ||
    permission.LicenseId !== null ||
    permission.Type !== 'Regular' ||
    permissionFields.some(field => permission[field.name] !== false)
  )
    throw new Error('Owned preauthorization permission set has unexpected or unverified grants.');
  // These relations describe recipients/sessions, not grants within the set.
  // Every other described relationship must be empty except the owned ECA binding.
  for (const child of children) {
    if (['PermissionSetAssignment', 'SessionPermSetActivation'].includes(child.childSObject)) continue;
    const binding = child.childSObject === 'SetupEntityAccess';
    const records = await query(
      `SELECT ${binding ? 'SetupEntityId, SetupEntityType' : 'Id'} FROM ${child.childSObject} WHERE ${child.field} = '${permission.Id}' LIMIT ${binding ? 2 : 1}`
    );
    if (
      binding
        ? records.length !== 1 ||
          records[0].SetupEntityId !== app.id ||
          records[0].SetupEntityType !== 'ExternalClientApplication'
        : records.length !== 0
    )
      throw new Error(`Preauthorization grant differs in ${child.childSObject}; no grants will be changed.`);
  }
  return permission.Id;
}

async function provisionApp({ values, state, inventory, directory, user, query, sf, save }) {
  const lifecycle = lifecycleInputs(values, true);
  const name = `ALV_DevHub_${state.owner.replaceAll('-', '').slice(0, 16)}_${lifecycle.mode === 'temporary' ? 'Test' : 'CI'}`;
  const marker = `alv-devhub:${state.owner}:${lifecycle.mode}`;
  const existing = inventory.apps.filter(app => app.DeveloperName === name);
  const recorded = state.apps?.[lifecycle.mode];
  if (
    existing.length > 1 ||
    (existing.length &&
      (!recorded ||
        existing[0].Description !== marker ||
        existing[0].ContactEmail !== state.contact ||
        (recorded.id && recorded.id !== existing[0].Id))) ||
    (recorded?.id && !existing.length)
  ) {
    throw new Error('App ownership conflict; no existing app will be adopted or overwritten.');
  }
  const certificate = await readCertificate(values['certificate-file'], values['private-key-file'], lifecycle);
  if (
    recorded &&
    (recorded.fingerprint !== certificate.fingerprint ||
      JSON.stringify(recorded.lifecycle) !== JSON.stringify(lifecycle) ||
      recorded.revoked)
  ) {
    throw new Error(
      'The recorded app certificate/lifecycle differs or the app was revoked; do not overwrite or reactivate it.'
    );
  }
  const preauthorization = `${name}_Access`;
  const existingPermissions = inventory.permissionSets.filter(item => item.Name === preauthorization);
  if (
    existingPermissions.length &&
    (!recorded ||
      existingPermissions.length !== 1 ||
      existingPermissions[0].Description !== marker ||
      existingPermissions[0].IsOwnedByProfile !== false)
  ) {
    throw new Error('Preauthorization permission set ownership conflict; no mutation is allowed.');
  }
  state.apps ||= {};
  const app = (state.apps[lifecycle.mode] ||= {
    name,
    marker,
    preauthorization,
    lifecycle,
    fingerprint: certificate.fingerprint,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    privateKeyFile: path.resolve(values['private-key-file']),
    certificateFile: path.resolve(values['certificate-file'])
  });
  await save();
  const baseDirectory = path.join(directory, `app-${lifecycle.mode}`, 'base');
  await metadataProject(baseDirectory, {
    [`externalClientApps/${name}.eca-meta.xml`]: xml('ExternalClientApplication', {
      contactEmail: state.contact,
      description: marker,
      distributionState: 'Local',
      isProtected: false,
      label: name
    }),
    [`permissionsets/${preauthorization}.permissionset-meta.xml`]: xml('PermissionSet', {
      description: marker,
      hasActivationRequired: false,
      label: preauthorization
    })
  });
  if (!existing.length) {
    app.baseDeployment = await validatedDeploy(sf, values['target-org'], baseDirectory);
    const deployed = await query(
      `SELECT Id, DeveloperName, Description, ContactEmail FROM ExternalClientApplication WHERE DeveloperName = '${name}'`,
      true
    );
    if (deployed.length !== 1 || deployed[0].Description !== marker || deployed[0].ContactEmail !== state.contact) {
      throw new Error('Created app ownership could not be verified; preserve state for recovery.');
    }
    app.id = deployed[0].Id;
    await save();
  }
  if (!app.id) {
    app.id = existing[0]?.Id;
    await save();
  }
  const configFields = enabled => ({
    externalClientApplication: name,
    isEnabled: enabled,
    isOauthPluginEnabled: true,
    label: `${name} Policies`,
    startPage: 'None'
  });
  if (!app.configured) {
    const oauthDirectory = path.join(directory, `app-${lifecycle.mode}`, 'oauth');
    await metadataProject(oauthDirectory, {
      [`extlClntAppGlobalOauthSets/${name}_global.ecaGlblOauth-meta.xml`]: xml('ExtlClntAppGlobalOauthSettings', {
        ...GLOBAL_OAUTH_CONTROLS,
        certificate: certificate.pem,
        externalClientApplication: name,
        label: `${name} Global OAuth`
      }),
      [`extlClntAppOauthSettings/${name}_oauth.ecaOauth-meta.xml`]: xml('ExtlClntAppOauthSettings', {
        commaSeparatedOauthScopes: 'Api,RefreshToken',
        externalClientApplication: name,
        label: `${name} OAuth`
      }),
      [`extlClntAppPolicies/${name}_plcy.ecaPlcy-meta.xml`]: xml('ExtlClntAppConfigurablePolicies', configFields(false))
    });
    app.oauthDeployment = await validatedDeploy(sf, values['target-org'], oauthDirectory);
    await save();
    const policyDirectory = path.join(directory, `app-${lifecycle.mode}`, 'policy');
    await metadataProject(policyDirectory, {
      [`extlClntAppOauthPolicies/${name}_oauthPlcy.ecaOauthPlcy-meta.xml`]: xml(
        'ExtlClntAppOauthConfigurablePolicies',
        {
          commaSeparatedPermissionSet: preauthorization,
          externalClientApplication: name,
          ipRelaxationPolicyType: 'Enforce',
          isClientCredentialsFlowEnabled: false,
          isGuestCodeCredFlowEnabled: false,
          isTokenExchangeFlowEnabled: false,
          label: `${name} OAuth Policies`,
          permittedUsersPolicyType: 'AdminApprovedPreAuthorized',
          refreshTokenPolicyType: 'Zero',
          sessionTimeoutInMinutes: 15
        }
      ),
      [`extlClntAppPolicies/${name}_plcy.ecaPlcy-meta.xml`]: xml('ExtlClntAppConfigurablePolicies', configFields(true))
    });
    app.policyDeployment = await validatedDeploy(sf, values['target-org'], policyDirectory);
    await save();
  }
  const privateDirectory = path.join(directory, `app-${lifecycle.mode}`, 'retrieved');
  const clientId = await verifyApp(sf, values['target-org'], privateDirectory, app);
  const permissionSetId = await verifyPreauthorization(sf, values['target-org'], query, app);
  const assignments = await query(
    `SELECT Id, AssigneeId, PermissionSetId FROM PermissionSetAssignment WHERE PermissionSetId = '${permissionSetId}'`
  );
  if (assignments.some(assignment => assignment.AssigneeId !== user.Id)) {
    throw new Error(
      'Unexpected assignee on the dedicated preauthorization permission set; no assignments will be changed.'
    );
  }
  if (!assignments.length) {
    const assigned = await sf([
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
    if (!assigned.success || !assigned.id)
      throw new Error('Preauthorization assignment is unconfirmed; rerun to reconcile.');
    app.assignmentId = assigned.id;
  } else {
    app.assignmentId = assignments[0].Id;
  }
  const inputsFile = path.join(privateDirectory, 'jwt-inputs.json');
  await fs.writeFile(
    inputsFile,
    JSON.stringify({
      clientId,
      username: user.Username,
      privateKeyFile: app.privateKeyFile,
      loginUrl: 'https://login.salesforce.com'
    }),
    { mode: 0o600 }
  );
  app.inputsFile = inputsFile;
  app.configured = true;
  await save();
  return {
    status: 'app-ready',
    mode: lifecycle.mode,
    name,
    preauthorization,
    fingerprint: app.fingerprint,
    validTo: app.validTo,
    inputsFile,
    retainedSensitiveMetadataDirectory: privateDirectory
  };
}

module.exports = { provisionApp, xml, metadataProject, validatedDeploy, xmlValue, verifyApp };
