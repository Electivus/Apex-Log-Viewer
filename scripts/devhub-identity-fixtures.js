const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { X509Certificate, createPrivateKey } = require('node:crypto');
const { main } = require('./devhub-identity');
const { ADMINISTRATIVE_PERMISSIONS } = require('./devhub-identity-permissions');

const baseArgs = ['inspect', '--target-org', 'Bootstrap', '--expected-org-id', '00D000000000001AAA'];

async function rotationFixture(t) {
  const prepared = await preparedAppFixture(t, 'permanent');
  const { fixture, directory } = prepared;
  const state = JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8'));
  addRuntimeAssignment(fixture, state);
  writeFileSync(path.join(directory, 'identity.json'), JSON.stringify(state));
  const replacement = await temporaryCertificate(t);
  const changes = { app: 0, store: 0, logins: 0 };
  const invoke = fixture.sf;
  fixture.sf = async (args, options) => {
    if (args[0] === 'org' && args[1] === 'list') return { nonScratchOrgs: [], scratchOrgs: [] };
    if (args[0] === 'org' && args[1] === 'login') {
      assert.equal(args[2], 'jwt', 'No refresh-token or alias fallback');
      const home = options.env.USERPROFILE;
      assert.equal(existsSync(path.join(home, '.sf')), false, 'Each authentication starts from empty CLI state');
      assert.equal(
        new X509Certificate(readFileSync(fixture.activeCertificateFile)).checkPrivateKey(
          createPrivateKey(readFileSync(args[args.indexOf('--jwt-key-file') + 1]))
        ),
        true
      );
      mkdirSync(path.join(home, '.sf'));
      changes.logins += 1;
      return { username: state.username, orgId: state.org };
    }
    if (args[0] === 'data' && options?.env?.SF_STATE_FOLDER === '.sf') {
      return { records: [{ Id: state.userId, Username: state.username }], done: true, totalSize: 1 };
    }
    if (args[0] === 'project' && args[1] === 'deploy' && !args.includes('--dry-run')) {
      const file = path.join(
        options.cwd,
        'force-app',
        'main',
        'default',
        'extlClntAppGlobalOauthSets',
        `${state.apps.permanent.name}_global.ecaGlblOauth-meta.xml`
      );
      const { xmlValue } = require('./devhub-identity-app');
      const certificateFile = path.join(directory, `live-${changes.app}.pem`);
      writeFileSync(certificateFile, xmlValue(readFileSync(file, 'utf8'), 'certificate'));
      fixture.activeCertificateFile = certificateFile;
      changes.app += 1;
      return { success: true, status: 'Succeeded', checkOnly: false, id: `rotation-deploy-${changes.app}` };
    }
    return invoke(args, options);
  };
  fixture.gh = async (args, options) => {
    if (args[1] === 'list')
      return ['CLIENT_ID', 'USERNAME', 'LOGIN_URL', 'PRIVATE_KEY'].map(name => ({
        name: `SF_DEVHUB_${name}`,
        updatedAt: '2026-09-07T12:00:00Z'
      }));
    assert.deepEqual(args, [
      'secret',
      'set',
      'SF_DEVHUB_PRIVATE_KEY',
      '--repo',
      'Electivus/Apex-Log-Viewer',
      '--app',
      'actions'
    ]);
    assert.equal(
      new X509Certificate(readFileSync(fixture.activeCertificateFile)).checkPrivateKey(createPrivateKey(options.input)),
      true
    );
    changes.store += 1;
  };
  const prepareArgs = [
    'prepare-rotation',
    ...baseArgs.slice(1),
    '--state-dir',
    directory,
    '--credential-mode',
    'permanent',
    '--certificate-days',
    '2',
    '--storage-policy',
    'github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY',
    '--policy-reference',
    'fixture-rotation-approval',
    '--expected-fingerprint',
    state.apps.permanent.fingerprint,
    '--certificate-file',
    replacement.certificateFile,
    '--private-key-file',
    replacement.privateKeyFile
  ];
  return {
    ...prepared,
    changes,
    prepareArgs,
    state,
    replacement,
    read: () => JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8'))
  };
}

function discoveryFixture() {
  const records = {
    Organization: [{ Id: '00D000000000001AAA', IsSandbox: false }],
    UserLicense: [
      { Id: '100integration', Name: 'Salesforce Integration', TotalLicenses: 5, UsedLicenses: 0 },
      { Id: '100salesforce', Name: 'Salesforce', TotalLicenses: 10, UsedLicenses: 2 }
    ],
    Profile: [
      {
        Id: '00eintegration',
        Name: 'Minimum Access - API Only Integrations',
        UserLicenseId: '100integration',
        PermissionsApiEnabled: true,
        PermissionsApiUserOnly: true,
        PermissionsModifyAllData: false,
        PermissionsModifyMetadata: false,
        PermissionsManageUsers: false
      },
      {
        Id: '00esalesforce',
        Name: 'Minimum Access - Salesforce',
        UserLicenseId: '100salesforce',
        PermissionsApiEnabled: false,
        PermissionsApiUserOnly: false,
        PermissionsModifyAllData: false,
        PermissionsModifyMetadata: false,
        PermissionsManageUsers: false
      }
    ],
    PermissionSetLicense: [
      {
        Id: '0PLintegration',
        DeveloperName: 'SalesforceAPIIntegrationPsl',
        MasterLabel: 'Salesforce API Integration',
        TotalLicenses: 5,
        UsedLicenses: 0
      }
    ],
    User: [],
    ExternalClientApplication: [],
    PermissionSet: [],
    ActiveScratchOrg: [{ Id: 'other-scratch', OwnerId: 'other-user', ScratchOrgInfoId: 'other-signup' }],
    ALV_ScratchOrgPool__c: [
      { Id: 'shared-pool', PoolKey__c: 'production', ProvisioningMode__c: 'snapshot', TargetSize__c: 2 }
    ]
  };
  for (const profile of records.Profile) {
    Object.assign(profile, {
      PermissionsCustomizeApplication: false,
      PermissionsAuthorApex: false,
      PermissionsManageProfilesPermissionsets: false,
      PermissionsManageRoles: false,
      PermissionsViewAllData: false
    });
  }
  const sf = async args => {
    assert.equal(args[0], 'data');
    assert.equal(args[1], 'query', 'inspect must remain read-only');
    const soql = args[args.indexOf('--query') + 1];
    const object = soql.match(/ FROM (\w+)/)[1];
    assert.ok(records[object], `Unrecognized Salesforce query: ${object}`);
    let result = records[object];
    const namedPermission = object === 'PermissionSet' && soql.match(/WHERE Name = '([^']+)'/);
    if (namedPermission) result = result.filter(item => item.Name === namedPermission[1]);
    const profilePermission = object === 'PermissionSet' && soql.match(/WHERE ProfileId = '([^']+)'/);
    if (profilePermission) result = result.filter(item => item.ProfileId === profilePermission[1]);
    const assignedSet = object === 'PermissionSetAssignment' && soql.match(/WHERE PermissionSetId = '([^']+)'/);
    if (assignedSet) result = result.filter(item => item.PermissionSetId === assignedSet[1]);
    if (object === 'PermissionSetAssignment' && soql.includes('PermissionSet.')) {
      result = result.map(item => ({
        ...item,
        PermissionSet: item.PermissionSet || records.PermissionSet.find(set => set.Id === item.PermissionSetId)
      }));
    }
    return { records: result, done: true, totalSize: result.length };
  };
  return { records, sf };
}

function stateDirectory(t) {
  const directory = mkdtempSync(path.join(homedir(), 'alv-identity-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function provisioningFixture() {
  const fixture = discoveryFixture();
  fixture.records.PermissionSetLicenseAssign = [];
  const read = fixture.sf;
  const created = [];
  fixture.sf = async args => {
    if (args[0] === 'data' && args[1] === 'query') return read(args);
    assert.equal(args.slice(0, 3).join(' '), 'data create record');
    const object = args[args.indexOf('--sobject') + 1];
    const fields = Object.fromEntries(
      require('shell-quote')
        .parse(args[args.indexOf('--values') + 1])
        .map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)])
    );
    const id = object === 'User' ? '005runtime' : '2LApsl';
    const record = { Id: id, ...fields };
    if (object === 'PermissionSetAssignment') record.PermissionSetGroupId = null;
    if (object === 'User') record.IsActive = fields.IsActive === 'true';
    fixture.records[object].push(record);
    created.push({ object, record });
    return { id, success: true };
  };
  return { ...fixture, created };
}

async function temporaryCertificate(t) {
  const directory = stateDirectory(t);
  const openssl = [
    'openssl',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'openssl.exe'),
    path.join(process.env.ProgramFiles || '', 'Git', 'usr', 'bin', 'openssl.exe')
  ].find(
    candidate =>
      require('cross-spawn').sync(candidate, ['version'], { encoding: 'utf8', windowsHide: true }).status === 0
  );
  assert.ok(openssl, 'OpenSSL is required for certificate interoperability tests; provide it through PATH.');
  return main(
    [
      'create-certificate',
      '--state-dir',
      directory,
      '--credential-mode',
      'temporary',
      '--certificate-days',
      '2',
      '--storage-policy',
      'temporary-local',
      '--openssl',
      openssl
    ],
    { sf: async () => assert.fail('Certificate generation is local') }
  );
}

async function preparedAppFixture(t, mode = 'temporary') {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  const certificate = await temporaryCertificate(t);
  fixture.activeCertificateFile = certificate.certificateFile;
  fixture.records.PermissionSetAssignment = [];
  fixture.permissionFields = ['PermissionsApiEnabled', ...ADMINISTRATIVE_PERMISSIONS];
  fixture.permissionChildren = [
    ['ObjectPermissions', 'ParentId'],
    ['FieldPermissions', 'ParentId'],
    ['SetupEntityAccess', 'ParentId'],
    ['PermissionSetTabSetting', 'ParentId'],
    ['PermissionSetGroupComponent', 'PermissionSetId'],
    ['PermissionSetAssignment', 'PermissionSetId'],
    ['SessionPermSetActivation', 'PermissionSetId']
  ];
  for (const [object] of fixture.permissionChildren) fixture.records[object] ||= [];
  const invoke = fixture.sf;
  const validated = new Set();
  let deployments = 0;
  fixture.sf = async (args, options) => {
    if (args[0] === 'sobject' && args[1] === 'describe') {
      assert.equal(args[args.indexOf('--sobject') + 1], 'PermissionSet');
      return {
        fields: fixture.permissionFields.map(name => ({ name, type: 'boolean' })),
        childRelationships: fixture.permissionChildren.map(([childSObject, field]) => ({ childSObject, field }))
      };
    }
    if (args[0] !== 'project') return invoke(args);
    const app = fixture.observedApp || JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8')).apps[mode];
    if (args[1] === 'deploy') {
      if (args.includes('--dry-run')) {
        validated.add(options.cwd);
        return { success: true, status: 'Succeeded', checkOnly: true, id: '0Afcheck' };
      }
      assert.ok(validated.has(options.cwd), 'Every deployed stage must have passed validation');
      deployments += 1;
      if (path.basename(options.cwd) === 'base') {
        fixture.records.ExternalClientApplication.push({
          Id: '0xIruntime',
          DeveloperName: app.name,
          Description: app.marker,
          ContactEmail: 'apex-log-viewer-ci@electivus.com'
        });
        fixture.records.PermissionSet.push({
          Id: '0PSaccess',
          Name: app.preauthorization,
          Description: app.marker,
          IsOwnedByProfile: false,
          HasActivationRequired: false,
          LicenseId: null,
          Type: 'Regular',
          ...Object.fromEntries(fixture.permissionFields.map(name => [name, false]))
        });
      }
      if (path.basename(options.cwd) === 'policy') {
        fixture.records.SetupEntityAccess = [{ SetupEntityId: app.id, SetupEntityType: 'ExternalClientApplication' }];
      }
      return { success: true, status: 'Succeeded', checkOnly: false, id: '0Afdeploy' };
    }
    assert.equal(args[1], 'retrieve');
    const project = JSON.parse(readFileSync(path.join(options.cwd, 'sfdx-project.json'), 'utf8'));
    for (const entry of project.packageDirectories) {
      assert.ok(
        existsSync(path.join(options.cwd, entry.path)),
        'Salesforce CLI requires every package directory before retrieval'
      );
    }
    const files = {
      [`extlClntAppGlobalOauthSets/${app.name}_global.ecaGlblOauth-meta.xml`]: `<ExtlClntAppGlobalOauthSettings><consumerKey>fixture-client-key</consumerKey><consumerSecret>fixture-consumer-secret</consumerSecret><certificate>${readFileSync(fixture.activeCertificateFile, 'utf8')}</certificate><callbackUrl>http://localhost:1717/OauthRedirect</callbackUrl><isConsumerSecretOptional>false</isConsumerSecretOptional><isIntrospectAllTokens>false</isIntrospectAllTokens><isPkceRequired>true</isPkceRequired><isSecretRequiredForRefreshToken>true</isSecretRequiredForRefreshToken><shouldRotateConsumerKey>false</shouldRotateConsumerKey><shouldRotateConsumerSecret>false</shouldRotateConsumerSecret></ExtlClntAppGlobalOauthSettings>`,
      [`extlClntAppOauthSettings/${app.name}_oauth.ecaOauth-meta.xml`]:
        '<ExtlClntAppOauthSettings><commaSeparatedOauthScopes>Api,RefreshToken</commaSeparatedOauthScopes></ExtlClntAppOauthSettings>',
      [`extlClntAppOauthPolicies/${app.name}_oauthPlcy.ecaOauthPlcy-meta.xml`]: `<ExtlClntAppOauthConfigurablePolicies><commaSeparatedPermissionSet>${app.preauthorization}</commaSeparatedPermissionSet><ipRelaxationPolicyType>Enforce</ipRelaxationPolicyType><permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType><refreshTokenPolicyType>Zero</refreshTokenPolicyType><sessionTimeoutInMinutes>15</sessionTimeoutInMinutes><isClientCredentialsFlowEnabled>false</isClientCredentialsFlowEnabled><isGuestCodeCredFlowEnabled>false</isGuestCodeCredFlowEnabled><isTokenExchangeFlowEnabled>false</isTokenExchangeFlowEnabled></ExtlClntAppOauthConfigurablePolicies>`,
      [`extlClntAppPolicies/${app.name}_plcy.ecaPlcy-meta.xml`]:
        '<ExtlClntAppConfigurablePolicies><isEnabled>true</isEnabled><isOauthPluginEnabled>true</isOauthPluginEnabled></ExtlClntAppConfigurablePolicies>'
    };
    for (const [relative, body] of Object.entries(files)) {
      const file = path.join(options.cwd, 'force-app', 'main', 'default', relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
    return { success: true, status: 'Succeeded' };
  };
  const args = [
    'provision-app',
    ...baseArgs.slice(1),
    '--state-dir',
    directory,
    '--credential-mode',
    mode,
    '--certificate-days',
    '2',
    '--storage-policy',
    mode === 'temporary' ? 'temporary-local' : 'github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY',
    ...(mode === 'permanent' ? ['--policy-reference', 'fixture-operator-approval'] : []),
    '--certificate-file',
    certificate.certificateFile,
    '--private-key-file',
    certificate.privateKeyFile
  ];
  const first = await main(args, fixture);
  return { fixture, directory, args, first, deployments: () => deployments };
}

function addRuntimeAssignment(fixture, state) {
  const permission = {
    Id: '0PSruntime',
    Name: 'ALV_ScratchOrgPoolService',
    IsOwnedByProfile: false,
    Type: 'Regular',
    NamespacePrefix: null,
    ...Object.fromEntries(ADMINISTRATIVE_PERMISSIONS.map(name => [name, false]))
  };
  fixture.records.PermissionSet.push(permission);
  fixture.records.PermissionSetAssignment.push({
    Id: 'runtime-assignment',
    AssigneeId: '005runtime',
    PermissionSetId: permission.Id,
    PermissionSetGroupId: null
  });
  state.runtime = { permissionSetId: permission.Id };
  state.runtimeAssignmentId = 'runtime-assignment';
  addRuntimeGrantInventory(fixture);
  return permission;
}

function addRuntimeGrantInventory(fixture) {
  if (fixture.runtimeGrants) return fixture.runtimeGrants;
  fixture.permissionFields ||= ['PermissionsApiEnabled', ...ADMINISTRATIVE_PERMISSIONS];
  fixture.permissionChildren ||= [
    ['ObjectPermissions', 'ParentId'],
    ['FieldPermissions', 'ParentId'],
    ['SetupEntityAccess', 'ParentId'],
    ['PermissionSetTabSetting', 'ParentId'],
    ['PermissionSetGroupComponent', 'PermissionSetId'],
    ['PermissionSetAssignment', 'PermissionSetId'],
    ['SessionPermSetActivation', 'PermissionSetId']
  ];
  const permission = fixture.records.PermissionSet.find(item => item.Id === '0PSruntime');
  Object.assign(permission, {
    HasActivationRequired: false,
    LicenseId: null,
    ...Object.fromEntries(fixture.permissionFields.map(name => [name, name === 'PermissionsApiEnabled']))
  });
  const { xmlValue } = require('./devhub-identity-app');
  const source = readFileSync(
    path.join(
      __dirname,
      '..',
      'force-app',
      'main',
      'default',
      'permissionsets',
      'ALV_ScratchOrgPoolService.permissionset-meta.xml'
    ),
    'utf8'
  );
  const permissionNames = {
    allowRead: 'PermissionsRead',
    allowCreate: 'PermissionsCreate',
    allowEdit: 'PermissionsEdit',
    allowDelete: 'PermissionsDelete',
    viewAllRecords: 'PermissionsViewAllRecords',
    modifyAllRecords: 'PermissionsModifyAllRecords'
  };
  const objects = [...source.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/g)].map(([, body]) => ({
    ParentId: '0PSruntime',
    SobjectType: xmlValue(body, 'object'),
    PermissionsViewAllFields: false,
    ...Object.fromEntries(Object.entries(permissionNames).map(([xml, api]) => [api, xmlValue(body, xml) === 'true']))
  }));
  const fields = [...source.matchAll(/<fieldPermissions>([\s\S]*?)<\/fieldPermissions>/g)].map(([, body]) => ({
    ParentId: '0PSruntime',
    Field: xmlValue(body, 'field'),
    PermissionsRead: true,
    PermissionsEdit: true
  }));
  fixture.records.ApexClass = [
    { Id: 'rest-class', Name: 'ALVScratchPoolRest', NamespacePrefix: null },
    { Id: 'service-class', Name: 'ALVScratchPoolService', NamespacePrefix: null }
  ];
  fixture.runtimeGrants = {
    ObjectPermissions: objects,
    FieldPermissions: fields,
    SetupEntityAccess: fixture.records.ApexClass.map(item => ({
      ParentId: '0PSruntime',
      SetupEntityId: item.Id,
      SetupEntityType: 'ApexClass'
    }))
  };
  const invoke = fixture.sf;
  fixture.sf = async (args, options) => {
    if (args[0] === 'sobject' && args[1] === 'describe') {
      const object = args[args.indexOf('--sobject') + 1];
      if (object === 'PermissionSet')
        return {
          fields: fixture.permissionFields.map(name => ({ name, type: 'boolean' })),
          childRelationships: fixture.permissionChildren.map(([childSObject, field]) => ({ childSObject, field }))
        };
      return {
        fields: (object === 'ObjectPermissions'
          ? [...Object.values(permissionNames), 'PermissionsViewAllFields']
          : ['PermissionsRead', 'PermissionsEdit']
        ).map(name => ({ name, type: 'boolean' }))
      };
    }
    if (args[0] === 'project' && args[1] === 'deploy' && path.basename(options.cwd) === 'runtime-permissions')
      return { success: true, status: 'Succeeded', checkOnly: args.includes('--dry-run'), id: '0Afpermissions' };
    const soql = args.includes('--query') ? args[args.indexOf('--query') + 1] : '';
    if (
      /WHERE (?:ParentId|PermissionSetId) = '0PSruntime'/.test(soql) &&
      !soql.includes('FROM PermissionSetAssignment')
    ) {
      const object = soql.match(/ FROM (\w+)/)[1];
      return {
        records: fixture.runtimeGrants[object] || [],
        done: true,
        totalSize: (fixture.runtimeGrants[object] || []).length
      };
    }
    return invoke(args, options);
  };
  return fixture.runtimeGrants;
}

module.exports = {
  baseArgs,
  rotationFixture,
  discoveryFixture,
  stateDirectory,
  provisioningFixture,
  temporaryCertificate,
  preparedAppFixture,
  addRuntimeAssignment,
  addRuntimeGrantInventory
};
